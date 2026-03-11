import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../src/plugin-sdk/morph.js";
import register from "./index.js";
import { createMorphContextEngine } from "./src/context-engine.js";
import { createWarpGrepTool } from "./src/tool.js";

const mockExecute = vi.fn();
const mockWarpGrepClient = vi.fn();
const mockCompact = vi.fn();
const mockCompactClient = vi.fn();

vi.mock("@morphllm/morphsdk", () => ({
  WarpGrepClient: class {
    constructor(config: unknown) {
      mockWarpGrepClient(config);
    }

    execute(input: unknown) {
      return mockExecute(input);
    }
  },
  CompactClient: class {
    constructor(config: unknown) {
      mockCompactClient(config);
    }

    compact(input: unknown) {
      return mockCompact(input);
    }
  },
}));

async function* createWarpGrepStream({
  steps = [],
  result,
}: {
  steps?: Array<{ turn: number; toolCalls?: Array<{ name: string }> }>;
  result: {
    success: boolean;
    contexts?: Array<{
      file: string;
      content: string;
      lines?: "*" | Array<[number, number]>;
    }>;
    error?: string;
  };
}) {
  for (const step of steps) {
    yield step;
  }

  return result;
}

describe("morph plugin", () => {
  let workspaceDir: string;
  let originalMorphApiKey: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalMorphApiKey = process.env.MORPH_API_KEY;
    delete process.env.MORPH_API_KEY;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-morph-"));
  });

  afterEach(async () => {
    if (originalMorphApiKey === undefined) {
      delete process.env.MORPH_API_KEY;
    } else {
      process.env.MORPH_API_KEY = originalMorphApiKey;
    }

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("registers the Morph tool and context engine", () => {
    const api = {
      registerTool: vi.fn(),
      registerContextEngine: vi.fn(),
    };

    register(api as never);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), { optional: true });
    expect(api.registerContextEngine).toHaveBeenCalledTimes(1);
    expect(api.registerContextEngine).toHaveBeenCalledWith("morph", expect.any(Function));
  });

  it("returns a setup message when no api key is configured", async () => {
    const tool = createWarpGrepTool({
      api: {
        pluginConfig: {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        config: {},
      } as never,
      ctx: { workspaceDir },
    });

    const result = await tool.execute("tool-1", { search_term: "Find auth flow" });

    expect(mockWarpGrepClient).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Morph is not configured."),
          }),
        ],
      }),
    );
  });

  it("uses plugin config and formats successful results", async () => {
    const api = {
      pluginConfig: {
        apiKey: "plugin-key",
        baseUrl: "https://morph.example",
        warpGrepTimeoutMs: 12_345,
        excludes: ["node_modules", ".git"],
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      config: {},
    };

    mockExecute.mockImplementation(() =>
      createWarpGrepStream({
        steps: [{ turn: 1, toolCalls: [{ name: "grep" }] }],
        result: {
          success: true,
          contexts: [
            {
              file: "src/auth.ts",
              lines: [[12, 20]],
              content: "export function authenticate() {}",
            },
          ],
        },
      }),
    );

    const tool = createWarpGrepTool({
      api: api as never,
      ctx: { workspaceDir },
    });

    const result = await tool.execute("tool-1", { search_term: "Find auth flow" });

    expect(mockWarpGrepClient).toHaveBeenCalledWith({
      morphApiKey: "plugin-key",
      morphApiUrl: "https://morph.example",
      timeout: 12_345,
    });
    expect(mockExecute).toHaveBeenCalledWith({
      searchTerm: "Find auth flow",
      repoRoot: workspaceDir,
      includes: undefined,
      excludes: ["node_modules", ".git"],
      streamSteps: true,
    });
    expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("warpgrep turn 1"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("1 contexts"));
    expect(result).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('<file path="src/auth.ts" lines="12-20">'),
          }),
        ],
        details: expect.objectContaining({
          success: true,
          contextCount: 1,
          turnCount: 1,
          repoRoot: workspaceDir,
        }),
      }),
    );
  });

  it("falls back to MORPH_API_KEY and surfaces failures", async () => {
    process.env.MORPH_API_KEY = "env-key";

    const api = {
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      config: {},
    };

    mockExecute.mockImplementation(() =>
      createWarpGrepStream({
        result: {
          success: false,
          error: "backend unavailable",
        },
      }),
    );

    const tool = createWarpGrepTool({
      api: api as never,
      ctx: { workspaceDir },
    });

    const result = await tool.execute("tool-1", { search_term: "Find auth flow" });

    expect(mockWarpGrepClient).toHaveBeenCalledWith({
      morphApiKey: "env-key",
      morphApiUrl: "https://api.morphllm.com",
      timeout: 60_000,
    });
    expect(result).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "text",
            text: "WarpGrep search failed: backend unavailable",
          }),
        ],
        details: expect.objectContaining({
          success: false,
          error: "backend unavailable",
        }),
      }),
    );
  });

  it("compacts older messages through the Morph context engine", async () => {
    mockCompact.mockResolvedValue({
      id: "compact-1",
      output: "Compacted summary",
      messages: [],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        compression_ratio: 0.42,
        processing_time_ms: 123,
      },
      model: "default",
    });

    const engine = createMorphContextEngine({
      api: {
        pluginConfig: {
          apiKey: "plugin-key",
          compactThresholdChars: 1,
          compactPreserveRecent: 2,
          compactCompressionRatio: 0.3,
          compactModel: "morph-compactor",
        },
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        config: {},
      } as never,
    });

    const messages: AgentMessage[] = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "First user message" }] },
      {
        role: "assistant",
        timestamp: 2,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        content: [{ type: "text", text: "Assistant reply" }],
      },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "Recent question" }] },
      {
        role: "assistant",
        timestamp: 4,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        content: [{ type: "text", text: "Recent answer" }],
      },
    ];

    const result = await engine.assemble({ sessionId: "session-1", messages });

    expect(mockCompact).toHaveBeenCalledWith({
      messages: [
        { role: "user", content: "First user message" },
        { role: "assistant", content: "Assistant reply" },
      ],
      compressionRatio: 0.3,
      preserveRecent: 0,
      model: "morph-compactor",
    });
    expect(mockCompactClient).toHaveBeenCalledWith({
      morphApiKey: "plugin-key",
      morphApiUrl: "https://api.morphllm.com",
      timeout: 60_000,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("[Morph Compact: 2 messages compressed, 42% kept]"),
          }),
        ],
      }),
    );
  });
});
