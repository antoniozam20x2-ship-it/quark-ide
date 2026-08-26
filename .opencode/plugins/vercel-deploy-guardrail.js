// Hard-block fallback for production deploys via the Vercel MCP tool.
//
// The native "permission": { "vercel_deploy_to_vercel": "ask" } rule in
// opencode.json (root) already requires a human click for every call to
// this tool, preview or production. This plugin is a second, independent
// layer that hard-blocks specifically when target === "production", so a
// production deploy is still stopped even if the native "ask" prompt is
// ever bypassed (e.g. a session started with --auto, or a future change
// to the permission config that loosens the "ask" rule).
//
// Known limitation (as of OpenCode 1.18.x, see anomalyco/opencode issues
// #7006 and #37164): a plugin's "tool.execute.before" hook cannot trigger
// the native interactive approval prompt. It can only allow the call
// through or throw to hard-block it. So this is NOT a "click to confirm"
// flow — a blocked call fails outright with the message below, and a real
// production deploy has to be approved through the native "ask" prompt
// above (or done manually), not resumed from here.
export const VercelDeployGuardrail = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "vercel_deploy_to_vercel" && output.args?.target === "production") {
        throw new Error(
          "Blocked: production deploy via vercel_deploy_to_vercel is not allowed from an automated session. " +
          "Ask the user to confirm explicitly, then run the deploy through the native permission prompt " +
          "(or manually) instead of retrying this call."
        );
      }
    },
  };
};
