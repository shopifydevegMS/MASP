// Set up MASP around a copy of a real theme (for example one downloaded with `shopify theme pull`).
//   node examples/setup-real.ts --source <theme folder> --target <new folder>
// Creates <target>/repo (new Git repo, ONE baseline commit made by this setup script),
// <target>/worktrees/a and b, <target>/masp.config.json, then runs `masp init`.
// The source folder is only read. Nothing is uploaded to Shopify.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openCtx } from "../src/context.ts";
import * as cmd from "../src/commands.ts";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const source = path.resolve(arg("source") ?? "");
const target = path.resolve(arg("target") ?? "");
if (!arg("source") || !arg("target")) {
  console.error("usage: node examples/setup-real.ts --source <theme folder> --target <new folder>");
  process.exit(1);
}
if (!fs.existsSync(path.join(source, "layout", "theme.liquid"))) {
  console.error(`${source} does not look like a Shopify theme (no layout/theme.liquid)`);
  process.exit(1);
}
const repo = path.join(target, "repo");
if (fs.existsSync(repo)) {
  console.error(`${repo} already exists; not touching it`);
  process.exit(1);
}
const g = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

fs.mkdirSync(repo, { recursive: true });
for (const d of ["assets", "blocks", "config", "layout", "locales", "sections", "snippets", "templates"])
  if (fs.existsSync(path.join(source, d))) fs.cpSync(path.join(source, d), path.join(repo, d), { recursive: true });
g(repo, ["init", "-q", "-b", "main"]);
g(repo, ["config", "user.name", "MASP setup"]);
g(repo, ["config", "user.email", "setup@masp.invalid"]);
g(repo, ["config", "commit.gpgsign", "false"]);
g(repo, ["add", "-A"]);
g(repo, ["commit", "-q", "-m", `setup: baseline copy of ${path.basename(source)}`]);
for (const id of ["a", "b"]) g(repo, ["worktree", "add", "-q", "-b", `session-${id}`, path.join(target, "worktrees", id), "HEAD"]);

fs.writeFileSync(path.join(target, "masp.config.json"), JSON.stringify({
  repo: "repo", preview: "preview", dataDir: ".masp", settleMs: 400, reconcileMs: 30000,
  critical: ["layout/**", "config/settings_data.json", "config/settings_schema.json"],
  sessions: [
    { id: "A", worktree: "worktrees/a", task: "session A", owns: ["assets/masp-a-*", "sections/masp-a-*.liquid", "snippets/masp-a-*.liquid", "blocks/masp-a-*.liquid"], shared: ["templates/*.json", "sections/*-group.json"] },
    { id: "B", worktree: "worktrees/b", task: "session B", owns: ["assets/masp-b-*", "sections/masp-b-*.liquid", "snippets/masp-b-*.liquid", "blocks/masp-b-*.liquid"], shared: ["templates/*.json", "sections/*-group.json"] },
  ],
}, null, 2));
fs.writeFileSync(path.join(target, ".masp-setup"), `created by examples/setup-real.ts from ${source}\n`);

const ctx = openCtx(path.join(target, "masp.config.json"), () => {});
const r = cmd.init(ctx);
console.log(`Initialised ${target}: base ${r.baseCommit.slice(0, 10)}, ${r.files} theme files, sessions ${r.registered.join(", ")}`);
for (const [id, e] of Object.entries(r.errors)) console.log(`session ${id} NOT registered: ${e}`);
