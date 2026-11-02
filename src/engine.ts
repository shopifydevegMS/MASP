// One integration pass: register sessions, check the preview, process Ready signals,
// then auto-publish eligible independent files. Callers must hold the writer lock.
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { candidatePaths, sessionBase, sessionCfg } from "./context.ts";
import { classify, type SessionConfig } from "./config.ts";
import { activeSessionIds, checkScope, threeWay, type Change } from "./plan.ts";
import { publish, previewDrift, recoverTxns, type RecoveryReport } from "./publish.ts";
import type { ConflictRecord, Hash, Op, SessionState, State } from "./store.ts";
import { checkChangeSet, type Issue, type TreeView } from "./validate.ts";
import { isMergeablePath, mergeTemplate } from "./jsonmerge.ts";
import { commonDir, headCommit, isAncestor } from "./git.ts";
import { atomicWriteFile, newId, nowIso, sleep } from "./util.ts";

export interface ReadyRequest {
  id: string;
  session: string;
  at: string;
  message?: string;
  files: Record<string, Hash | null>; // captured source snapshot of the change set
  /** path -> preview version the session reviewed and merged by hand (masp show + --rebased). */
  rebased?: Record<string, Hash>;
}

export interface CheckpointRecord {
  id: string;
  session: string;
  kind: "auto" | "ready";
  request?: string;
  message?: string;
  at: string;
  outcome: "published" | "rejected" | "noop" | "failed" | "would-publish";
  txn?: string;
  files: { path: string; base: Hash | null; source: Hash | null; preview: Hash | null; action: string }[];
  problems: { path: string; kind: string; detail: string }[];
  integratedAt?: string;
  latencyMs?: number;
}

export interface PassResult {
  refused?: string;
  unstableSessions: string[];
  recovered: RecoveryReport[];
  checkpoints: CheckpointRecord[];
  unstable: number;
  registered: string[];
  registrationErrors: Record<string, string>;
}

// ---------------------------------------------------------------- helpers

function sameDir(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function registerSessions(ctx: Ctx, state: State): { registered: string[]; errors: Record<string, string> } {
  const registered: string[] = [];
  const errors: Record<string, string> = {};
  let repoCommon: string | null = null;
  for (const s of ctx.cfg.sessions) {
    if (state.sessions[s.id]) continue;
    try {
      if (!fs.existsSync(s.worktree)) throw new Error(`worktree ${s.worktree} does not exist`);
      repoCommon ??= commonDir(ctx.cfg.repo);
      if (!sameDir(commonDir(s.worktree), repoCommon)) throw new Error(`worktree ${s.worktree} belongs to a different repository`);
      const head = headCommit(s.worktree);
      if (head !== state.baseCommit)
        throw new Error(`worktree HEAD ${head.slice(0, 10)} differs from the preview base ${state.baseCommit.slice(0, 10)}; v1 requires every session to start from the same commit`);
      state.sessions[s.id] = {
        id: s.id, registeredAt: nowIso(), headAtStart: head, baseCommit: state.baseCommit, base: {}, held: {}, pendingReady: [], warnings: [],
      };
      registered.push(s.id);
    } catch (e) {
      errors[s.id] = (e as Error).message;
    }
  }
  return { registered, errors };
}

/** Is the session's HEAD still comparable with the preview base? */
function headProblem(ctx: Ctx, state: State, s: SessionConfig, ss: SessionState): string | null {
  ss.warnings = ss.warnings.filter((w) => !w.startsWith("HEAD"));
  let head: string;
  try {
    head = headCommit(s.worktree);
  } catch (e) {
    return `cannot read worktree HEAD: ${(e as Error).message}`;
  }
  const start = ss.baseCommit ?? state.baseCommit;
  if (head === start) return null;
  if (isAncestor(s.worktree, start, head)) {
    ss.warnings.push(`HEAD moved to ${head.slice(0, 10)} (on top of the base commit). Files are compared by content, so this is fine.`);
    return null;
  }
  return `worktree HEAD ${head.slice(0, 10)} is not based on this session's start commit ${start.slice(0, 10)} (branch switched, reset or rebased); its files cannot be compared safely`;
}

function treeView(ctx: Ctx, state: State, ops: Op[]): TreeView {
  const overlay = new Map<string, Hash | null>(ops.map((o) => [o.path, o.after]));
  const cur = (p: string): Hash | null => (overlay.has(p) ? overlay.get(p)! : state.preview[p] ?? null);
  return {
    has: (p) => cur(p) !== null,
    read: (p) => ctx.store.getBlob(cur(p)!),
    hash: (p) => cur(p),
    paths: () => {
      const all = new Set(Object.keys(state.preview));
      for (const [p, h] of overlay) h === null ? all.delete(p) : all.add(p);
      return [...all];
    },
  };
}

function errorsOf(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity === "error");
}

