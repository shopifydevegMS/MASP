// `masp new`: create a MASP workspace from a Git repository in one step.
//
//   <folder>/
//     repo/            a fresh clone of the repository (your own working copy is never touched)
//     worktrees/a, b   one Git worktree per AI session, each on its own local branch masp/a, masp/b
//     preview/         the unified preview: the only folder 'shopify theme dev' serves
//     .masp/           MASP's state, snapshots and logs
//     agents/          rules, permissions and start scripts for the AI sessions
//     masp.config.json
import fs from "node:fs";
import path from "node:path";
import { gitWrite } from "./gitwrite.ts";
import { gitText } from "./git.ts";
import { openCtx } from "./context.ts";
import { init } from "./commands.ts";
import { prepareAgentFiles } from "./agents.ts";

export interface NewWorkspaceResult {
  folder: string;
  configPath: string;
  branch: string;
  baseCommit: string;
  files: number;
  sessions: { id: string; worktree: string; branch: string; startScript: string }[];
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;

export function newWorkspace(opts: { folder: string; repo: string; branch?: string; sessions?: string[]; prefix?: string }): NewWorkspaceResult {
  const folder = path.resolve(opts.folder);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${folder} already exists and is not empty`);
  const ids = opts.sessions?.length ? opts.sessions : ["A", "B"];
  for (const id of ids) if (!ID.test(id)) throw new Error(`invalid session id '${id}'`);
  if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length) throw new Error("session ids must be unique");
  const prefix = opts.prefix ?? "masp-";
  if (!/^[a-z0-9-]*$/.test(prefix)) throw new Error("--prefix may only contain lower-case letters, digits and '-'");

  // A local path is resolved; anything else (https://, git@...) is passed to git as is.
  const source = fs.existsSync(opts.repo) ? path.resolve(opts.repo) : opts.repo;
  let branch = opts.branch;
  if (!branch) {
    if (!fs.existsSync(opts.repo)) throw new Error("--branch is required when --repo is a URL");
    branch = gitText(source, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") throw new Error("the source repository is on a detached HEAD; pass --branch");
  }
  fs.mkdirSync(folder, { recursive: true });
  const repo = path.join(folder, "repo");
  gitWrite(folder, ["clone", "--quiet", "--branch", branch, source, repo]);
  const base = gitText(repo, ["rev-parse", "HEAD"]);
  if (!fs.existsSync(path.join(repo, "layout", "theme.liquid")))
    throw new Error(`branch '${branch}' of ${opts.repo} does not look like a Shopify theme (no layout/theme.liquid at the top level)`);

  const sessions = ids.map((id) => {
    const lower = id.toLowerCase();
    const worktree = path.join(folder, "worktrees", lower);
    const sessionBranch = `masp/${lower}`;
    gitWrite(repo, ["worktree", "add", "-b", sessionBranch, worktree, base]);
    return {
      id, worktree, branch: sessionBranch, task: `session ${id}`,
      owns: [`assets/${prefix}${lower}-*`, `sections/${prefix}${lower}-*.liquid`, `snippets/${prefix}${lower}-*.liquid`, `blocks/${prefix}${lower}-*.liquid`],
      shared: ["templates/**/*.json", "sections/*-group.json"],
    };
  });
  const configPath = path.join(folder, "masp.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    repo: "repo", preview: "preview", dataDir: ".masp", landBranch: branch,
    settleMs: 400, reconcileMs: 30000,
    critical: ["layout/**", "config/settings_data.json", "config/settings_schema.json"],
    sessions: sessions.map((s) => ({ id: s.id, worktree: path.relative(folder, s.worktree).replace(/\\/g, "/"), task: s.task, owns: s.owns, shared: s.shared })),
  }, null, 2) + "\n");

  const ctx = openCtx(configPath, () => {});
  const r = init(ctx);
  if (Object.keys(r.errors).length) throw new Error(`sessions not registered: ${JSON.stringify(r.errors)}`);
  const out = sessions.map((s) => {
    const cfgSession = ctx.cfg.sessions.find((x) => x.id === s.id)!;
    return { id: s.id, worktree: s.worktree, branch: s.branch, startScript: prepareAgentFiles(ctx.cfg, cfgSession).startScript };
  });
  fs.writeFileSync(path.join(folder, ".masp-workspace"), `MASP workspace for ${opts.repo} (${branch}) created ${new Date().toISOString()}\n`);
  return { folder, configPath, branch, baseCommit: base, files: r.files, sessions: out };
}
