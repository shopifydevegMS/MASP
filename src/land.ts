// `masp land`: after the developer has reviewed the Shopify preview, commit exactly what the
// preview shows onto the main branch, as ONE commit on top of the commit the preview was built from.
// `masp resync`: move a finished session's worktree onto that new commit.
//
// Both are run by a person, never automatically. Without --yes they only report.
// Nothing is pushed: the developer pushes when ready (pushing usually updates a connected Shopify theme).
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { candidatePaths, sessionBase, sessionCfg, sessionCommit } from "./context.ts";
import { Lock } from "./lock.ts";
import { git, gitText, gitOk, readCommitFiles } from "./git.ts";
import { gitWrite } from "./gitwrite.ts";
import { previewDrift, incompleteTxns, fault } from "./publish.ts";
import { verify, conflicts } from "./commands.ts";
import { syncReport } from "./serve.ts";
import { lastThemeCheck, previewDigest } from "./themecheck.ts";
import type { Hash, State } from "./store.ts";
import { canonicalize, nowIso, sha256 } from "./util.ts";

export interface LandFile {
  path: string;
  change: "added" | "modified" | "deleted";
  by: string[];
}

export interface LandResult {
  branch: string;
  base: string;
  files: LandFile[];
  blockers: string[];
  warnings: string[];
  commit?: string;
  recorded?: "landed" | "recovered";
  next?: string[];
}