function setConflict(state: State, rec: Omit<ConflictRecord, "at">): void {
  state.conflicts[`${rec.session}:${rec.path}`] = { ...rec, at: nowIso() };
}

function clearConflict(state: State, session: string, p: string): void {
  delete state.conflicts[`${session}:${p}`];
}

/** Record that a session's version is now what the preview holds. */
interface Integrated {
  path: string;
  after: Hash | null;      // what the preview holds now
  source?: Hash | null;    // the session's own version, if different (after a merge)
  converged?: boolean;     // preview already held this; nothing was published
}

function markIntegrated(state: State, session: string, ops: Integrated[], checkpoint: string, txn?: string): void {
  const ss = state.sessions[session];
  const at = nowIso();
  for (const op of ops) {
    // The session's base is ITS version, not the merged one; otherwise the next comparison
    // would read the other sessions' sections as deletions by this session.
    ss.base[op.path] = op.source !== undefined ? op.source : op.after;
    const merged = op.source !== undefined && op.source !== op.after;
    const prev = state.provenance[op.path];
    const contributors = merged
      ? [...new Set([...(prev?.contributors ?? (prev && prev.session !== "base" ? [prev.session] : [])), session])]
      : [session];
    if (op.after === null) delete state.preview[op.path];
    else state.preview[op.path] = op.after;
    if (!op.converged) state.provenance[op.path] = { session, contributors, merged: merged || undefined, checkpoint, txn, at };
    clearConflict(state, session, op.path);
    delete ss.held[op.path];
  }
  ss.lastCheckpoint = checkpoint;
}

/** Read the file now, store its snapshot, and confirm it is the version we planned with. */
function capture(ctx: Ctx, abs: string, expected: Hash): boolean {
  const r = ctx.scanner.read(abs);
  if (!r || r.hash !== expected) return false;
  ctx.store.putBlob(r.buf);
  return true;
}

function abs(s: SessionConfig, p: string): string {
  return path.join(s.worktree, ...p.split("/"));
}

// ---------------------------------------------------------------- Ready signals

export function writeReadyRequest(ctx: Ctx, req: ReadyRequest): string {
  const f = ctx.store.p("requests", `${req.id}.json`);
  atomicWriteFile(f, JSON.stringify(req, null, 1));
  return f;
}

function listRequests(ctx: Ctx): ReadyRequest[] {
  const dir = ctx.store.p("requests");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ReadyRequest);
}

function finishRequest(ctx: Ctx, req: ReadyRequest, cp: CheckpointRecord): void {
  const done = ctx.store.p("requests", "done", `${req.id}.json`);
  atomicWriteFile(done, JSON.stringify({ ...req, checkpoint: cp.id, outcome: cp.outcome, problems: cp.problems }, null, 1));
  fs.rmSync(ctx.store.p("requests", `${req.id}.json`), { force: true });
}

/**
 * Plan and (unless dryRun) publish one Ready change set. With dryRun the caller passes a throwaway
 * copy of the state: every check runs exactly as for a real Ready, but nothing is published or saved.
 */
