import type { OpenClawPluginApi } from "../../src/plugin-sdk/morph.js";
import { createMorphContextEngine } from "./src/context-engine.js";
import { createWarpGrepTool } from "./src/tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => createWarpGrepTool({ api, ctx }), { optional: true });
  api.registerContextEngine("morph", () => createMorphContextEngine({ api }));
}
