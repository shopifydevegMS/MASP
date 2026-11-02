// Builds throwaway sandboxes under .tmp/ for tests and the demo.
// The HARNESS (not MASP) runs `git init`, makes the baseline commits and adds worktrees,
// because Git worktrees need at least one commit. MASP itself only reads from Git.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCtx, type Ctx } from "../src/context.ts";
import * as cmd from "../src/commands.ts";
import { sha256 } from "../src/util.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "masp.ts");
export const FIXTURE = path.join(ROOT, "fixture", "theme");

function hgit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface SessionSpec {
  id: string;
  owns: string[];
  shared: string[];
  autoPublish?: boolean;
}

export const DEFAULT_SESSIONS: SessionSpec[] = [
  { id: "A", owns: ["assets/dev1.css", "sections/a-*.liquid", "snippets/a-*.liquid"], shared: ["templates/index.json", "templates/product.json", "sections/*-group.json"] },
  { id: "B", owns: ["assets/dev2.css", "sections/b-*.liquid", "snippets/b-*.liquid"], shared: ["templates/index.json", "templates/product.json", "sections/*-group.json"] },
];

export class Sandbox {
  root: string;
  repo: string;
  preview: string;
  data: string;
  config: string;
  worktrees: Record<string, string> = {};
  baseCommit = "";
  parentCommit = "";
  private _ctx: Ctx | null = null;
  children: ChildProcess[] = [];