export function processReady(ctx: Ctx, state: State, req: ReadyRequest, active: Set<string>, opts: { dryRun?: boolean } = {}): CheckpointRecord {
  const cp: CheckpointRecord = {
    id: newId(`cp-${req.session}`), session: req.session, kind: "ready", request: req.id, message: req.message,
    at: nowIso(), outcome: "rejected", files: [], problems: [],
  };
  const reject = (p: string, kind: string, detail: string, source: Hash | null = null) => {
    cp.problems.push({ path: p, kind, detail });
    if (p !== "*") setConflict(state, { session: req.session, path: p, kind, detail, sourceHash: source, checkpoint: cp.id });
  };
  let s: SessionConfig;
  try {
    s = sessionCfg(ctx, req.session);
  } catch (e) {
    reject("*", "session", (e as Error).message);
    return cp;
  }
  const ss = state.sessions[req.session];
  if (!ss || !active.has(req.session)) {
    reject("*", "session", `session ${req.session} is not registered or not active`);
    return cp;
  }
  const head = headProblem(ctx, state, s, ss);
  if (head) {
    reject("*", "head", head);
    return cp;
  }
  // The controller verifies the snapshot itself: files must still match what was signalled.
  for (const [p, h] of Object.entries(req.files)) {
    clearConflict(state, req.session, p);
    const now = ctx.scanner.read(abs(s, p));
    const nowHash = now ? now.hash : null;
    if (nowHash !== h) reject(p, "changed-after-ready", `${p} changed after 'masp ready'; signal again when it is finished`, nowHash);
    else if (now) ctx.store.putBlob(now.buf);
  }
  if (cp.problems.length) return cp;

  const ops: Op[] = [];
  const converged: Integrated[] = [];
  const sources = new Map<string, Hash | null>();
  for (const [p, source] of Object.entries(req.files)) {
    let base = sessionBase(state, ss, p);
    const reviewed = req.rebased?.[p];
    if (reviewed !== undefined) {
      if ((state.preview[p] ?? null) !== reviewed) {
        reject(p, "stale", `${p}: the preview changed again after you reviewed version ${reviewed.slice(0, 12)}; run 'masp show ${p}' and merge again`, source);
        continue;
      }
      base = reviewed; // the session declares its version is built on the current preview version
    }
    const ch: Change = { path: p, cls: classify(ctx.cfg, p), base, source, preview: state.preview[p] ?? null };
    if (ch.source === ch.base) continue;
    const scope = checkScope(ctx.cfg, s, ch, active);
    if (!scope.ok) {
      reject(p, scope.code, scope.reason, source);
      cp.files.push({ ...ch, action: "blocked" });
      continue;
    }
    const m = threeWay(state, ch);
    if (m.kind === "conflict" && isMergeablePath(p) && ch.base && ch.source && ch.preview) {
      // Phase 2: structured merge of templates and section groups.
      const last = state.provenance[p]?.session;
      const blob = (h: Hash) => ctx.store.getBlob(h).toString("utf8");
      const r = mergeTemplate(blob(ch.base), blob(ch.source), blob(ch.preview), { samePosition: ctx.cfg.jsonSamePosition, other: last && last !== "base" ? `the preview (last published by session ${last})` : "the preview" });
      if (!r.ok) {
        reject(p, "conflict", `${p}: ${r.reason}`, source);
        cp.files.push({ ...ch, action: "blocked" });
        continue;
      }
      const mergedHash = r.converged ? ch.preview : ctx.store.putBlob(Buffer.from(r.text, "utf8"));
      if (mergedHash === ch.preview) {
        converged.push({ path: p, after: ch.preview, source, converged: true });
        cp.files.push({ ...ch, action: "converged" });
      } else {
        ops.push({ path: p, before: ch.preview, after: mergedHash });
        sources.set(p, source);
        cp.files.push({ ...ch, action: `merge (${r.changes.join("; ")})` });
      }
      continue;
    }
    if (m.kind === "conflict") {
      reject(p, m.code, m.reason, source);
      cp.files.push({ ...ch, action: "blocked" });
    } else if (m.kind === "converged") {
      converged.push({ path: p, after: source, converged: true });
      cp.files.push({ ...ch, action: "converged" });
    } else {
      ops.push({ path: p, before: ch.preview, after: source });
      cp.files.push({ ...ch, action: source === null ? "delete" : ch.preview === null ? "add" : "modify" });
    }
  }
  if (cp.problems.length) return cp; // a Ready change set is all-or-nothing

  const issues = checkChangeSet(treeView(ctx, state, ops), ops.filter((o) => o.after).map((o) => o.path), ops.filter((o) => !o.after).map((o) => o.path));
  for (const i of errorsOf(issues)) reject(i.path, i.message.startsWith("missing dependency") || i.message.startsWith("cannot delete") ? "dependency" : "validation", i.message, req.files[i.path] ?? null);
  for (const i of issues.filter((x) => x.severity === "warning")) cp.problems.push({ path: i.path, kind: "warning", detail: i.message });
  if (errorsOf(issues).length) return cp;

  if (opts.dryRun) {
    cp.outcome = ops.length ? "would-publish" : "noop";
    return cp;
  }
  if (ops.length === 0) {
    markIntegrated(state, req.session, converged, cp.id);
    cp.outcome = "noop";
    return cp;
  }
  const res = publish(ctx, state, { session: req.session, checkpoint: cp.id, kind: "ready" }, ops, (st, txn) => {
    markIntegrated(st, req.session, [...ops.map((o) => ({ path: o.path, after: o.after, source: sources.has(o.path) ? sources.get(o.path)! : o.after })), ...converged], cp.id, txn);
  });
  if (!res.ok) {
    cp.outcome = "failed";
    cp.problems.push({ path: "*", kind: "publish", detail: res.reason });
    return cp;
  }
  cp.outcome = "published";
  cp.txn = res.txn;
  cp.integratedAt = nowIso();
  cp.latencyMs = Date.parse(cp.integratedAt) - Date.parse(req.at);
  return cp;
}

