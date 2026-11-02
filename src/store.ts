// MASP metadata outside Git and outside the theme:
//   blobs/xx/<sha256>   content-addressed snapshots (canonical content)
//   state.json          current state, replaced atomically
//   journal.jsonl       append-only transaction journal
//   checkpoints/*.json  one record per integration attempt (outcome, conflicts)
//   requests/*.json     pending Ready signals; requests/done/ keeps processed ones
//   staging/<txn>/      files staged for a transaction (same volume as the preview)
// Nothing here is deleted automatically.
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, sha256, exists, nowIso } from "./util.ts";

export type Hash = string;

export interface Provenance {
  session: string;     // session id, or "base"
  contributors?: string[]; // sessions whose changes this version contains (after a merge)
  merged?: boolean;
  checkpoint?: string;
  txn?: string;
  at?: string;
}

export interface SessionState {
  id: string;
  registeredAt: string;
  headAtStart: string;
  /** Commit this session's worktree started from (sessions keep it across a landing until 'masp resync'). */
  baseCommit?: string;
  /** Per-path override of the base tree: what this session last had integrated (null = absent). */
  base: Record<string, Hash | null>;
  held: Record<string, string>;      // path -> why auto-publish is waiting
  pendingReady: string[];            // changed paths that need `masp ready`
  lastCheckpoint?: string;
  warnings: string[];
}

export interface ConflictRecord {
  session: string;
  path: string;
  kind: string;          // conflict | stale | scope | ownership | dependency | validation | changed-after-ready | head
  detail: string;
  sourceHash: Hash | null;
  checkpoint?: string;
  at: string;
}

export interface LandRecord {
  commit: string;
  parent: string;
  branch: string;
  at: string;
  message: string;
  files: number;
}

export interface State {
  version: 1;
  createdAt: string;
  /** Base trees of earlier commits that some session still started from (after a landing). */
  trees?: Record<string, Record<string, Hash>>;
  landed?: LandRecord[];
  baseCommit: string;
  baseTree: Record<string, Hash>;
  preview: Record<string, Hash>;           // manifest of the unified preview
  provenance: Record<string, Provenance>;
  sessions: Record<string, SessionState>;
  conflicts: Record<string, ConflictRecord>; // key `${session}:${path}`
  lastTxn: string | null;
  lastPublishAt: string | null;
  needsReconciliation: null | { reason: string; at: string; details: unknown };
}

export interface JournalEntry {
  txn: string;
  phase: "begin" | "staged" | "commit" | "rolledback" | "failed" | "recovered";
  at: string;
  [k: string]: unknown;
}

export interface Op {
  path: string;
  before: Hash | null;   // expected current preview content
  after: Hash | null;    // new content (null = delete)
}

export class Store {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  p(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  ensure(): void {
    for (const d of ["blobs", "checkpoints", "requests", "requests/done", "staging", "control"])
      fs.mkdirSync(this.p(d), { recursive: true });
  }

  blobPath(h: Hash): string {
    return this.p("blobs", h.slice(0, 2), h);
  }
  putBlob(buf: Buffer): Hash {
    const h = sha256(buf);
    const bp = this.blobPath(h);
    if (!exists(bp)) atomicWriteFile(bp, buf);
    return h;
  }
  getBlob(h: Hash): Buffer {
    const buf = fs.readFileSync(this.blobPath(h));
    if (sha256(buf) !== h) throw new Error(`snapshot ${h} is corrupt`);
    return buf;
  }

  hasState(): boolean {
    return exists(this.p("state.json"));
  }
  readState(): State {
    return JSON.parse(fs.readFileSync(this.p("state.json"), "utf8")) as State;
  }
  writeState(s: State): void {
    atomicWriteFile(this.p("state.json"), JSON.stringify(s, null, 1));
  }

  appendJournal(e: Omit<JournalEntry, "at">): void {
    const fd = fs.openSync(this.p("journal.jsonl"), "a");
    try {
      fs.writeSync(fd, JSON.stringify({ ...e, at: nowIso() }) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  readJournal(): JournalEntry[] {
    if (!exists(this.p("journal.jsonl"))) return [];
    const out: JournalEntry[] = [];
    for (const line of fs.readFileSync(this.p("journal.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line from a crash mid-append. The entry before it is still valid.
      }
    }
    return out;
  }

  writeCheckpoint(rec: { id: string } & Record<string, unknown>): void {
    atomicWriteFile(this.p("checkpoints", `${rec.id}.json`), JSON.stringify(rec, null, 1));
  }
  listCheckpoints(): any[] {
    const dir = this.p("checkpoints");
    if (!exists(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
}
