// Publishing into the unified preview.
//
// Each file is replaced atomically (staged on the same volume, then renamed).
// A multi-file publish is NOT atomic: if the process dies between two renames, the
// preview briefly holds a mix. The journal records every transaction before it touches
// the preview, so `recover` can always tell which files are old, new or unexpected.
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.ts";
import type { Op, State } from "./store.ts";
import { newId, nowIso, withRetry, fsyncFile } from "./util.ts";

/** Test-only fault points, enabled with MASP_FAULT=<name>. */
export function fault(name: string): void {
  const f = process.env.MASP_FAULT;
  if (!f || f !== name) return;
  // Simulates power loss / kill: no cleanup handlers run.
  process.kill(process.pid, "SIGKILL");
}

function faultRename(i: number): void {
  const f = process.env.MASP_FAULT;
  if (f === `renamefail:${i}`) {
    const e = new Error(`EPERM: simulated locked file (fault renamefail:${i})`) as NodeJS.ErrnoException;
    e.code = "EPERM_SIMULATED";
    throw e;
  }
}

export function previewPath(ctx: Ctx, rel: string): string {
  return path.join(ctx.cfg.preview, ...rel.split("/"));
}

export function currentPreviewHash(ctx: Ctx, rel: string): string | null {
  const r = ctx.scanner.read(previewPath(ctx, rel));
  return r ? r.hash : null;
}

export interface PublishMeta {
  session: string;
  checkpoint: string;
  kind: "auto" | "ready";
}

export type PublishResult =
  | { ok: true; txn: string }
  | { ok: false; txn?: string; reason: string; reconciliationNeeded: boolean };

/** Restore one preview file to the given snapshot (null = absent). */
function restore(ctx: Ctx, stageDir: string, rel: string, h: string | null, tag: string): void {
  const dst = previewPath(ctx, rel);
  if (h === null) {
    withRetry(() => { try { fs.unlinkSync(dst); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } });
    return;
  }
  fs.mkdirSync(stageDir, { recursive: true });
  const tmp = path.join(stageDir, `restore-${tag}`);
  fs.writeFileSync(tmp, ctx.store.getBlob(h));
  fsyncFile(tmp);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  withRetry(() => fs.renameSync(tmp, dst));
}

/**
 * Apply ops to the preview, then call `commitState` to record the result in state.
 * `commitState` mutates the state object; it is written atomically after the files are in place.
 */
export function publish(ctx: Ctx, state: State, meta: PublishMeta, ops: Op[], commitState: (s: State, txn: string) => void): PublishResult {
  const { store } = ctx;
  // The preview must still hold exactly what we planned against.
  for (const op of ops) {
    const cur = currentPreviewHash(ctx, op.path);
    if (cur !== op.before)
      return { ok: false, reason: `preview file ${op.path} changed outside MASP; refusing to publish over it`, reconciliationNeeded: true };
  }
  const txn = newId("txn");
  const stageDir = store.p("staging", txn);
  store.appendJournal({ txn, phase: "begin", session: meta.session, checkpoint: meta.checkpoint, kind: meta.kind, ops });

  fs.mkdirSync(stageDir, { recursive: true });
  ops.forEach((op, i) => {
    if (op.after === null) return;
    const f = path.join(stageDir, String(i));
    fs.writeFileSync(f, store.getBlob(op.after));
    fsyncFile(f);
  });
  store.appendJournal({ txn, phase: "staged" });
  fault("staged");

  const applied: number[] = [];
  try {
    ops.forEach((op, i) => {
      faultRename(i + 1);
      const dst = previewPath(ctx, op.path);
      if (op.after !== null) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        withRetry(() => fs.renameSync(path.join(stageDir, String(i)), dst));
      } else {
        // Move instead of unlink so the file is never lost even before the snapshot is checked.
        withRetry(() => fs.renameSync(dst, path.join(stageDir, `deleted-${i}`)));
      }
      applied.push(i);
      fault(`apply:${i + 1}`);
    });
  } catch (e) {
    const error = (e as Error).message;
    const failedRestores: string[] = [];
    for (const i of [...applied].reverse()) {
      try {
        restore(ctx, stageDir, ops[i].path, ops[i].before, String(i));
      } catch (re) {
        failedRestores.push(`${ops[i].path}: ${(re as Error).message}`);
      }
    }
    if (failedRestores.length === 0) {
      store.appendJournal({ txn, phase: "rolledback", error });
      fs.rmSync(stageDir, { recursive: true, force: true });
      return { ok: false, txn, reason: `publish failed and was rolled back: ${error}`, reconciliationNeeded: false };
    }
    store.appendJournal({ txn, phase: "failed", error, failedRestores });
    state.needsReconciliation = { reason: `transaction ${txn} failed and could not be fully rolled back`, at: nowIso(), details: { error, failedRestores } };
    store.writeState(state);
    return { ok: false, txn, reason: `publish failed and rollback was incomplete: ${failedRestores.join("; ")}`, reconciliationNeeded: true };
  }

  commitState(state, txn);
  state.lastTxn = txn;
  state.lastPublishAt = nowIso();
  store.writeState(state);
  fault("after-state");
  store.appendJournal({ txn, phase: "commit" });
  fs.rmSync(stageDir, { recursive: true, force: true });
  return { ok: true, txn };
}