function repoBranch(repo: string): string | null {
  try {
    const b = gitText(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b === "HEAD" ? null : b;
  } catch {
    return null;
  }
}

function branchTip(repo: string, branch: string): string | null {
  try {
    return gitText(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  } catch {
    return null;
  }
}

/** Does this commit contain exactly the preview (theme folders, compared as MASP compares)? */
function commitMatchesPreview(ctx: Ctx, state: State, commit: string): boolean {
  const files = readCommitFiles(ctx.cfg.repo, commit, ctx.cfg.themeDirs);
  const seen = new Set<string>();
  for (const [p, raw] of files) {
    if (state.preview[p] !== sha256(canonicalize(raw))) return false;
    seen.add(p);
  }
  return Object.keys(state.preview).every((p) => seen.has(p));
}

function changedFiles(state: State): LandFile[] {
  const out: LandFile[] = [];
  for (const p of [...new Set([...Object.keys(state.baseTree), ...Object.keys(state.preview)])].sort()) {
    const b = state.baseTree[p] ?? null;
    const v = state.preview[p] ?? null;
    if (b === v) continue;
    const prov = state.provenance[p];
    out.push({ path: p, change: b === null ? "added" : v === null ? "deleted" : "modified", by: prov?.contributors ?? (prov ? [prov.session] : ["?"]) });
  }
  return out;
}

function recordLanding(ctx: Ctx, state: State, commit: string, branch: string, message: string, files: number): void {
  const old = state.baseCommit;
  // Sessions that started from the old commit keep comparing against it until they resync.
  if (Object.values(state.sessions).some((ss) => sessionCommit(state, ss) === old)) {
    state.trees = { ...(state.trees ?? {}), [old]: state.baseTree };
  }
  for (const ss of Object.values(state.sessions)) ss.baseCommit ??= old;
  state.baseCommit = commit;
  state.baseTree = { ...state.preview };
  state.landed = [...(state.landed ?? []), { commit, parent: old, branch, at: nowIso(), message, files }];
  ctx.store.writeState(state);
  ctx.store.appendJournal({ txn: `land-${commit.slice(0, 12)}`, phase: "commit", kind: "land", branch, parent: old, commit, files });
}

export function land(ctx: Ctx, opts: { message?: string; branch?: string; yes?: boolean; force?: boolean } = {}): LandResult {
  const { cfg, store } = ctx;
  const branch = opts.branch ?? cfg.landBranch;
  const run = (): LandResult => {
    const state = store.readState();
    const res: LandResult = { branch, base: state.baseCommit, files: changedFiles(state), blockers: [], warnings: [] };
    const tip = branchTip(cfg.repo, branch);
    if (!tip) {
      res.blockers.push(`branch '${branch}' does not exist in ${cfg.repo}`);
      return res;
    }
    // A previous landing that reached Git but crashed before MASP recorded it.
    if (tip !== state.baseCommit && gitOk(cfg.repo, ["merge-base", "--is-ancestor", state.baseCommit, tip])
      && gitText(cfg.repo, ["rev-parse", `${tip}^`]) === state.baseCommit && commitMatchesPreview(ctx, state, tip)) {
      if (opts.yes) {
        // Finish the step the crash interrupted: bring the main checkout from the old commit to the new one.
        if (repoBranch(cfg.repo) === branch) {
          try {
            gitWrite(cfg.repo, ["read-tree", "-m", "-u", state.baseCommit, tip]);
          } catch (e) {
            res.warnings.push(`could not update the '${branch}' checkout files (${(e as Error).message.split("\n")[0]}); check 'git status' in ${cfg.repo}`);
          }
        }
        recordLanding(ctx, state, tip, branch, gitText(cfg.repo, ["log", "-1", "--format=%s", tip]), res.files.length);
        res.commit = tip;
        res.recorded = "recovered";
      } else res.warnings.push(`commit ${tip.slice(0, 10)} on '${branch}' is an earlier landing that was not recorded; run 'masp land --yes' to record it`);
      return res;
    }

    if (state.needsReconciliation) res.blockers.push(`the preview needs reconciliation: ${state.needsReconciliation.reason}`);
    if (incompleteTxns(ctx).length) res.blockers.push("an interrupted publish must be recovered first ('masp recover')");
    const drift = previewDrift(ctx, state);
    if (drift.length) res.blockers.push(`${drift.length} preview file(s) were changed outside MASP ('masp verify'); what you reviewed may not be what MASP would commit`);
    for (const i of verify(ctx).issues.filter((x) => x.severity === "error")) res.blockers.push(`${i.path}: ${i.message}`);
    if (tip !== state.baseCommit) {
      let log = "";
      try { log = gitText(cfg.repo, ["log", "--oneline", "-5", `${state.baseCommit}..${tip}`]); } catch { /* unrelated history */ }
      res.blockers.push(`'${branch}' has moved since the preview was built (it is at ${tip.slice(0, 10)}, the preview is based on ${state.baseCommit.slice(0, 10)}). ` +
        `Landing now could overwrite those commits, so MASP refuses.${log ? ` New commits:\n      ${log.split("\n").join("\n      ")}` : ""}`);
    }
    const checkedOut = repoBranch(cfg.repo) === branch;
    if (checkedOut) {
      const dirty = git(cfg.repo, ["status", "--porcelain", "--untracked-files=no"]).toString("utf8").trim();
      if (dirty) res.blockers.push(`the '${branch}' checkout in ${cfg.repo} has uncommitted changes; commit or stash them first`);
    }
    const sync = syncReport(ctx, state);
    if (sync.failed.length) {
      const msg = `Shopify rejected ${sync.failed.map((f) => f.path).join(", ")}: the Shopify preview you reviewed does not show these versions`;
      if (opts.force) res.warnings.push(msg); else res.blockers.push(`${msg} (fix them, or add --force)`);
    }
    if (sync.pending.length) res.warnings.push(`${sync.pending.length} publish(es) not confirmed uploaded yet (${sync.pending.slice(0, 3).map((p) => p.path).join(", ")}); you may not have seen them in the Shopify preview`);
    if (!sync.startedAt) res.warnings.push("upload tracking is off ('masp serve'); MASP cannot confirm the Shopify preview showed these versions");
    const c = conflicts(ctx);
    if (c.conflicts.length) res.warnings.push(`${c.conflicts.length} blocked change(s) are NOT in the preview and will not be landed: ${c.conflicts.map((x) => `${x.session}:${x.path}`).join(", ")}`);
    for (const s of cfg.sessions) {
      const ss = state.sessions[s.id];
      if (!ss) continue;
      const source = ctx.scanner.scan(cfg, s.worktree);
      const pending = candidatePaths(state, ss, source).filter((p) => (source.get(p) ?? null) !== sessionBase(state, ss, p));
      if (pending.length) res.warnings.push(`session ${s.id} has ${pending.length} unpublished change(s) that will not be landed: ${pending.slice(0, 4).join(", ")}`);
    }
    const tc = lastThemeCheck(ctx);
    if (!tc || tc.previewDigest !== previewDigest(state)) res.warnings.push("Theme Check has not been run on this exact preview ('masp check')");
    if (!res.files.length) res.blockers.push("nothing to land: the preview is identical to the base commit");
    if (res.blockers.length || !opts.yes) return res;

    // ---- commit (temporary index; the main checkout is only touched by a clean fast-forward at the end)
    const base = state.baseCommit;
    const tmp = store.p("tmp", `land-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    try {
      gitWrite(cfg.repo, ["read-tree", base], { env });
      const modes = new Map<string, string>();
      for (const rec of git(cfg.repo, ["ls-tree", "-r", "-z", "--full-tree", base]).toString("utf8").split("\0")) {
        if (!rec) continue;
        const tab = rec.indexOf("\t");
        modes.set(rec.slice(tab + 1), rec.slice(0, tab).split(" ")[0]);
      }
      const writes = res.files.filter((f) => f.change !== "deleted");
      const blobFiles = writes.map((f, i) => {
        const fp = path.join(tmp, `blob-${i}`);
        fs.writeFileSync(fp, store.getBlob(state.preview[f.path]));
        return fp;
      });
      const shas = blobFiles.length
        ? gitWrite(cfg.repo, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: blobFiles.join("\n") + "\n" }).split(/\r?\n/)
        : [];
      const info = [
        ...writes.map((f, i) => `${modes.get(f.path) ?? "100644"} ${shas[i]}\t${f.path}`),
        ...res.files.filter((f) => f.change === "deleted").map((f) => `0 ${"0".repeat(40)}\t${f.path}`),
      ].join("\n") + "\n";
      gitWrite(cfg.repo, ["update-index", "--index-info"], { input: info, env });
      const tree = gitWrite(cfg.repo, ["write-tree"], { env });
      const sessions = [...new Set(res.files.flatMap((f) => f.by))].filter((x) => x !== "?").sort();
      const message = `${opts.message ?? "Land reviewed preview"}\n\n` +
        `Landed by MASP from the reviewed preview (base ${base.slice(0, 10)}).\n` +
        `Sessions: ${sessions.join(", ") || "-"}\n` +
        res.files.map((f) => `  ${f.change.padEnd(8)} ${f.path} (${f.by.join(", ")})`).join("\n") + "\n";
      const commit = gitWrite(cfg.repo, ["commit-tree", tree, "-p", base], { input: message });
      if (!commitMatchesPreview(ctx, state, commit)) throw new Error("internal check failed: the new commit does not match the preview; nothing was changed");
      // Compare-and-swap: fails if the branch moved since we looked.
      gitWrite(cfg.repo, ["update-ref", `refs/heads/${branch}`, commit, base]);
      fault("land-after-ref");
      if (checkedOut) gitWrite(cfg.repo, ["read-tree", "-m", "-u", base, commit]);
      recordLanding(ctx, state, commit, branch, opts.message ?? "Land reviewed preview", res.files.length);
      res.commit = commit;
      res.recorded = "landed";
      res.next = [
        `Review the commit:  git -C "${cfg.repo}" show --stat ${commit.slice(0, 10)}`,
        `Push when ready:    git -C "${cfg.repo}" push origin ${branch}   (this may update a Shopify theme connected to '${branch}')`,
        `Move finished sessions onto it:  masp resync --session <id> --yes`,
      ];
      return res;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
  if (!opts.yes) return run();
  const lock = Lock.acquire(store.p("lock"), "land");
  try {
    return run();
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- resync

export interface ResyncResult {
  session: string;
  from: string;
  to: string;
  blockers: string[];
  done: boolean;
}

export function resync(ctx: Ctx, opts: { session: string; yes?: boolean }): ResyncResult {
  const { cfg, store } = ctx;
  const s = sessionCfg(ctx, opts.session);
  const run = (): ResyncResult => {
    const state = store.readState();
    const ss = state.sessions[s.id];
    if (!ss) throw new Error(`session ${s.id} is not registered`);
    const from = sessionCommit(state, ss);
    const res: ResyncResult = { session: s.id, from, to: state.baseCommit, blockers: [], done: false };
    if (from === state.baseCommit) {
      res.blockers.push("already on the latest landed commit");
      return res;
    }
    let head = "";
    try { head = gitText(s.worktree, ["rev-parse", "HEAD"]); } catch (e) { res.blockers.push(`cannot read the worktree: ${(e as Error).message}`); }
    if (head && head !== from) res.blockers.push(`the session branch has commits of its own (HEAD ${head.slice(0, 10)}, expected ${from.slice(0, 10)}); resync would discard them`);
    const source = ctx.scanner.scan(cfg, s.worktree);
    const pending = candidatePaths(state, ss, source).filter((p) => (source.get(p) ?? null) !== sessionBase(state, ss, p));
    if (pending.length) res.blockers.push(`unpublished changes would be lost: ${pending.join(", ")} (publish or discard them first)`);
    for (const c of Object.values(state.conflicts)) if (c.session === s.id) res.blockers.push(`open conflict on ${c.path}; resolve it first`);
    // Anything that differs between the preview and the last landed commit was published after that
    // landing. If this session contributed to it, its worktree is the only other copy: land first.
    for (const p of new Set([...Object.keys(state.preview), ...Object.keys(state.baseTree)])) {
      if ((state.preview[p] ?? null) === (state.baseTree[p] ?? null)) continue;
      const prov = state.provenance[p];
      if (prov && (prov.contributors ?? [prov.session]).includes(s.id))
        res.blockers.push(`${p} has changes from this session that are not on '${cfg.landBranch}' yet; land first`);
    }
    // Tracked files outside the theme folders would be reset too.
    for (const line of git(s.worktree, ["status", "--porcelain", "--untracked-files=no"]).toString("utf8").split("\n")) {
      const p = line.slice(3).trim();
      if (p && !cfg.themeDirs.includes(p.split("/")[0])) res.blockers.push(`changed file outside the theme folders would be lost: ${p}`);
    }
    if (res.blockers.length || !opts.yes) return res;

    gitWrite(s.worktree, ["reset", "--hard", state.baseCommit]);
    state.sessions[s.id] = { ...ss, baseCommit: state.baseCommit, headAtStart: state.baseCommit, base: {}, held: {}, pendingReady: [], warnings: [] };
    // Forget old base trees nobody uses any more.
    for (const c of Object.keys(state.trees ?? {}))
      if (!Object.values(state.sessions).some((x) => sessionCommit(state, x) === c)) delete state.trees![c];
    store.writeState(state);
    store.appendJournal({ txn: `resync-${s.id}-${state.baseCommit.slice(0, 12)}`, phase: "commit", kind: "resync", session: s.id, from, to: state.baseCommit });
    res.done = true;
    return res;
  };
  if (!opts.yes) return run();
  const lock = Lock.acquire(store.p("lock"), "resync");
  try {
    return run();
  } finally {
    lock.release();
  }
}
