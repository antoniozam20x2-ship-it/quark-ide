/**
 * Shadow Git Checkpoints — V2 port of @arkfactory/opencode-checkpoint@1.0.4.
 *
 * The upstream package is V1-only (its repo is gone and 1.0.4 predates V2),
 * so this local plugin re-implements its behavior on the V2 API
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1):
 *
 * - V1 `file.edited`            -> V2 `ctx.tool.hook("execute.after")`
 *                                  filtered to file-writing tools,
 *                                  debounced (5s) auto-checkpoint.
 * - V1 `session.idle`           -> V2 `ctx.event.subscribe()` matching
 *                                  `session.idle`: session checkpoint.
 * - V1 `session.error`          -> V2 `ctx.event.subscribe()` matching
 *                                  `session.error`: emergency checkpoint.
 *
 * Like the original, everything shells out to the `checkpoint-cli` binary.
 * When the binary is not on PATH the plugin logs once and stays inert
 * instead of failing the session.
 *
 * V2-only entrypoint (default export, no named export, no server()):
 * V1 keeps working through the globally installed V1 plugin files, so this
 * file intentionally registers nothing on V1.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { Plugin } from "@opencode/plugin";

const DEBOUNCE_MS = 5_000;
const CLI_TIMEOUT_MS = 30_000;

// V2 file-writing tools (cf. V1 edit/write/patch surface).
const EDIT_TOOLS = new Set(["edit", "write", "patch"]);

const runCli = (cwd, args) =>
  new Promise((resolve) => {
    execFile("checkpoint-cli", args, { cwd, timeout: CLI_TIMEOUT_MS }, (error, stdout) => {
      if (error) resolve({ ok: false, error });
      else resolve({ ok: true, stdout: stdout ?? "" });
    });
  });

export default Plugin.define({
  id: "checkpoint",
  async setup(ctx) {
    const directory = ctx.location?.directory ?? process.cwd();

    // Same fail-open philosophy as the V1 plugin: without the CLI binary
    // there is nothing to drive, so stay inert instead of breaking the host.
    const probe = await runCli(directory, ["--version"]);
    if (!probe.ok) {
      console.log(
        "[checkpoint] checkpoint-cli not found on PATH — checkpoints disabled. " +
          "Install the checkpoint CLI tooling to enable automatic checkpoints."
      );
      return;
    }

    const shadowPath = join(directory, ".opencode", "checkpoints");
    if (!existsSync(shadowPath)) {
      console.log("[checkpoint] Shadow Git not initialized yet. Will initialize on first edit.");
    } else {
      const status = await runCli(directory, ["status", "--json"]);
      if (status.ok) {
        try {
          const total = JSON.parse(status.stdout)?.checkpoints?.total ?? 0;
          if (total > 0) console.log(`[checkpoint] Found ${total} existing checkpoints`);
        } catch {
          // Malformed CLI output: ignore, checkpoints still work.
        }
      }
    }

    let timer = null;
    const scheduleAutoCheckpoint = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        // execFile (no shell): plain message, unlike the V1 plugin which
        // embedded quotes for its `execSync` shell string.
        const res = await runCli(directory, ["create", "--auto", "--message", "Auto-checkpoint from OpenCode"]);
        if (res.ok) console.log("[checkpoint] ✓ Auto-checkpoint created");
      }, DEBOUNCE_MS);
    };

    try {
      await ctx.tool.hook("execute.after", (event) => {
        try {
          if (event && EDIT_TOOLS.has(event.tool)) scheduleAutoCheckpoint();
        } catch (err) {
          console.error("[checkpoint] execute.after hook failed:", err);
        }
      });
    } catch (err) {
      console.error("[checkpoint] tool hook registration failed:", err);
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (event?.type === "session.idle") {
              const res = await runCli(directory, [
                "create",
                "--type",
                "session",
                "--message",
                "Session idle checkpoint",
              ]);
              if (res.ok) console.log("[checkpoint] ✓ Session checkpoint created");
            } else if (event?.type === "session.error") {
              const msg = event?.error?.message ?? event?.message ?? "Unknown error";
              const res = await runCli(directory, [
                "create",
                "--type",
                "emergency",
                "--message",
                `Emergency: ${msg}`,
              ]);
              if (res.ok) console.log("[checkpoint] Emergency checkpoint created");
            }
          } catch (err) {
            console.error("[checkpoint] event handling failed:", err);
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") console.error("[checkpoint] event subscription failed:", err);
      }
    })();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  },
});