// ---------------------------------------------------------------- automatic pass

function autoSession(ctx: Ctx, state: State, s: SessionConfig, active: Set<string>, stableMs: number): { cp: CheckpointRecord | null; unstable: number } {
  const ss = state.sessions[s.id];
  ss.held = {};
  ss.pendingReady = [];
  const head = headProblem(ctx, state, s, ss);
  if (head) {
    setConflict(state, { session: s.id, path: "*", kind: "head", detail: head, sourceHash: null });
    return { cp: null, unstable: 0 };
  }
  clearConflict(state, s.id, "*");

  const source = ctx.scanner.scan(ctx.cfg, s.worktree);
  const now = Date.now();
  let unstable = 0;
  const candidates: Change[] = [];
  const firstSeen = new Map<string, number>();
  for (const p of candidatePaths(state, ss, source)) {
    const ch: Change = { path: p, cls: classify(ctx.cfg, p), base: sessionBase(state, ss, p), source: source.get(p) ?? null, preview: state.preview[p] ?? null };
    const key = `${s.id}:${p}`;
    const existing = state.conflicts[key];
    if (ch.source === ch.base) {
      if (existing) clearConflict(state, s.id, p);
      ctx.seen.delete(key);
      continue;
    }
    // A recorded conflict stays until the session's version changes again.
    if (existing && existing.sourceHash === ch.source && existing.kind !== "scope" && existing.kind !== "ownership" && existing.kind !== "dependency") continue;
    if (existing) clearConflict(state, s.id, p);

    const scope = checkScope(ctx.cfg, s, ch, active);
    if (!scope.ok) {
      setConflict(state, { session: s.id, path: p, kind: scope.code, detail: scope.reason, sourceHash: ch.source });
      continue;
    }
    if (scope.needsReady) {
      ss.pendingReady.push(p);
      continue;
    }
    // Stability: same content seen for at least stableMs (catches half-written files and bursts of writes).
    const seen = ctx.seen.get(key);
    if (!seen || seen.hash !== ch.source) {
      ctx.seen.set(key, { hash: ch.source!, since: now });
      unstable++;
      continue;
    }
    if (now - seen.since < stableMs) {
      unstable++;
      continue;
    }
    firstSeen.set(p, seen.since);
    candidates.push(ch);
  }
  if (!s.autoPublish || candidates.length === 0) return { cp: null, unstable };

  const cp: CheckpointRecord = {
    id: newId(`cp-${s.id}`), session: s.id, kind: "auto", at: nowIso(), outcome: "noop", files: [], problems: [],
  };
  let ops: Op[] = [];
  const converged: Integrated[] = [];
  for (const ch of candidates) {
    const m = threeWay(state, ch);
    if (m.kind === "conflict") {
      setConflict(state, { session: s.id, path: ch.path, kind: m.code, detail: m.reason, sourceHash: ch.source, checkpoint: cp.id });
      cp.problems.push({ path: ch.path, kind: m.code, detail: m.reason });
    } else if (m.kind === "converged") converged.push({ path: ch.path, after: ch.source, converged: true });
    else if (!capture(ctx, abs(s, ch.path), ch.source!)) unstable++;
    else ops.push({ path: ch.path, before: ch.preview, after: ch.source });
  }
  // Hold back files whose checks or dependencies fail; repeat because holding one file
  // can break another file in the same set.
  for (;;) {
    const issues = errorsOf(checkChangeSet(treeView(ctx, state, ops), ops.map((o) => o.path), []));
    if (issues.length === 0) break;
    const bad = new Set(issues.map((i) => i.path));
    for (const i of issues) ss.held[i.path] = i.message;
    ops = ops.filter((o) => !bad.has(o.path));
  }
  for (const [p, why] of Object.entries(ss.held)) cp.problems.push({ path: p, kind: "held", detail: why });

  if (converged.length) markIntegrated(state, s.id, converged, cp.id);
  if (ops.length === 0) {
    if (converged.length) {
      cp.files = converged.map((c) => ({ path: c.path, base: null, source: c.after, preview: c.after, action: "converged" }));
      return { cp, unstable };
    }
    return { cp: null, unstable };
  }
  for (const o of ops) cp.files.push({ path: o.path, base: sessionBase(state, ss, o.path), source: o.after, preview: o.before, action: o.before === null ? "add" : "modify" });
  const res = publish(ctx, state, { session: s.id, checkpoint: cp.id, kind: "auto" }, ops, (st, txn) => markIntegrated(st, s.id, ops, cp.id, txn));
  if (!res.ok) {
    cp.outcome = "failed";
    cp.problems.push({ path: "*", kind: "publish", detail: res.reason });
    return { cp, unstable };
  }
  cp.outcome = "published";
  cp.txn = res.txn;
  cp.integratedAt = nowIso();
  cp.latencyMs = Date.parse(cp.integratedAt) - Math.min(...ops.map((o) => firstSeen.get(o.path) ?? Date.now()));
  for (const o of ops) ctx.seen.delete(`${s.id}:${o.path}`);
  return { cp, unstable };
}

