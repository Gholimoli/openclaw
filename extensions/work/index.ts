import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerWorkCommand } from "./src/work-command.js";
import { createWorkTool } from "./src/work-tool.js";

export default function register(api: OpenClawPluginApi) {
  // Command bypasses LLM for token efficiency and determinism.
  registerWorkCommand(api);

  // Tool is optional (some users may prefer to call it from the agent).
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createWorkTool(api, ctx);
    },
    { optional: true },
  );
}
