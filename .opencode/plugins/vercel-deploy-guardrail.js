// Hard-block fallback for production deploys via the Vercel MCP tool.
//
// The native permission rule in opencode.json (root) already requires a human
// click for every call to this tool, preview or production. This plugin is a
// second, independent layer that hard-blocks specifically when
// target === "production", so a production deploy is still stopped even if the
// native "ask" prompt is ever bypassed (e.g. a session started with --auto, or
// a future change to the permission config that loosens the "ask" rule).
//
// Known limitation: a plugin's "tool.execute.before" hook cannot trigger the
// native interactive approval prompt. It can only allow the call through or
// throw to hard-block it. So this is NOT a "click to confirm" flow — a blocked
// call fails outright with the message below, and a real production deploy has
// to be approved through the native "ask" prompt (or done manually), not
// resumed from here.
//
// Dual V1 + V2 entrypoint (see https://opencode.ai/v2/docs/build/plugins/migrate-v1):
// - V1 (1.x) discovers the named export below and calls server() on the
//   default export when present (1.18.29+). The default export here has NO
//   server() on purpose, so V1 keeps using exactly one registration path.
// - V2 (2.x) loads the default export { id, setup } and ignores named exports.

import { Plugin } from "@opencode/plugin";

const TOOL = "vercel_deploy_to_vercel";

const BLOCK_MESSAGE =
  "Blocked: production deploy via vercel_deploy_to_vercel is not allowed from an automated session. " +
  "Ask the user to confirm explicitly, then run the deploy through the native permission prompt " +
  "(or manually) instead of retrying this call.";

// V1 passes tool args as output.args; V2 passes them as event.input.
// Accept both shapes so the guard cannot be bypassed by arg placement.
const targetOf = (args) => args?.target ?? args?.args?.target;

const isProductionDeploy = (tool, args) =>
  tool === TOOL && targetOf(args) === "production";

export const VercelDeployGuardrail = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (isProductionDeploy(input?.tool, output?.args ?? input?.args)) {
        throw new Error(BLOCK_MESSAGE);
      }
    },
  };
};

export default Plugin.define({
  id: "vercel-deploy-guardrail",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (isProductionDeploy(event?.tool, event?.input ?? event?.args)) {
        throw new Error(BLOCK_MESSAGE);
      }
    });
  },
});
