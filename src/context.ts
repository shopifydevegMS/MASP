import fs from "node:fs";
import path from "node:path";
import { findConfig, loadConfig, type MaspConfig, type SessionConfig } from "./config.ts";
import { Store, type State, type SessionState, type Hash } from "./store.ts";
import { Scanner } from "./scan.ts";
import { loadRefCache, saveRefCache } from "./deps.ts";

let refCacheFile: string | null = null;

export interface Ctx {
  cfg: MaspConfig;
  store: Store;
  scanner: Scanner;
  /** First time each (session, path, hash) was seen; used for stability and latency. */
  seen: Map<string, { hash: string; since: number }>;
  log: (msg: string) => void;
}

export function openCtx(configPath?: string, log?: (m: string) => void): Ctx {
  const cfg = loadConfig(findConfig(configPath));
  const store = new Store(cfg.dataDir);
  if (!refCacheFile && fs.existsSync(cfg.dataDir)) {
    // References are cached by content hash, so this cache is always valid; save it on normal exit.
    refCacheFile = store.p("refs-cache.json");
    loadRefCache(refCacheFile);
    const file = refCacheFile;
    process.once("exit", () => { try { saveRefCache(file); } catch { /* cache only */ } });
  }
  return {
    cfg, store, scanner: new Scanner(), seen: new Map(),
    log: log ?? ((m) => {
      const line = `${new Date().toISOString()} ${m}`;
      try {
        fs.mkdirSync(cfg.dataDir, { recursive: true });
        fs.appendFileSync(path.join(cfg.dataDir, "controller.log"), line + "\n");
      } catch { /* logging must never break integration */ }
      console.log(m);
    }),
  };
}

export function sessionCfg(ctx: Ctx, id: string): SessionConfig {
  const s = ctx.cfg.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`unknown session '${id}' (not in ${ctx.cfg.configPath})`);
  return s;
}

/** The version a session last integrated (or the base commit version). */
/** The commit a session compares against: its own start commit (it may predate a landing). */
export function sessionCommit(state: State, ss: SessionState): string {
  return ss.baseCommit ?? state.baseCommit;
}

/** File hashes of the commit a session started from. */
export function sessionTree(state: State, ss: SessionState): Record<string, Hash> {
  const c = sessionCommit(state, ss);
  if (c === state.baseCommit) return state.baseTree;
  const t = state.trees?.[c];
  if (!t) throw new Error(`MASP state is missing the base tree of commit ${c.slice(0, 10)} used by session ${ss.id}`);
  return t;
}

export function sessionBase(state: State, ss: SessionState, p: string): Hash | null {
  if (Object.prototype.hasOwnProperty.call(ss.base, p)) return ss.base[p];
  return sessionTree(state, ss)[p] ?? null;
}

/** Paths a session may have changed: everything in its worktree plus everything in its base. */
export function candidatePaths(state: State, ss: SessionState, source: Map<string, Hash>): string[] {
  const all = new Set<string>(source.keys());
  for (const p of Object.keys(sessionTree(state, ss))) all.add(p);
  for (const [p, h] of Object.entries(ss.base)) if (h !== null) all.add(p);
  return [...all].sort();
}
