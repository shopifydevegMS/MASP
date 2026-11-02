// Decides, per changed file, whether a session's change may be published.
//
// Three versions per file:
//   base    = what this session last integrated (initially the base commit version)
//   source  = the session's current version in its worktree
//   preview = what the unified preview holds now
// source == base            -> no change from this session
// preview == base           -> nobody else touched it: publish source
// preview == source         -> already identical: just record it as integrated
// otherwise                 -> someone else changed it too: conflict (never overwrite)
import { classify, type FileClass, type MaspConfig, type SessionConfig } from "./config.ts";
import type { Hash, State } from "./store.ts";
import { matchAny } from "./util.ts";

export interface Change {
  path: string;
  cls: FileClass;
  base: Hash | null;
  source: Hash | null;
  preview: Hash | null;
}

export type ScopeResult =
  | { ok: true; needsReady: boolean; why: string }
  | { ok: false; code: "scope" | "ownership"; reason: string };

export function checkScope(cfg: MaspConfig, s: SessionConfig, ch: Change, activeIds: Set<string>): ScopeResult {
  const p = ch.path;
  const ownsMe = matchAny(p, s.owns);
  const sharedMe = matchAny(p, s.shared);
  const others = cfg.sessions.filter((o) => o.id !== s.id && activeIds.has(o.id));
  const otherOwners = others.filter((o) => matchAny(p, o.owns)).map((o) => o.id);
  const otherSharers = others.filter((o) => matchAny(p, o.shared)).map((o) => o.id);

  if (!ownsMe && !sharedMe)
    return { ok: false, code: "scope", reason: `${p} is outside session ${s.id}'s owns/shared list` };
  if (ownsMe && otherOwners.length)
    return { ok: false, code: "ownership", reason: `${p} is also owned by session ${otherOwners.join(", ")}` };
  if (ch.cls === "critical") {
    if (!ownsMe) return { ok: false, code: "ownership", reason: `${p} is critical and must be exclusively owned (listed in owns)` };
    if (otherSharers.length) return { ok: false, code: "ownership", reason: `${p} is critical but session ${otherSharers.join(", ")} also lists it` };
    return { ok: true, needsReady: true, why: "critical file" };
  }
  if (ch.source === null) return { ok: true, needsReady: true, why: "deletion" };
  if (ch.cls === "shared") return { ok: true, needsReady: true, why: "shared file" };
  // Independent file: auto-publish only when exclusively owned.
  if (!ownsMe || otherSharers.length) return { ok: true, needsReady: true, why: "not exclusively owned" };
  if (!s.autoPublish) return { ok: true, needsReady: true, why: "autoPublish is off for this session" };
  return { ok: true, needsReady: false, why: "exclusively owned independent file" };
}

export type Merge =
  | { kind: "publish" }
  | { kind: "converged" }
  | { kind: "conflict"; code: "conflict" | "stale"; reason: string };

export function threeWay(state: State, ch: Change): Merge {
  if (ch.preview === ch.base) return { kind: "publish" };
  if (ch.preview === ch.source) return { kind: "converged" };
  const who = state.provenance[ch.path]?.session ?? "an unknown source";
  if (ch.preview !== null && ch.base !== null && ch.source !== null)
    return {
      kind: "conflict", code: "stale",
      reason: `${ch.path}: this session changed an older version; the preview now holds a version from ${who}. ` +
        `Whole-file changes cannot be proven compatible, so nothing was overwritten.`,
    };
  if (ch.base === null && ch.preview !== null)
    return { kind: "conflict", code: "conflict", reason: `${ch.path}: created by this session, but ${who} already created a different file at the same path` };
  if (ch.source === null)
    return { kind: "conflict", code: "conflict", reason: `${ch.path}: deleted by this session, but ${who} has changed it since` };
  return { kind: "conflict", code: "conflict", reason: `${ch.path}: changed by this session, but ${who} deleted it` };
}

export function activeSessionIds(cfg: MaspConfig, state: State): Set<string> {
  return new Set(cfg.sessions.filter((s) => s.active && state.sessions[s.id]).map((s) => s.id));
}

export { classify };