  constructor(name: string, opts: { sessions?: SessionSpec[]; settleMs?: number; init?: boolean; base?: string; root?: string; extraConfig?: Record<string, unknown>; fixture?: string } = {}) {
    this.root = opts.root ?? path.join(ROOT, ".tmp", `t-${name}-${crypto.randomBytes(3).toString("hex")}`);
    this.repo = path.join(this.root, "repo");
    this.preview = path.join(this.root, "preview");
    this.data = path.join(this.root, ".masp");
    this.config = path.join(this.root, "masp.config.json");
    fs.mkdirSync(this.root, { recursive: true });
    fs.cpSync(opts.fixture ?? FIXTURE, this.repo, { recursive: true });

    // Two commits so a test can check out a commit that is NOT based on the baseline.
    const olderCss = path.join(this.repo, "assets", "base.css");
    const finalCss = fs.readFileSync(olderCss);
    fs.writeFileSync(olderCss, "/* pre-baseline version (harness) */\nbody { margin: 0; }\n");
    hgit(this.repo, ["init", "-q", "-b", "main"]);
    hgit(this.repo, ["config", "user.name", "MASP test harness"]);
    hgit(this.repo, ["config", "user.email", "harness@masp.invalid"]);
    hgit(this.repo, ["config", "commit.gpgsign", "false"]);
    hgit(this.repo, ["add", "-A"]);
    hgit(this.repo, ["commit", "-q", "-m", "harness: pre-baseline"]);
    this.parentCommit = hgit(this.repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(olderCss, finalCss);
    hgit(this.repo, ["add", "-A"]);
    hgit(this.repo, ["commit", "-q", "-m", "harness: baseline"]);
    this.baseCommit = hgit(this.repo, ["rev-parse", "HEAD"]);

    const sessions = opts.sessions ?? DEFAULT_SESSIONS;
    for (const s of sessions) {
      const wt = path.join(this.root, "worktrees", s.id.toLowerCase());
      hgit(this.repo, ["worktree", "add", "-q", "-b", `session-${s.id.toLowerCase()}`, wt, "HEAD"]);
      this.worktrees[s.id] = wt;
    }
    fs.writeFileSync(this.config, JSON.stringify({
      repo: "repo", preview: "preview", dataDir: ".masp",
      settleMs: opts.settleMs ?? 60, reconcileMs: 1500,
      critical: ["layout/**", "config/settings_data.json", "config/settings_schema.json", "snippets/shared-*.liquid"],
      ...opts.extraConfig,
      sessions: sessions.map((s) => ({ id: s.id, worktree: `worktrees/${s.id.toLowerCase()}`, task: `test task ${s.id}`, owns: s.owns, shared: s.shared, autoPublish: s.autoPublish })),
    }, null, 2));
    if (opts.init !== false) cmd.init(this.ctx(), { base: opts.base });
  }

  ctx(): Ctx {
    this._ctx ??= openCtx(this.config, () => {});
    return this._ctx;
  }
  freshCtx(): Ctx {
    this._ctx = null;
    return this.ctx();
  }

  /** Simulated worker edit. Writes CRLF like a Windows editor would. */
  write(session: string, rel: string, content: string, crlf = true): void {
    const f = path.join(this.worktrees[session], ...rel.split("/"));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crlf ? content.replace(/\r?\n/g, "\r\n") : content);
  }
  /** Simulated editor "safe save": write a temp file, then rename over the target. */
  writeAtomic(session: string, rel: string, content: string): void {
    const f = path.join(this.worktrees[session], ...rel.split("/"));
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, f);
  }
  readWorker(session: string, rel: string): string {
    return fs.readFileSync(path.join(this.worktrees[session], ...rel.split("/")), "utf8");
  }
  rm(session: string, rel: string): void {
    fs.rmSync(path.join(this.worktrees[session], ...rel.split("/")));
  }
  readPreview(rel: string): string | null {
    try {
      return fs.readFileSync(path.join(this.preview, ...rel.split("/")), "utf8");
    } catch {
      return null;
    }
  }
  editJson(session: string, rel: string, fn: (v: any) => void): void {
    const raw = this.readWorker(session, rel).replace(/\r\n/g, "\n");
    const m = /^(\s*\/\*[\s\S]*?\*\/\s*)?([\s\S]*)$/.exec(raw)!;
    const v = JSON.parse(m[2]);
    fn(v);
    this.write(session, rel, (m[1] ?? "") + JSON.stringify(v, null, 2) + "\n");
  }

  masp(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [BIN, ...args, "--config", this.config], {
      encoding: "utf8", env: { ...process.env, ...env }, timeout: 60000,
    });
    return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
  }
  startController(): ChildProcess {
    const c = spawn(process.execPath, [BIN, "start", "--config", this.config], { stdio: ["ignore", "pipe", "pipe"] });
    c.stdout!.setEncoding("utf8");
    let out = "";
    c.stdout!.on("data", (d) => (out += d));
    (c as any).output = () => out;
    this.children.push(c);
    return c;
  }

  /** Every commit, ref, reflog and index file in the repository: anything MASP must not change. */
  gitSnapshot(): string {
    const parts = [
      hgit(this.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      hgit(this.repo, ["rev-list", "--all", "--count"]),
      hgit(this.repo, ["stash", "list"]),
      hgit(this.repo, ["remote", "-v"]),
      ...Object.values(this.worktrees).map((w) => hgit(w, ["rev-parse", "HEAD"]) + " " + hgit(w, ["reflog", "--format=%H %gs"])),
    ];
    const gitDir = path.join(this.repo, ".git");
    const indexes = [path.join(gitDir, "index"), ...fs.readdirSync(path.join(gitDir, "worktrees")).map((w) => path.join(gitDir, "worktrees", w, "index"))];
    for (const ix of indexes) parts.push(ix + " " + sha256(fs.readFileSync(ix)));
    return parts.join("\n");
  }

  /** Hash of every file in every worktree (tracked, untracked and the .git pointer file). */
  worktreeSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, wt] of Object.entries(this.worktrees)) {
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) walk(f);
          else out[`${id}:${path.relative(wt, f)}`] = sha256(fs.readFileSync(f)) + ":" + fs.statSync(f).mtimeMs;
        }
      };
      walk(wt);
    }
    return out;
  }

  async cleanup(): Promise<void> {
    for (const c of this.children) if (c.exitCode === null) c.kill();
    if (!process.env.MASP_KEEP_SANDBOX) {
      for (let i = 0; i < 25; i++) {
        try {
          fs.rmSync(this.root, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }
}


export async function waitFor(cond: () => boolean, timeoutMs = 15000, what = "condition"): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return Date.now() - t0;
}
