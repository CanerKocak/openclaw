import { createHash } from "node:crypto";
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

const CHARS_PER_TOKEN_ESTIMATE = 4;
const MIN_COMPACTION_FAILURE_TTL_MS = 15_000;

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
  const hash = createHash("sha256");
  for (const [index, message] of messages.entries()) {
    hash.update(String(index));
    hash.update("\0");
    hash.update(message.role);
    hash.update("\0");
    if (message.role === "toolResult") {
      hash.update(message.toolCallId ?? "");
      hash.update("\0");
      hash.update(message.toolName ?? "");
      hash.update("\0");
    }
    const serialized = serializeMessage(message);
    hash.update(String(serialized.length));
    hash.update("\0");
    hash.update(serialized);
    hash.update("\u001f");
  }
  return hash.digest("hex");
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
  params: {
    result: MorphCompactResult;
    keptPercent: number;
  },
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
          `${params.keptPercent}% kept]\n\n${params.result.output}`,
      },
    ],
  };
}

function calculateKeptPercent(inputChars: number, outputChars: number): number {
  if (!Number.isFinite(inputChars) || inputChars <= 0) {
    return 100;
  }
  return Math.max(0, Math.round((outputChars / inputChars) * 100));
}

function estimateSerializedInputChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message, index) => {
    const serializedChars = serializeMessage(message).length;
    const separatorChars = index > 0 ? 1 : 0;
    return total + serializedChars + separatorChars;
  }, 0);
}

function resolveCompactionTriggerChars(params: {
  tokenBudget?: number;
  thresholdChars: number;
}): number {
  if (!params.tokenBudget || !Number.isFinite(params.tokenBudget) || params.tokenBudget <= 0) {
    return params.thresholdChars;
  }
  const tokenBudgetChars = Math.max(
    CHARS_PER_TOKEN_ESTIMATE,
    Math.floor(params.tokenBudget * CHARS_PER_TOKEN_ESTIMATE),
  );
  return Math.min(params.thresholdChars, tokenBudgetChars);
}

function resolveCompactionWindow(params: {
  messages: AgentMessage[];
  preserveRecent: number;
}): { olderMessages: AgentMessage[]; recentMessages: AgentMessage[] } | null {
  let boundary = params.messages.length - params.preserveRecent;
  while (
    boundary < params.messages.length &&
    boundary > 0 &&
    params.messages[boundary]?.role === "toolResult"
  ) {
    boundary += 1;
  }

  const olderMessages = params.messages.slice(0, boundary);
  const recentMessages = params.messages.slice(boundary);
  if (olderMessages.length === 0 || recentMessages.length === 0) {
    return null;
  }
  return { olderMessages, recentMessages };
}

function normalizeUserBlocks(
  content: Extract<AgentMessage, { role: "user" }>["content"],
): Array<{ type: string; text?: string; mimeType?: string }> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function buildCompactedMessages(params: {
  olderMessages: AgentMessage[];
  recentMessages: AgentMessage[];
  result: MorphCompactResult;
}): AgentMessage[] {
  const keptPercent = calculateKeptPercent(
    estimateSerializedInputChars(params.olderMessages),
    params.result.output.length,
  );
  const summaryMessage = buildCompactedMessage(
    params.olderMessages[0]!,
    {
      result: params.result,
      keptPercent,
    },
    params.olderMessages.length,
  );
  const [firstRecent, ...restRecent] = params.recentMessages;
  if (firstRecent?.role !== "user") {
    return [summaryMessage, ...params.recentMessages];
  }

  return [
    {
      ...firstRecent,
      timestamp: firstRecent.timestamp ?? summaryMessage.timestamp,
      content: [
        ...normalizeUserBlocks(summaryMessage.content),
        ...normalizeUserBlocks(firstRecent.content),
      ],
    },
    ...restRecent,
  ];
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
  private compactFailureCache: { key: string; until: number } | null = null;

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

    const estimatedChars = estimateContextChars(messages);
    const triggerChars = resolveCompactionTriggerChars({
      tokenBudget: params.tokenBudget,
      thresholdChars: this.config.compact.thresholdChars,
    });
    if (estimatedChars < triggerChars) {
      return base;
    }

    const compactionWindow = resolveCompactionWindow({
      messages,
      preserveRecent: this.config.compact.preserveRecent,
    });
    if (!compactionWindow) {
      return base;
    }
    const { olderMessages, recentMessages } = compactionWindow;

    const cacheKey = buildCacheKey(olderMessages);
    if (this.compactCache?.key === cacheKey) {
      return {
        ...base,
        messages: buildCompactedMessages({
          olderMessages,
          recentMessages,
          result: this.compactCache.result,
        }),
      };
    }
    if (this.compactFailureCache?.key === cacheKey && this.compactFailureCache.until > Date.now()) {
      this.api.logger.debug?.("morph compact skipped: recent identical failure");
      return base;
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
      const keptPercent = calculateKeptPercent(
        estimateSerializedInputChars(olderMessages),
        result.output.length,
      );

      this.compactCache = { key: cacheKey, result };
      this.compactFailureCache = null;
      this.api.logger.info?.(
        `morph compact: ${olderMessages.length} messages -> ${keptPercent}% kept (${result.usage.processing_time_ms}ms)`,
      );

      return {
        ...base,
        messages: buildCompactedMessages({
          olderMessages,
          recentMessages,
          result,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.compactFailureCache = {
        key: cacheKey,
        until: Date.now() + Math.max(MIN_COMPACTION_FAILURE_TTL_MS, this.config.compact.timeoutMs),
      };
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