// ---------------------------------------------------------------- recovery

export interface RecoveryReport {
  txn: string;
  action: "completed" | "rolled-back" | "needs-reconciliation";
  reverted: string[];
  unexpected: { path: string; expectedBefore: string | null; expectedAfter: string | null; actual: string | null }[];
}

const TERMINAL = new Set(["commit", "rolledback", "recovered"]);

export function incompleteTxns(ctx: Ctx): { txn: string; ops: Op[]; session: string; checkpoint: string }[] {
  const byTxn = new Map<string, { begin: any; last: string }>();
  for (const e of ctx.store.readJournal()) {
    if (e.phase === "begin") byTxn.set(e.txn, { begin: e, last: "begin" });
    else if (byTxn.has(e.txn)) byTxn.get(e.txn)!.last = e.phase;
  }
  return [...byTxn.entries()]
    .filter(([, v]) => !TERMINAL.has(v.last))
    .map(([txn, v]) => ({ txn, ops: v.begin.ops as Op[], session: v.begin.session, checkpoint: v.begin.checkpoint }));
}

/**
 * Bring interrupted transactions to a safe end. Rolls back only when every touched file
 * is provably either the old or the new version; otherwise changes nothing and reports.
 */
export function recoverTxns(ctx: Ctx, state: State): RecoveryReport[] {
  const reports: RecoveryReport[] = [];
  for (const t of incompleteTxns(ctx)) {
    const stageDir = ctx.store.p("staging", t.txn);
    if (state.lastTxn === t.txn) {
      // Crashed after state was saved: the transaction did complete.
      ctx.store.appendJournal({ txn: t.txn, phase: "recovered", result: "completed" });
      fs.rmSync(stageDir, { recursive: true, force: true });
      reports.push({ txn: t.txn, action: "completed", reverted: [], unexpected: [] });
      continue;
    }
    const unexpected: RecoveryReport["unexpected"] = [];
    const toRevert: Op[] = [];
    for (const op of t.ops) {
      const actual = currentPreviewHash(ctx, op.path);
      if (actual === op.before) continue;
      if (actual === op.after) toRevert.push(op);
      else unexpected.push({ path: op.path, expectedBefore: op.before, expectedAfter: op.after, actual });
    }
    if (unexpected.length) {
      state.needsReconciliation = {
        reason: `interrupted transaction ${t.txn}: ${unexpected.length} preview file(s) match neither the old nor the new version`,
        at: nowIso(), details: { txn: t.txn, unexpected },
      };
      ctx.store.writeState(state);
      reports.push({ txn: t.txn, action: "needs-reconciliation", reverted: [], unexpected });
      return reports; // stop: later transactions must not be judged on an unknown preview
    }
    toRevert.forEach((op, i) => restore(ctx, stageDir, op.path, op.before, `recover-${i}`));
    ctx.store.appendJournal({ txn: t.txn, phase: "recovered", result: "rolled-back", reverted: toRevert.map((o) => o.path) });
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (state.needsReconciliation && JSON.stringify(state.needsReconciliation).includes(t.txn)) {
      state.needsReconciliation = null;
      ctx.store.writeState(state);
    }
    reports.push({ txn: t.txn, action: "rolled-back", reverted: toRevert.map((o) => o.path), unexpected: [] });
  }
  return reports;
}

/** Compare the preview folder with the manifest. */
export function previewDrift(ctx: Ctx, state: State): { path: string; expected: string | null; actual: string | null }[] {
  const actual = ctx.scanner.scan(ctx.cfg, ctx.cfg.preview);
  const drift: { path: string; expected: string | null; actual: string | null }[] = [];
  for (const [p, h] of Object.entries(state.preview)) {
    const a = actual.get(p) ?? null;
    if (a !== h) drift.push({ path: p, expected: h, actual: a });
  }
  for (const [p, h] of actual) if (!(p in state.preview)) drift.push({ path: p, expected: null, actual: h });
  return drift;
}