// ---------------------------------------------------------------- the pass

/**
 * opts.sessions: only these sessions get an automatic pass (null = all). Ready requests are always processed.
 * opts.checkDrift: compare the whole preview with the manifest (every publish still verifies its own files).
 */
export function integratePass(ctx: Ctx, opts: { stableMs: number; sessions?: Set<string> | null; checkDrift?: boolean }): PassResult {
  const { store } = ctx;
  const result: PassResult = { recovered: [], checkpoints: [], unstable: 0, unstableSessions: [], registered: [], registrationErrors: {} };
  const state = store.readState();
  const loaded = JSON.stringify(state);
  const save = () => { if (JSON.stringify(state) !== loaded) store.writeState(state); };

  result.recovered = recoverTxns(ctx, state);
  if (state.needsReconciliation) {
    result.refused = `preview needs reconciliation: ${state.needsReconciliation.reason} (run 'masp recover')`;
    return result;
  }
  const reg = registerSessions(ctx, state);
  result.registered = reg.registered;
  result.registrationErrors = reg.errors;

  const drift = opts.checkDrift === false ? [] : previewDrift(ctx, state);
  if (drift.length) {
    state.needsReconciliation = { reason: `${drift.length} preview file(s) were changed outside MASP`, at: nowIso(), details: { drift } };
    store.writeState(state);
    result.refused = `${state.needsReconciliation.reason}; nothing will be published until 'masp recover' (see 'masp verify')`;
    return result;
  }

  const active = activeSessionIds(ctx.cfg, state);
  const record = (cp: CheckpointRecord) => {
    store.writeCheckpoint(cp as any);
    result.checkpoints.push(cp);
    ctx.log(`[${cp.session}] ${cp.kind} ${cp.outcome}: ${cp.files.map((f) => `${f.action} ${f.path}`).join(", ") || "-"}` +
      (cp.problems.length ? ` | ${cp.problems.map((p) => `${p.kind}: ${p.detail}`).join(" | ")}` : ""));
  };

  for (const req of listRequests(ctx)) {
    const cp = processReady(ctx, state, req, active);
    store.writeState(state);
    record(cp);
    finishRequest(ctx, req, cp);
    if (state.needsReconciliation) {
      result.refused = state.needsReconciliation.reason;
      return result;
    }
  }

  for (const s of ctx.cfg.sessions) {
    if (!active.has(s.id)) continue;
    if (opts.sessions && !opts.sessions.has(s.id)) continue;
    const { cp, unstable } = autoSession(ctx, state, s, active, opts.stableMs);
    result.unstable += unstable;
    if (unstable) result.unstableSessions.push(s.id);
    if (cp) record(cp);
    if (state.needsReconciliation) break;
  }
  save();
  return result;
}

/** One-shot integration: scan, wait for files to settle, scan again and publish. */
export async function integrateOnce(ctx: Ctx, stableMs = ctx.cfg.settleMs): Promise<PassResult> {
  const first = integratePass(ctx, { stableMs });
  if (first.refused || first.unstable === 0) return first;
  await sleep(stableMs + 10);
  const second = integratePass(ctx, { stableMs });
  return {
    ...second,
    recovered: [...first.recovered, ...second.recovered],
    checkpoints: [...first.checkpoints, ...second.checkpoints],
    registered: [...first.registered, ...second.registered],
  };
}
