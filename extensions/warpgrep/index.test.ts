import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";
import { createWarpGrepTool } from "./src/tool.js";

const mockExecute = vi.fn();
const mockWarpGrepClient = vi.fn();

vi.mock("@morphllm/morphsdk", () => ({
  WarpGrepClient: class {
    constructor(config: unknown) {
      mockWarpGrepClient(config);
    }

    execute(input: unknown) {
      return mockExecute(input);
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

describe("warpgrep plugin", () => {
  let workspaceDir: string;
  let originalMorphApiKey: string | undefined;
  let originalWarpGrepApiKey: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalMorphApiKey = process.env.MORPH_API_KEY;
    originalWarpGrepApiKey = process.env.WARPGREP_API_KEY;
    delete process.env.MORPH_API_KEY;
    delete process.env.WARPGREP_API_KEY;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-warpgrep-"));
  });

  afterEach(async () => {
    if (originalMorphApiKey === undefined) {
      delete process.env.MORPH_API_KEY;
    } else {
      process.env.MORPH_API_KEY = originalMorphApiKey;
    }

    if (originalWarpGrepApiKey === undefined) {
      delete process.env.WARPGREP_API_KEY;
    } else {
      process.env.WARPGREP_API_KEY = originalWarpGrepApiKey;
    }

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("registers an optional tool factory", () => {
    const api = {
      registerTool: vi.fn(),
    };

    register(api as never);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), { optional: true });
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
            text: expect.stringContaining("WarpGrep is not configured."),
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
        timeoutMs: 12_345,
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

  it("falls back to env api key and surfaces failures", async () => {
    process.env.WARPGREP_API_KEY = "env-key";

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
});
