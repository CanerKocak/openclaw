const DEFAULT_MORPH_API_URL = "https://api.morphllm.com";
const DEFAULT_WARPGREP_TIMEOUT_MS = 60_000;
const DEFAULT_COMPACT_TIMEOUT_MS = 60_000;
const DEFAULT_COMPACT_THRESHOLD_CHARS = 100_000;
const DEFAULT_COMPACT_PRESERVE_RECENT = 6;
const DEFAULT_COMPACT_COMPRESSION_RATIO = 0.3;

export type MorphPluginConfig = {
  apiKey?: string;
  baseUrl?: string;
  warpGrepTimeoutMs?: number;
  includes?: string[];
  excludes?: string[];
  compactEnabled?: boolean;
  compactTimeoutMs?: number;
  compactThresholdChars?: number;
  compactPreserveRecent?: number;
  compactCompressionRatio?: number;
  compactModel?: string;
};

export type ResolvedMorphPluginConfig = {
  apiKey?: string;
  baseUrl: string;
  warpGrepTimeoutMs: number;
  includes?: string[];
  excludes?: string[];
  compact: {
    enabled: boolean;
    timeoutMs: number;
    thresholdChars: number;
    preserveRecent: number;
    compressionRatio: number;
    model?: string;
  };
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

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function normalizeRatio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

function normalizeEnvNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveMorphPluginConfig(raw: unknown): ResolvedMorphPluginConfig {
  const config = (raw ?? {}) as MorphPluginConfig;

  return {
    apiKey: normalizeString(config.apiKey) ?? normalizeString(process.env.MORPH_API_KEY),
    baseUrl:
      normalizeString(config.baseUrl) ??
      normalizeString(process.env.MORPH_API_URL) ??
      DEFAULT_MORPH_API_URL,
    warpGrepTimeoutMs:
      normalizePositiveNumber(config.warpGrepTimeoutMs) ?? DEFAULT_WARPGREP_TIMEOUT_MS,
    includes: normalizeStringArray(config.includes),
    excludes: normalizeStringArray(config.excludes),
    compact: {
      enabled:
        normalizeBoolean(config.compactEnabled) ??
        normalizeEnvBoolean(process.env.MORPH_COMPACT) ??
        true,
      timeoutMs: normalizePositiveNumber(config.compactTimeoutMs) ?? DEFAULT_COMPACT_TIMEOUT_MS,
      thresholdChars:
        normalizePositiveNumber(config.compactThresholdChars) ??
        normalizePositiveNumber(normalizeEnvNumber(process.env.MORPH_COMPACT_CHAR_THRESHOLD)) ??
        DEFAULT_COMPACT_THRESHOLD_CHARS,
      preserveRecent:
        normalizePositiveNumber(config.compactPreserveRecent) ??
        normalizePositiveNumber(normalizeEnvNumber(process.env.MORPH_COMPACT_PRESERVE_RECENT)) ??
        DEFAULT_COMPACT_PRESERVE_RECENT,
      compressionRatio:
        normalizeRatio(config.compactCompressionRatio) ??
        normalizeRatio(normalizeEnvNumber(process.env.MORPH_COMPACT_RATIO)) ??
        DEFAULT_COMPACT_COMPRESSION_RATIO,
      model:
        normalizeString(config.compactModel) ?? normalizeString(process.env.MORPH_COMPACT_MODEL),
    },
  };
}
