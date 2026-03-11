import type { OpenClawPluginApi } from "openclaw/plugin-sdk/warpgrep";
import { createWarpGrepTool } from "./src/tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => createWarpGrepTool({ api, ctx }), { optional: true });
}
