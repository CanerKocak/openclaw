import { CompactClient } from "@morphllm/morphsdk";
import type { CompactResult as MorphCompactResult } from "@morphllm/morphsdk";
import type {
  AgentMessage,
  AssembleResult,
  ContextEngine,
  OpenClawPluginApi,
} from "../../../src/plugin-sdk/morph.js";
import { LegacyContextEngine } from "../../../src/plugin-sdk/morph.js";
import { resolveMorphPluginConfig } from "./config.js";

type MorphCompactInputMessage = {
  role: string;
  content: string;
};

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isImageBlock(block: unknown): block is { type: "image"; mimeType?: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

function serializeUserContent(content: Extract<AgentMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (isTextBlock(block)) {
        return block.text;
      }
      if (isImageBlock(block)) {
        return `[Image: ${block.mimeType ?? "unknown"}]`;
      }
      return `[${String((block as { type?: unknown }).type ?? "unknown")}]`;
    })
    .join("\n");
}

function serializeAssistantContent(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "thinking") {
        return `[Thinking] ${block.thinking}`;
      }
      if (block.type === "toolCall") {
        const args = JSON.stringify(block.arguments).slice(0, 500);
        return `[Tool call: ${block.name}] ${args}`;
      }
      return `[${String((block as { type?: unknown }).type ?? "unknown")}]`;
    })
    .join("\n");
}

function serializeToolResultContent(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
  const text = message.content
    .map((block) => {
      if (isTextBlock(block)) {
        return block.text;
      }
      if (isImageBlock(block)) {
        return `[Image: ${block.mimeType ?? "unknown"}]`;
      }
      return `[${String((block as { type?: unknown }).type ?? "unknown")}]`;
    })
    .join("\n");

  return `[Tool result: ${message.toolName}] ${text}`.trim();
}

function serializeMessage(message: AgentMessage): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.role === "user") {
    return serializeUserContent(message.content);
  }

  if (message.role === "assistant") {
    return serializeAssistantContent(message);
  }

  if (message.role === "toolResult") {
    return serializeToolResultContent(message);
  }

  return "";
}

function estimateMessageChars(message: AgentMessage): number {
  if (!message || typeof message !== "object") {
    return 0;
  }

  if (message.role === "user") {
    return estimateUnknownChars(message.content);
  }

  if (message.role === "assistant") {
    return message.content.reduce((total, block) => {
      if (block.type === "text") {
        return total + block.text.length;
      }
      if (block.type === "thinking") {
        return total + block.thinking.length;
      }
      if (block.type === "toolCall") {
        return total + estimateUnknownChars(block.arguments);
      }
      return total + estimateUnknownChars(block);
    }, 0);
  }

  if (message.role === "toolResult") {
    return estimateUnknownChars(message.content) + estimateUnknownChars(message.details);
  }

  return estimateUnknownChars(message);
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageChars(message), 0);
}

function buildCacheKey(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      const timestamp =
        "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
      return `${message.role}:${timestamp}:${serializeMessage(message)}`;
    })
    .join("\u001f");
}

function toCompactInput(message: AgentMessage): MorphCompactInputMessage | null {
  const content = serializeMessage(message).trim();
  if (!content) {
    return null;
  }

  return {
    role: message.role,
    content,
  };
}

function buildCompactedMessage(
  templateMessage: AgentMessage,
  result: MorphCompactResult,
  compactedCount: number,
): AgentMessage {
  const timestamp =
    "timestamp" in templateMessage && typeof templateMessage.timestamp === "number"
      ? templateMessage.timestamp
      : Date.now();

  return {
    role: "user",
    timestamp,
    content: [
      {
        type: "text",
        text:
          `[Morph Compact: ${compactedCount} messages compressed, ` +
          `${Math.round(result.usage.compression_ratio * 100)}% kept]\n\n${result.output}`,
      },
    ],
  };
}

export class MorphContextEngine implements ContextEngine {
  readonly info = {
    id: "morph",
    name: "Morph Context Engine",
    version: "1.0.0",
  } as const;

  private readonly config;
  private readonly compactClient: CompactClient | null;
  private readonly legacy = new LegacyContextEngine();
  private compactCache: { key: string; result: MorphCompactResult } | null = null;

  constructor(private readonly api: OpenClawPluginApi) {
    this.config = resolveMorphPluginConfig(api.pluginConfig);
    this.compactClient = this.config.apiKey
      ? new CompactClient({
          morphApiKey: this.config.apiKey,
          morphApiUrl: this.config.baseUrl,
          timeout: this.config.compact.timeoutMs,
        })
      : null;
  }

  async ingest(params: Parameters<LegacyContextEngine["ingest"]>[0]) {
    return this.legacy.ingest(params);
  }

  async afterTurn(params: Parameters<NonNullable<LegacyContextEngine["afterTurn"]>>[0]) {
    return this.legacy.afterTurn?.(params);
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const base = await this.legacy.assemble(params);
    if (!this.config.compact.enabled || !this.compactClient) {
      return base;
    }

    const messages = base.messages;
    if (messages.length < this.config.compact.preserveRecent + 2) {
      return base;
    }

    if (estimateContextChars(messages) < this.config.compact.thresholdChars) {
      return base;
    }

    const olderMessages = messages.slice(0, -this.config.compact.preserveRecent);
    const recentMessages = messages.slice(-this.config.compact.preserveRecent);
    if (olderMessages.length === 0) {
      return base;
    }

    const cacheKey = buildCacheKey(olderMessages);
    if (this.compactCache?.key === cacheKey) {
      return {
        ...base,
        messages: [
          buildCompactedMessage(olderMessages[0]!, this.compactCache.result, olderMessages.length),
          ...recentMessages,
        ],
      };
    }

    const compactInput = olderMessages
      .map(toCompactInput)
      .filter((value): value is MorphCompactInputMessage => Boolean(value));
    if (compactInput.length === 0) {
      return base;
    }

    try {
      const result = await this.compactClient.compact({
        messages: compactInput,
        compressionRatio: this.config.compact.compressionRatio,
        preserveRecent: 0,
        model: this.config.compact.model,
      });

      this.compactCache = { key: cacheKey, result };
      this.api.logger.info?.(
        `morph compact: ${olderMessages.length} messages -> ${Math.round(
          result.usage.compression_ratio * 100,
        )}% kept (${result.usage.processing_time_ms}ms)`,
      );

      return {
        ...base,
        messages: [
          buildCompactedMessage(olderMessages[0]!, result, olderMessages.length),
          ...recentMessages,
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.api.logger.warn?.(`morph compact failed: ${message}`);
      return base;
    }
  }

  async compact(params: Parameters<LegacyContextEngine["compact"]>[0]) {
    return this.legacy.compact(params);
  }

  async dispose(): Promise<void> {
    await this.legacy.dispose?.();
  }
}

export function createMorphContextEngine(params: { api: OpenClawPluginApi }): ContextEngine {
  return new MorphContextEngine(params.api);
}
