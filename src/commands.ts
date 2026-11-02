import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Ctx } from "./context.ts";
import { candidatePaths, sessionBase, sessionCfg, sessionTree } from "./context.ts";
import { classify, isThemePath } from "./config.ts";
import { Lock, lockHolder, type LockInfo } from "./lock.ts";
import { gitText, headCommit, readCommitFiles } from "./git.ts";
import type { State, Hash } from "./store.ts";
import { integrateOnce, processReady, registerSessions, writeReadyRequest, type ReadyRequest, type PassResult, type CheckpointRecord } from "./engine.ts";
import { activeSessionIds, checkScope } from "./plan.ts";
import { incompleteTxns, previewDrift, recoverTxns, previewPath, type RecoveryReport } from "./publish.ts";
import { checkChangeSet, type Issue } from "./validate.ts";
import { syncLevel, syncReport } from "./serve.ts";
import { runThemeCheck, themeCheckLevel, lastThemeCheck, previewDigest, quickCheck, type ThemeCheckResult } from "./themecheck.ts";
import { atomicWriteFile, canonicalize, newId, nowIso, sleep, toPosix, withRetry } from "./util.ts";

function withLock<T>(ctx: Ctx, command: string, fn: () => T): T {
  ctx.store.ensure();
  const lock = Lock.acquire(ctx.store.p("lock"), command);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

async function withLockAsync<T>(ctx: Ctx, command: string, fn: () => Promise<T>): Promise<T> {
  ctx.store.ensure();
  const lock = Lock.acquire(ctx.store.p("lock"), command);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- init

export function init(ctx: Ctx, opts: { base?: string } = {}) {
  const { cfg, store } = ctx;
  if (store.hasState()) throw new Error(`already initialised (${store.p("state.json")})`);
  return withLock(ctx, "init", () => {
    const baseCommit = opts.base ? gitText(cfg.repo, ["rev-parse", `${opts.base}^{commit}`]) : headCommit(cfg.repo);
    if (fs.existsSync(cfg.preview) && fs.readdirSync(cfg.preview).length > 0)
      throw new Error(`preview folder ${cfg.preview} already exists and is not empty; MASP will not overwrite it`);
    const files = readCommitFiles(cfg.repo, baseCommit, cfg.themeDirs);
    const baseTree: Record<string, Hash> = {};
    // Build the preview in a temporary folder, then rename it into place.
    const tmp = `${cfg.preview}.masp-init-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [p, raw] of files) {
      if (!isThemePath(cfg, p)) continue;
      const buf = canonicalize(raw);
      baseTree[p] = store.putBlob(buf);
      const dst = path.join(tmp, ...p.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
    }
    fs.mkdirSync(tmp, { recursive: true });
    if (fs.existsSync(cfg.preview)) fs.rmdirSync(cfg.preview);
    withRetry(() => fs.renameSync(tmp, cfg.preview));
    const state: State = {
      version: 1, createdAt: nowIso(), baseCommit, baseTree, preview: { ...baseTree },
      provenance: {}, sessions: {}, conflicts: {}, lastTxn: null, lastPublishAt: null, needsReconciliation: null,
    };
    for (const p of Object.keys(baseTree)) state.provenance[p] = { session: "base" };
    const reg = registerSessions(ctx, state);
    store.writeState(state);
    return { baseCommit, files: Object.keys(baseTree).length, preview: cfg.preview, ...reg };
  });
}

// ---------------------------------------------------------------- integrate

export async function integrate(ctx: Ctx): Promise<PassResult> {
  if (!ctx.store.hasState()) throw new Error("not initialised; run 'masp init' first");
  return withLockAsync(ctx, "integrate", async () => {
    const cache = ctx.store.p("scan-cache.json");
    ctx.scanner.load(cache);
    const r = await integrateOnce(ctx);
    ctx.scanner.save(cache);
    return r;
  });
}

// ---------------------------------------------------------------- ready

export interface ReadyResult {
  request: ReadyRequest | null;
  note: string;
  outcome?: { outcome: string; checkpoint: string; problems: { path: string; kind: string; detail: string }[] };
}

/** Capture a session's current change set (or the listed files) as a Ready request, without queueing it. */
function buildRequest(ctx: Ctx, opts: { session: string; files?: string[]; message?: string; rebased?: string[] }): ReadyRequest | null {
  const { store } = ctx;
  const s = sessionCfg(ctx, opts.session);
  const state = store.readState();
  const ss = state.sessions[s.id];
  if (!ss) throw new Error(`session ${s.id} is not registered (check 'masp status' for the reason)`);
  ctx.scanner.load(store.p("scan-cache.json"));
  const source = ctx.scanner.scan(ctx.cfg, s.worktree);
  let changed = candidatePaths(state, ss, source).filter((p) => (source.get(p) ?? null) !== sessionBase(state, ss, p));
  if (opts.files?.length) {
    const wanted = opts.files.map((f) => toPosix(path.isAbsolute(f) ? path.relative(s.worktree, f) : f));
    const missing = wanted.filter((f) => !changed.includes(f));
    if (missing.length) throw new Error(`no change to signal for: ${missing.join(", ")}`);
    changed = wanted;
  }
  if (changed.length === 0) return null;
  const files: Record<string, Hash | null> = {};
  for (const p of changed) {
    const r = ctx.scanner.read(path.join(s.worktree, ...p.split("/")));
    files[p] = r ? store.putBlob(r.buf) : null;
  }
  let rebased: Record<string, Hash> | undefined;
  for (const spec of opts.rebased ?? []) {
    const at = spec.lastIndexOf("@");
    if (at <= 0) throw new Error(`--rebased expects path@hash (from 'masp show <path>'), got '${spec}'`);
    const p = toPosix(spec.slice(0, at));
    const prefix = spec.slice(at + 1);
    const full = state.preview[p];
    if (!(p in files)) throw new Error(`--rebased ${p}: this session has no change to that file`);
    if (!full || prefix.length < 8 || !full.startsWith(prefix))
      throw new Error(`--rebased ${p}: ${prefix} is not the current preview version (run 'masp show ${p}' again)`);
    (rebased ??= {})[p] = full;
  }
  return { id: `${newId("ready")}-${s.id}`, session: s.id, at: nowIso(), message: opts.message, files, rebased };
}

export async function ready(ctx: Ctx, opts: { session: string; files?: string[]; message?: string; wait?: boolean; timeoutMs?: number; rebased?: string[] }): Promise<ReadyResult> {
  const { store } = ctx;
  const req = buildRequest(ctx, opts);
  if (!req) return { request: null, note: "nothing to signal: this session has no unintegrated changes" };
  writeReadyRequest(ctx, req);
  if (opts.wait === false) return { request: req, note: "queued" };

  const holder = lockHolder(store.p("lock"));
  if (!holder) {
    // No controller running: integrate now in this process.
    try {
      await integrate(ctx);
    } catch (e) {
      return { request: req, note: `queued, but could not integrate now: ${(e as Error).message}` };
    }
  }
  const done = store.p("requests", "done", `${req.id}.json`);
  const deadline = Date.now() + (opts.timeoutMs ?? 120000);
  while (!fs.existsSync(done)) {
    if (Date.now() > deadline) return { request: req, note: "queued; the controller has not processed it yet (see 'masp status')" };
    await sleep(100);
  }
  const d = JSON.parse(fs.readFileSync(done, "utf8"));
  return { request: req, note: holder ? "processed by the running controller" : "processed", outcome: { outcome: d.outcome, checkpoint: d.checkpoint, problems: d.problems } };
}

/** Current preview version of one file, for a session that must merge a stale change by hand. */
export function show(ctx: Ctx, p: string): { path: string; hash: string | null; by: string | null; content: string | null } {
  const state = ctx.store.readState();
  const h = state.preview[toPosix(p)] ?? null;
  return { path: toPosix(p), hash: h, by: state.provenance[toPosix(p)]?.session ?? null, content: h ? ctx.store.getBlob(h).toString("utf8") : null };
}

/**
 * Dry run of 'masp ready': the same scope rules, merge and validation, on a throwaway copy of
 * the state. Never publishes, never queues, never changes MASP's state. Safe for sessions to run.
 */
export interface LintResult {
  result: CheckpointRecord | null;   // what 'masp ready' would do with the unintegrated changes
  note: string;
  themeCheck: { checked: string[]; offenses: ThemeCheckResult["offenses"]; skipped?: string };
  ok: boolean;
}

export function lint(ctx: Ctx, opts: { session: string; files?: string[]; rebased?: string[]; themeCheck?: boolean }): LintResult {
  const s = sessionCfg(ctx, opts.session);
  const req = buildRequest(ctx, opts);
  const state = ctx.store.readState(); // throwaway copy; never written back
  const result = req ? processReady(ctx, state, req, activeSessionIds(ctx.cfg, state), { dryRun: true }) : null;

  // Quick Theme Check on everything this session has written since the base commit, including
  // files that were already auto-published (MASP's own checks do not parse full Liquid).
  const tc: LintResult["themeCheck"] = { checked: [], offenses: [] };
  if (opts.themeCheck === false || process.env.MASP_LINT_THEME_CHECK === "0") tc.skipped = "turned off";
  else {
    const source = ctx.scanner.scan(ctx.cfg, s.worktree);
    const files: { path: string; buf: Buffer }[] = [];
    for (const [p, h] of source) {
      if (h === sessionTree(state, state.sessions[s.id])[p] || !/\.(liquid|json)$/.test(p)) continue;
      const r = ctx.scanner.read(path.join(s.worktree, ...p.split("/")));
      if (r) files.push({ path: p, buf: r.buf });
    }
    tc.checked = files.map((f) => f.path);
    const q = quickCheck(ctx, files);
    if (!q) tc.skipped = "Shopify CLI not available";
    else if (q.failure) tc.skipped = q.failure;
    else tc.offenses = q.offenses;
  }
  const tcErrors = tc.offenses.filter((o) => o.severity === "error");
  if (result && tcErrors.length) {
    for (const o of tcErrors) result.problems.push({ path: o.path, kind: "theme-check", detail: `${o.check} (line ${o.line}): ${o.message}` });
    if (result.outcome === "would-publish" || result.outcome === "noop") result.outcome = "rejected";
  }
  const readyOk = !result || result.outcome === "would-publish" || result.outcome === "noop";
  return {
    result, themeCheck: tc, ok: readyOk && tcErrors.length === 0,
    note: req ? "dry run: nothing was published" : "no unintegrated changes to signal",
  };
}

// ---------------------------------------------------------------- status

export interface SessionStatus {
  id: string;
  task?: string;
  worktree: string;
  registered: boolean;
  active: boolean;
  problem?: string;
  warnings: string[];
  files: { path: string; cls: string; state: string; detail?: string }[];
  lastCheckpoint?: string;
  uploadFailures?: { path: string; failedAt: string; message: string }[];   // Shopify rejected these published files
}

export interface StatusReport {
  initialised: boolean;
  controller: LockInfo | null;
  baseCommit?: string;
  preview: string;
  previewFiles?: number;
  lastPublishAt?: string | null;
  interrupted: string[];
  drift: { path: string; expected: string | null; actual: string | null }[];
  needsReconciliation: State["needsReconciliation"];
  levels: { localIntegration: string; localPreview: string; themeCheck: string; shopifySync: string; visualCheck: string };
  sessions: SessionStatus[];
}

export function status(ctx: Ctx): StatusReport {
  const { cfg, store } = ctx;
  const controller = lockHolder(store.p("lock"));
  if (!store.hasState()) {
    return {
      initialised: false, controller, preview: cfg.preview, interrupted: [], drift: [], needsReconciliation: null,
      levels: { localIntegration: "not initialised", localPreview: "not initialised", themeCheck: "not run", shopifySync: "not started", visualCheck: "not done" },
      sessions: [],
    };
  }
  const state = store.readState();
  const interrupted = incompleteTxns(ctx).map((t) => t.txn);
  const drift = previewDrift(ctx, state);
  const active = activeSessionIds(cfg, state);
  const sessions: SessionStatus[] = cfg.sessions.map((s) => {
    const ss = state.sessions[s.id];
    const st: SessionStatus = { id: s.id, task: s.task, worktree: s.worktree, registered: !!ss, active: active.has(s.id), warnings: ss?.warnings ?? [], files: [], lastCheckpoint: ss?.lastCheckpoint };
    if (!ss) {
      st.problem = "not registered yet (run 'masp integrate' or 'masp start' to see why)";
      return st;
    }
    const head = state.conflicts[`${s.id}:*`];
    if (head) st.problem = head.detail;
    const source = ctx.scanner.scan(cfg, s.worktree);
    for (const p of candidatePaths(state, ss, source)) {
      const src = source.get(p) ?? null;
      if (src === sessionBase(state, ss, p)) continue;
      const cls = classify(cfg, p);
      const c = state.conflicts[`${s.id}:${p}`];
      let fileState: string;
      let detail: string | undefined;
      if (c && c.sourceHash === src) { fileState = c.kind === "scope" || c.kind === "ownership" ? "blocked" : "conflict"; detail = c.detail; }
      else if (ss.held[p]) { fileState = "held"; detail = ss.held[p]; }
      else {
        const sc = checkScope(cfg, s, { path: p, cls, base: sessionBase(state, ss, p), source: src, preview: state.preview[p] ?? null }, active);
        if (!sc.ok) { fileState = "blocked"; detail = sc.reason; }
        else if (sc.needsReady) { fileState = "needs-ready"; detail = sc.why; }
        else fileState = "waiting-to-publish";
      }
      st.files.push({ path: p, cls, state: fileState, detail });
    }
    return st;
  });
  const sync = syncReport(ctx, state);
  for (const s of sessions) s.uploadFailures = sync.failed.filter((f) => f.session === s.id).map(({ path, failedAt, message }) => ({ path, failedAt, message }));
  const reconcile = state.needsReconciliation || drift.length || interrupted.length;
  return {
    initialised: true, controller, baseCommit: state.baseCommit, preview: cfg.preview,
    previewFiles: Object.keys(state.preview).length, lastPublishAt: state.lastPublishAt,
    interrupted, drift, needsReconciliation: state.needsReconciliation,
    levels: {
      localIntegration: state.lastTxn ? `last transaction ${state.lastTxn}` : "nothing integrated yet",
      localPreview: reconcile ? "OUT OF SYNC with MASP records: run 'masp recover'" : "matches MASP records",
      themeCheck: themeCheckLevel(ctx, state),
      shopifySync: syncLevel(ctx, state),
      visualCheck: "not done",
    },
    sessions,
  };
}

// ---------------------------------------------------------------- conflicts / verify / diff

export function conflicts(ctx: Ctx) {
  const state = ctx.store.readState();
  const held = Object.values(state.sessions).flatMap((ss) => Object.entries(ss.held).map(([p, why]) => ({ session: ss.id, path: p, kind: "held", detail: why })));
  return { conflicts: Object.values(state.conflicts), held };
}

export function verify(ctx: Ctx): { drift: ReturnType<typeof previewDrift>; issues: Issue[] } {
  const state = ctx.store.readState();
  const drift = previewDrift(ctx, state);
  const tree = {
    has: (p: string) => p in state.preview,
    read: (p: string) => ctx.store.getBlob(state.preview[p]),
    hash: (p: string) => state.preview[p] ?? null,
    paths: () => Object.keys(state.preview),
  };
  return { drift, issues: [...themeCompleteness(Object.keys(state.preview)), ...checkChangeSet(tree, Object.keys(state.preview), [])] };
}

/** Files a Shopify theme needs before 'shopify theme dev' can serve it. */
export function themeCompleteness(paths: string[]): Issue[] {
  const issues: Issue[] = [];
  const has = new Set(paths);
  for (const p of ["layout/theme.liquid", "config/settings_schema.json"])
    if (!has.has(p)) issues.push({ severity: "error", path: p, message: "required theme file is missing from the preview" });
  if (!paths.some((p) => /^templates\/index\.(json|liquid)$/.test(p)))
    issues.push({ severity: "error", path: "templates/index.json", message: "the preview has no home page template" });
  if (!has.has("config/settings_data.json")) issues.push({ severity: "warning", path: "config/settings_data.json", message: "missing; theme settings will use defaults" });
  if (!paths.some((p) => /^locales\/[^/]+\.default\.json$/.test(p)))
    issues.push({ severity: "warning", path: "locales/", message: "no default locale file (locales/*.default.json)" });
  return issues;
}

export function diff(ctx: Ctx, opts: { patch?: boolean } = {}) {
  const state = ctx.store.readState();
  const rows: { path: string; change: "added" | "modified" | "deleted"; by: string; checkpoint?: string; at?: string }[] = [];
  const all = new Set([...Object.keys(state.baseTree), ...Object.keys(state.preview)]);
  for (const p of [...all].sort()) {
    const b = state.baseTree[p] ?? null;
    const v = state.preview[p] ?? null;
    if (b === v) continue;
    const prov = state.provenance[p];
    rows.push({ path: p, change: b === null ? "added" : v === null ? "deleted" : "modified", by: prov?.session ?? "?", checkpoint: prov?.checkpoint, at: prov?.at });
  }
  let patch = "";
  if (opts.patch && rows.length) {
    const tmp = ctx.store.p("tmp", `diff-${process.pid}`);
    const write = (side: string, p: string, h: string | null) => {
      const f = path.join(tmp, side, ...p.split("/"));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (h) fs.writeFileSync(f, ctx.store.getBlob(h));
    };
    for (const r of rows) {
      write("base", r.path, state.baseTree[r.path] ?? null);
      write("preview", r.path, state.preview[r.path] ?? null);
    }
    // git diff --no-index is read-only and works outside a repository.
    const res = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "base", "preview"], { cwd: tmp, encoding: "utf8" });
    patch = res.stdout;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { baseCommit: state.baseCommit, rows, patch };
}

// ---------------------------------------------------------------- recover

export interface RecoverResult {
  transactions: RecoveryReport[];
  restored: { path: string; savedOutsideVersion: string | null }[];
  reportFile?: string;
  remaining: string | null;
}

export function recover(ctx: Ctx, opts: { restorePreview?: boolean } = {}): RecoverResult {
  return withLock(ctx, "recover", () => {
    const { store } = ctx;
    const state = store.readState();
    const transactions = recoverTxns(ctx, state);
    const restored: RecoverResult["restored"] = [];
    let reportFile: string | undefined;
    const drift = previewDrift(ctx, state);
    if (opts.restorePreview && (drift.length || state.needsReconciliation)) {
      // Keep a copy of every outside version before putting MASP's version back.
      for (const d of drift) {
        let saved: string | null = null;
        if (d.actual !== null) {
          const r = ctx.scanner.read(previewPath(ctx, d.path));
          if (r) saved = store.putBlob(r.buf);
        }
        const dst = previewPath(ctx, d.path);
        if (d.expected === null) withRetry(() => fs.rmSync(dst, { force: true }));
        else {
          const tmp = store.p("staging", `restore-${process.pid}-${restored.length}`);
          fs.writeFileSync(tmp, store.getBlob(d.expected));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          withRetry(() => fs.renameSync(tmp, dst));
        }
        restored.push({ path: d.path, savedOutsideVersion: saved });
      }
      for (const t of incompleteTxns(ctx)) store.appendJournal({ txn: t.txn, phase: "recovered", result: "preview-restored-to-manifest" });
      reportFile = store.p(`reconcile-${newId("r")}.json`);
      atomicWriteFile(reportFile, JSON.stringify({ at: nowIso(), previous: state.needsReconciliation, restored }, null, 1));
      state.needsReconciliation = null;
      store.writeState(state);
    } else if (!state.needsReconciliation && drift.length) {
      state.needsReconciliation = { reason: `${drift.length} preview file(s) were changed outside MASP`, at: nowIso(), details: { drift } };
      store.writeState(state);
    }
    return { transactions, restored, reportFile, remaining: state.needsReconciliation?.reason ?? null };
  });
}

// ---------------------------------------------------------------- stop / preview

export async function stop(ctx: Ctx, timeoutMs = 20000): Promise<{ wasRunning: boolean; stopped: boolean }> {
  const holder = lockHolder(ctx.store.p("lock"));
  if (!holder || holder.command !== "start") return { wasRunning: false, stopped: true };
  atomicWriteFile(ctx.store.p("control", "stop"), JSON.stringify({ at: nowIso(), by: process.pid }));
  const deadline = Date.now() + timeoutMs;
  while (lockHolder(ctx.store.p("lock"))) {
    if (Date.now() > deadline) return { wasRunning: true, stopped: false };
    await sleep(100);
  }
  return { wasRunning: true, stopped: true };
}


export interface PreviewPreflight {
  ready: boolean;
  blockers: string[];
  notes: string[];
  command: string;
}

/** Checks before the single 'shopify theme dev' is started on the preview. Prints; never runs it. */
export function previewCommand(ctx: Ctx): PreviewPreflight {
  const blockers: string[] = [];
  const notes: string[] = [];
  if (!ctx.store.hasState()) blockers.push("not initialised: run 'masp init'");
  else {
    const state = ctx.store.readState();
    const v = verify(ctx);
    if (state.needsReconciliation) blockers.push(`preview needs reconciliation: ${state.needsReconciliation.reason}`);
    if (v.drift.length) blockers.push(`${v.drift.length} preview file(s) changed outside MASP ('masp verify')`);
    if (incompleteTxns(ctx).length) blockers.push("an interrupted publish must be recovered first ('masp recover')");
    for (const i of v.issues.filter((x) => x.severity === "error")) blockers.push(`${i.path}: ${i.message}`);
    const tc = lastThemeCheck(ctx);
    if (!tc) notes.push("Theme Check has not been run on the preview ('masp check').");
    else if (tc.failure) notes.push(`Theme Check could not run: ${tc.failure.slice(0, 150)}`);
    else if (tc.previewDigest !== previewDigest(state) || !tc.consistent) notes.push("The last Theme Check result is outdated ('masp check').");
    else if (tc.errorCount) notes.push(`Theme Check reported ${tc.errorCount} error(s) on the current preview ('masp check').`);
  }
  for (const f of [".theme-check.yml", ".shopifyignore"])
    if (fs.existsSync(path.join(ctx.cfg.preview, f))) notes.push(`The preview folder contains ${f}; MASP did not put it there.`);
  return {
    ready: blockers.length === 0,
    blockers,
    notes,
    command: `shopify theme dev --path "${ctx.cfg.preview}" --store <your-development-store> --port 9292`,
  };
}

export const PREVIEW_RULES = [
  "Run it yourself, once, against a DEVELOPMENT store. MASP never starts it or logs in.",
  "Leave out --theme: Shopify then creates a separate development theme instead of using an existing one.",
  "Never add --theme-editor-sync (it writes Theme Editor changes into the preview, which MASP treats as",
  "  outside edits and stops publishing), --allow-live, or --reconciliation-strategy.",
  "Never run 'shopify theme push', 'theme publish', or 'theme check --auto-correct' on the preview folder.",
  "MASP cannot see what the CLI uploads: watch its terminal for upload errors.",
];

export function themeCheck(ctx: Ctx): ThemeCheckResult {
  if (!ctx.store.hasState()) throw new Error("not initialised; run 'masp init' first");
  return runThemeCheck(ctx);
}
