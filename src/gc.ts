// `masp gc`: manual cleanup of MASP's own data. Never runs automatically.
// Default is a dry run that only reports. With --apply it deletes:
//   - checkpoint records and processed Ready requests older than the newest --keep (default 100);
//   - snapshots (blobs) that nothing kept still refers to;
//   - staging folders of finished transactions, stale lock files, temp files.
// Always kept: everything the current state, open conflicts, pending requests, kept checkpoints and
// interrupted transactions refer to, plus the whole journal (append-only history).
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { Lock } from "./lock.ts";
import { incompleteTxns } from "./publish.ts";

export interface GcReport {
  applied: boolean;
  keep: number;
  checkpoints: { total: number; remove: number };
  requests: { remove: number };
  blobs: { total: number; remove: number; bytes: number };
  other: { remove: string[]; bytes: number };
  kept: { blobs: number; bytes: number };
}

function size(p: string): number {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    return fs.readdirSync(p).reduce((a, f) => a + size(path.join(p, f)), 0);
  } catch {
    return 0;
  }
}

const HASH = /^[0-9a-f]{64}$/;

function collectHashes(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    if (HASH.test(v)) into.add(v);
  } else if (Array.isArray(v)) for (const x of v) collectHashes(x, into);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectHashes(x, into);
}

export function gc(ctx: Ctx, opts: { apply?: boolean; keep?: number } = {}): GcReport {
  const { store } = ctx;
  const keep = Math.max(1, opts.keep ?? 100);
  const run = (): GcReport => {
    const state = store.readState();
    const cps = store.listCheckpoints(); // sorted by time, oldest first
    const keptCps = cps.slice(-keep);
    const dropCps = cps.slice(0, Math.max(0, cps.length - keep));
    const keptIds = new Set(keptCps.map((c: any) => c.id));
    for (const ss of Object.values(state.sessions)) if (ss.lastCheckpoint) keptIds.add(ss.lastCheckpoint);
    for (const c of Object.values(state.conflicts)) if (c.checkpoint) keptIds.add(c.checkpoint);

    const doneDir = store.p("requests", "done");
    const done = fs.existsSync(doneDir) ? fs.readdirSync(doneDir).filter((f) => f.endsWith(".json")) : [];
    const dropDone: string[] = [];
    const live = new Set<string>();
    // Everything the current state needs.
    collectHashes({ baseTree: state.baseTree, preview: state.preview, sessions: state.sessions, conflicts: state.conflicts }, live);
    for (const cp of cps) if (keptIds.has(cp.id)) collectHashes(cp.files, live);
    for (const f of fs.readdirSync(store.p("requests")).filter((x) => x.endsWith(".json")))
      collectHashes(JSON.parse(fs.readFileSync(store.p("requests", f), "utf8")), live);
    for (const f of done) {
      const d = JSON.parse(fs.readFileSync(path.join(doneDir, f), "utf8"));
      if (d.checkpoint && !keptIds.has(d.checkpoint) && dropCps.some((c: any) => c.id === d.checkpoint)) dropDone.push(f);
      else collectHashes(d, live);
    }
    for (const t of incompleteTxns(ctx)) collectHashes(t.ops, live);
    const dropCpFiles = dropCps.filter((c: any) => !keptIds.has(c.id)).map((c: any) => `${c.id}.json`);

    const blobsDir = store.p("blobs");
    const allBlobs: string[] = [];
    for (const d of fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir) : [])
      for (const f of fs.readdirSync(path.join(blobsDir, d))) if (HASH.test(f)) allBlobs.push(f);
    const dropBlobs = allBlobs.filter((h) => !live.has(h));
    const blobBytes = dropBlobs.reduce((a, h) => a + size(store.blobPath(h)), 0);
    const keptBytes = allBlobs.filter((h) => live.has(h)).reduce((a, h) => a + size(store.blobPath(h)), 0);

    // Leftovers that are never needed for recovery.
    const open = new Set(incompleteTxns(ctx).map((t) => t.txn));
    const other: string[] = [];
    for (const d of fs.existsSync(store.p("staging")) ? fs.readdirSync(store.p("staging")) : [])
      if (!open.has(d)) other.push(store.p("staging", d));
    for (const f of fs.readdirSync(store.dir)) if (f.startsWith("lock.stale-") || f.endsWith(".tmp")) other.push(store.p(f));
    if (fs.existsSync(store.p("tmp"))) other.push(store.p("tmp"));
    const otherBytes = other.reduce((a, p) => a + size(p), 0);

    if (opts.apply) {
      for (const f of dropCpFiles) fs.rmSync(store.p("checkpoints", f), { force: true });
      for (const f of dropDone) fs.rmSync(path.join(doneDir, f), { force: true });
      for (const h of dropBlobs) fs.rmSync(store.blobPath(h), { force: true });
      for (const p of other) fs.rmSync(p, { recursive: true, force: true });
      store.appendJournal({ txn: "gc", phase: "recovered", result: "gc", removed: { checkpoints: dropCpFiles.length, requests: dropDone.length, blobs: dropBlobs.length } });
    }
    return {
      applied: !!opts.apply, keep,
      checkpoints: { total: cps.length, remove: dropCpFiles.length },
      requests: { remove: dropDone.length },
      blobs: { total: allBlobs.length, remove: dropBlobs.length, bytes: blobBytes },
      other: { remove: other.map((p) => path.relative(store.dir, p)), bytes: otherBytes },
      kept: { blobs: allBlobs.length - dropBlobs.length, bytes: keptBytes },
    };
  };
  if (!opts.apply) return run();
  // Deleting needs the writer lock so nothing is published while snapshots are removed.
  const lock = Lock.acquire(store.p("lock"), "gc");
  try {
    return run();
  } finally {
    lock.release();
  }
}
