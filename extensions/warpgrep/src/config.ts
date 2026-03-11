const DEFAULT_MORPH_API_URL = "https://api.morphllm.com";
const DEFAULT_TIMEOUT_MS = 60_000;

export type WarpGrepPluginConfig = {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  includes?: string[];
  excludes?: string[];
};

export type ResolvedWarpGrepPluginConfig = {
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  includes?: string[];
  excludes?: string[];
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveWarpGrepPluginConfig(raw: unknown): ResolvedWarpGrepPluginConfig {
  const config = (raw ?? {}) as WarpGrepPluginConfig;

  return {
    apiKey:
      normalizeString(config.apiKey) ??
      normalizeString(process.env.MORPH_API_KEY) ??
      normalizeString(process.env.WARPGREP_API_KEY),
    baseUrl:
      normalizeString(config.baseUrl) ??
      normalizeString(process.env.MORPH_API_URL) ??
      DEFAULT_MORPH_API_URL,
    timeoutMs: normalizePositiveNumber(config.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    includes: normalizeStringArray(config.includes),
    excludes: normalizeStringArray(config.excludes),
  };
}
