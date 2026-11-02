// Git WRITE access, used ONLY by `masp land`, `masp resync` (src/land.ts) and `masp new` (src/setup.ts),
// which a person runs explicitly.
// The controller, publishing and every other command use the read-only wrapper in git.ts.
// No push, no fetch, no merge, no rebase, no branch deletion: those stay with the developer.
import { execFileSync } from "node:child_process";

const ALLOWED: Record<string, (args: string[]) => boolean> = {
  "hash-object": (a) => a.includes("-w") && a.includes("--no-filters"),
  "read-tree": () => true,              // into a temporary index, or -m -u fast-forward of a clean checkout
  "update-index": (a) => a.includes("--index-info"),
  "write-tree": () => true,
  "commit-tree": () => true,
  "update-ref": (a) => a.length === 4 && a[1].startsWith("refs/heads/"), // always with the expected old value (compare-and-swap)
  "reset": (a) => a[1] === "--hard" && a.length === 3,                    // resync: only after checking nothing would be lost
  // masp new: a fresh clone (the developer's own working copy is never used) and one worktree per session.
  "clone": (a) => a.length === 6 && a[1] === "--quiet" && a[2] === "--branch" && !a[4].startsWith("-") && !a[5].startsWith("-"),
  "worktree": (a) => a[1] === "add" && a[2] === "-b" && a.length === 6,
};

export function gitWrite(cwd: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): string {
  const check = ALLOWED[args[0]];
  if (!check || !check(args)) throw new Error(`MASP git write policy: 'git ${args.join(" ")}' is not allowed`);
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd, input: opts.input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  }).trim();
}
