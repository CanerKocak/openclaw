// Narrow plugin-sdk surface for the bundled warpgrep plugin.
// Keep this list additive and scoped to symbols used under extensions/warpgrep.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "../plugins/types.js";
