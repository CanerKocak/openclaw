import fs from "node:fs/promises";
import { WarpGrepClient } from "@morphllm/morphsdk";
import type { WarpGrepResult } from "@morphllm/morphsdk";
import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../../../src/plugin-sdk/morph.js";
import { resolveMorphPluginConfig } from "./config.js";
import { formatWarpGrepResult } from "./format.js";

const WarpGrepSearchSchema = Type.Object(
  {
    search_term: Type.String({
      description:
        "Natural language query describing what to find in the current workspace codebase.",
    }),
  },
  { additionalProperties: false },
);

async function ensureDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function executeStreamingSearch(params: {
  api: OpenClawPluginApi;
  client: WarpGrepClient;
  repoRoot: string;
  searchTerm: string;
  includes?: string[];
  excludes?: string[];
}): Promise<{ result: WarpGrepResult; turnCount: number }> {
  const generator = params.client.execute({
    searchTerm: params.searchTerm,
    repoRoot: params.repoRoot,
    includes: params.includes,
    excludes: params.excludes,
    streamSteps: true,
  });

  let turnCount = 0;

  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      return { result: value, turnCount };
    }

    turnCount = value.turn;
    params.api.logger.debug?.(
      `warpgrep turn ${value.turn}: ${value.toolCalls?.map((tool) => tool.name).join(", ") ?? "..."}`,
    );
  }
}

export function createWarpGrepTool(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "warpgrep_codebase_search",
    label: "WarpGrep Codebase Search",
    description:
      "Fast agentic codebase search for the current workspace using Morph WarpGrep. Best for exploratory questions like finding flows, ownership, integrations, or where a system is wired together.",
    parameters: WarpGrepSearchSchema,
    async execute(_toolCallId, rawParams) {
      const searchTerm =
        typeof rawParams?.search_term === "string" ? rawParams.search_term.trim() : "";
      if (!searchTerm) {
        throw new Error("search_term required");
      }

      const repoRoot = params.ctx.workspaceDir ?? process.cwd();
      if (!(await ensureDirectory(repoRoot))) {
        return {
          content: [
            {
              type: "text",
              text: `WarpGrep search failed: workspace directory does not exist: ${repoRoot}`,
            },
          ],
          details: { success: false, error: "workspace directory does not exist", repoRoot },
        };
      }

      const config = resolveMorphPluginConfig(params.api.pluginConfig);
      if (!config.apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Morph is not configured.\n\nSet plugins.entries.morph.config.apiKey or MORPH_API_KEY.",
            },
          ],
          details: { success: false, configured: false, repoRoot },
        };
      }

      const client = new WarpGrepClient({
        morphApiKey: config.apiKey,
        morphApiUrl: config.baseUrl,
        timeout: config.warpGrepTimeoutMs,
      });

      const startedAt = Date.now();

      try {
        const { result, turnCount } = await executeStreamingSearch({
          api: params.api,
          client,
          repoRoot,
          searchTerm,
          includes: config.includes,
          excludes: config.excludes,
        });

        const durationMs = Date.now() - startedAt;
        const contextCount = result.contexts?.length ?? 0;
        params.api.logger.info?.(
          `warpgrep: ${contextCount} contexts in ${turnCount} turns (${durationMs}ms)`,
        );

        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: `WarpGrep search failed: ${result.error ?? "unknown error"}`,
              },
            ],
            details: {
              success: false,
              error: result.error ?? "unknown error",
              repoRoot,
              durationMs,
              turnCount,
            },
          };
        }

        return {
          content: [{ type: "text", text: formatWarpGrepResult(result) }],
          details: {
            success: true,
            repoRoot,
            durationMs,
            turnCount,
            contextCount,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - startedAt;
        params.api.logger.warn?.(`warpgrep failed after ${durationMs}ms: ${message}`);
        return {
          content: [{ type: "text", text: `WarpGrep search failed: ${message}` }],
          details: {
            success: false,
            error: message,
            repoRoot,
            durationMs,
          },
        };
      }
    },
  };
}
