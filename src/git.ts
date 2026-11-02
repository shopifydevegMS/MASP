// Read-only Git access. Every call goes through an allowlist so the controller
// cannot commit, push, merge, reset, rebase or touch refs, even by mistake.
import { execFileSync, spawnSync } from "node:child_process";

const READ_ONLY = new Set([
  "rev-parse", "ls-tree", "cat-file", "merge-base", "for-each-ref",
  "status", "diff", "log", "ls-files", "show", "worktree", "config",
]);

function checkArgs(args: string[]): void {
  const sub = args[0];
  if (!READ_ONLY.has(sub)) throw new Error(`MASP git policy: '${sub}' is not allowed (read-only commands only)`);
  if (sub === "worktree" && args[1] !== "list") throw new Error("MASP git policy: only 'git worktree list' is allowed");
  if (sub === "config" && !["--get", "--list", "--get-all"].includes(args[1]))
    throw new Error("MASP git policy: only reading git config is allowed");
}

const ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",      // 'git status' must not rewrite the index
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};

export function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
  checkArgs(args);
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd, env: ENV, input, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
}

export function gitText(cwd: string, args: string[]): string {
  return git(cwd, args).toString("utf8").trim();
}

export function gitOk(cwd: string, args: string[]): boolean {
  checkArgs(args);
  const r = spawnSync("git", args, { cwd, env: ENV, stdio: "ignore" });
  return r.status === 0;
}

export function headCommit(cwd: string): string {
  return gitText(cwd, ["rev-parse", "HEAD"]);
}

export function commonDir(cwd: string): string {
  return gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitOk(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

/** Read every blob of a commit under the given top-level dirs: path -> raw content. */
export function readCommitFiles(repo: string, commit: string, dirs: string[]): Map<string, Buffer> {
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8");
  const entries: { sha: string; path: string }[] = [];
  for (const rec of listing.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [, type, sha] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (type === "blob" && dirs.includes(p.split("/")[0])) entries.push({ sha, path: p });
  }
  const out = new Map<string, Buffer>();
  if (entries.length === 0) return out;
  const raw = git(repo, ["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
  let pos = 0;
  for (const e of entries) {
    const nl = raw.indexOf(10, pos);
    const header = raw.subarray(pos, nl).toString("utf8").split(" ");
    if (header[1] !== "blob") throw new Error(`unexpected cat-file output for ${e.path}`);
    const size = Number(header[2]);
    out.set(e.path, Buffer.from(raw.subarray(nl + 1, nl + 1 + size)));
    pos = nl + 1 + size + 1;
  }
  return out;
}
