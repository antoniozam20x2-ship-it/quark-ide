/**
 * OpenDesign — V2 adapter.
 *
 * Upstream `opendesign@git+https://github.com/manalkaff/opendesign.git`
 * (v0.3.1, the only tag) is V1-only: it exposes a named export with a V1
 * `config` hook (`skills: { paths }`) and an
 * `experimental.chat.system.transform` hook, neither of which V2 loads.
 * V2 skills config accepts local paths and HTTP catalogs but not git URLs,
 * so this local plugin bridges the gap on the V2 API
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1):
 *
 * 1. Locates the installed opendesign package (V1 git-plugin cache or a
 *    node_modules copy) and registers every `skills/<id>/SKILL.md` via
 *    `ctx.skill.transform()` — the V2 equivalent of the V1 config hook.
 * 2. Injects the opendesign bootstrap skill into `event.system` via
 *    `ctx.session.hook("context")` — the V2 equivalent of the V1
 *    `experimental.chat.system.transform` hook.
 *
 * If the package cannot be found it logs where it looked and stays inert
 * instead of failing the session.
 *
 * V2-only entrypoint (default export, no named export, no server()).
 */

import { createRequire } from "module";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Plugin } from "@opencode/plugin";

// Minimal frontmatter extractor (same approach as the upstream V1 plugin:
// plain `key: value` lines, single unwrap of matching surrounding quotes).
const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      frontmatter[key] = value;
    }
  }
  return { frontmatter, content: match[2] };
};

// V2 tool mapping: mirrors the upstream V1 mapping, translated to the V2
// tool surface (no todo tool; subagent instead of Task; shell instead of Bash).
const V2_TOOL_MAPPING = `**Tool Mapping for OpenCode:**
When OpenDesign skills reference tools you don't have, substitute OpenCode equivalents:
- Todo tracking → OpenCode v2 has no todo tool; track the plan in a markdown file instead
- Subagent workflows → OpenCode's native \`subagent\` tool
- \`Skill\` tool → OpenCode's native \`skill\` tool
- File operations → your native \`read\`, \`write\`, \`edit\` tools
- Run shell commands → \`shell\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load the other OpenDesign skills on demand.`;

const isOpendesignRoot = (dir) =>
  existsSync(join(dir, "skills", "opendesign", "SKILL.md")) ||
  existsSync(join(dir, ".opencode", "plugins", "opendesign.js"));

// Best-effort location of the installed opendesign package:
// 1. Node resolution from the project and the global opencode config dir.
// 2. The V1 git-plugin cache layout (~/.cache/opencode/packages/<spec>/...).
const findPackageRoot = (projectDir) => {
  const home = homedir();
  const searched = [];

  const tryRequire = (base) => {
    try {
      const req = createRequire(join(base, "package.json"));
      const pkgJson = req.resolve("opendesign/package.json");
      searched.push(pkgJson);
      const root = join(pkgJson, "..");
      if (isOpendesignRoot(root)) return root;
    } catch {
      // Not resolvable from here — fall through to the cache scan.
    }
    return null;
  };

  for (const base of [projectDir, join(projectDir, ".opencode"), join(home, ".config", "opencode")]) {
    const hit = tryRequire(base);
    if (hit) return { root: hit, searched };
  }

  const cacheDir = join(home, ".cache", "opencode", "packages");
  searched.push(`${cacheDir}/*`);
  if (existsSync(cacheDir)) {
    const stack = readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(cacheDir, e.name));
    // Depth-bounded walk: <spec>/[node_modules/superpowers/...]/opendesign-root.
    for (let depth = 0; depth < 3 && stack.length > 0; depth++) {
      const level = stack.splice(0, stack.length);
      for (const dir of level) {
        if (isOpendesignRoot(dir)) return { root: dir, searched };
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
              stack.push(join(dir, e.name));
            }
          }
        } catch {
          // Unreadable dir — skip.
        }
      }
    }
  }

  return { root: null, searched };
};

export default Plugin.define({
  id: "opendesign",
  async setup(ctx) {
    const projectDir = ctx.location?.directory ?? process.cwd();
    const { root, searched } = findPackageRoot(projectDir);

    if (!root) {
      console.warn(
        "[opendesign] package not found — skills not registered. " +
          "Keep \"opendesign@git+https://github.com/manalkaff/opendesign.git#v0.3.1\" in the " +
          "`plugins` array so it gets installed, or vendor its skills/ directory. " +
          `Searched: ${searched.join(", ") || "(nothing)"}`
      );
      return;
    }

    const skillsDir = join(root, "skills");
    const skills = [];
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillPath = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;
        const { frontmatter, content } = extractAndStripFrontmatter(readFileSync(skillPath, "utf8"));
        skills.push({
          id: entry.name,
          name: frontmatter.name || entry.name,
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          path: skillPath,
          content,
        });
      }
    } catch (err) {
      console.error("[opendesign] failed to scan skills, aborting registration:", err);
      return;
    }

    try {
      await ctx.skill.transform((draft) => {
        // Per-skill containment: one rejected payload skips that skill
        // instead of disabling the whole plugin (and its bootstrap hook).
        for (const skill of skills) {
          try {
            draft.add(skill);
          } catch (err) {
            console.error(`[opendesign] skill "${skill.id}" rejected by host, skipping:`, err);
          }
        }
      });
      console.log(`[opendesign] registered ${skills.length} skill(s) from ${root}`);
    } catch (err) {
      // Never break plugin activation (a failing plugin can take down the
      // whole V2 generation, including model providers).
      console.error("[opendesign] skill registration failed:", err);
    }

    try {
      await ctx.session.hook("context", (event) => {
        try {
          const entryPath = join(skillsDir, "opendesign", "SKILL.md");
          if (!existsSync(entryPath)) return;
          const { content } = extractAndStripFrontmatter(readFileSync(entryPath, "utf8"));
          const bootstrap =
            "<EXTREMELY_IMPORTANT>\nYou have OpenDesign loaded.\n\n" +
            "**The opendesign entry-point skill is included below. It is ALREADY LOADED — you are currently following it. Do NOT use the skill tool to load \"opendesign\" again.**\n\n" +
            `${content}\n\n${V2_TOOL_MAPPING}\n</EXTREMELY_IMPORTANT>`;
          if (!event || !Array.isArray(event.system)) return;
          if (event.system.some((p) => p?.text?.includes("You have OpenDesign loaded"))) return;
          event.system.push({ type: "text", text: bootstrap });
        } catch (err) {
          console.error("[opendesign] context hook failed:", err);
        }
      });
    } catch (err) {
      console.error("[opendesign] session hook registration failed:", err);
    }
  },
});
