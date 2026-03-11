import type { WarpGrepResult } from "@morphllm/morphsdk";

function formatLineRanges(lines: "*" | Array<[number, number]> | undefined): string {
  if (!lines || lines === "*") {
    return "";
  }

  const ranges = lines.map(([start, end]) => `${start}-${end}`).join(",");
  return ` lines="${ranges}"`;
}

export function formatWarpGrepResult(result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed: ${result.error ?? "unknown error"}`;
  }

  if (!result.contexts || result.contexts.length === 0) {
    return "No relevant code found. Try rephrasing your search term.";
  }

  return result.contexts
    .map(
      (ctx) => `<file path="${ctx.file}"${formatLineRanges(ctx.lines)}>\n${ctx.content}\n</file>`,
    )
    .join("\n\n");
}
