// Loads masp.config.json and classifies theme files.
import fs from "node:fs";
import path from "node:path";
import { matchAny } from "./util.ts";

export interface SessionConfig {
  id: string;
  worktree: string;        // absolute after loading
  task?: string;
  owns: string[];          // exclusive ownership globs
  shared: string[];        // shared resources this session may change (needs `masp ready`)
  autoPublish: boolean;    // auto-publish independent owned files (default true)
  active: boolean;
}

export interface MaspConfig {
  configPath: string;
  root: string;
  repo: string;
  preview: string;
  dataDir: string;
  themeDirs: string[];
  ignore: string[];
  critical: string[];
  shared: string[];
  settleMs: number;
  reconcileMs: number;
  /** Two sessions inserting sections at the same position: block (default) or place later ones after. */
  jsonSamePosition: "block" | "after-existing";
  /** Branch that 'masp land' commits the reviewed preview to. */
  landBranch: string;
  sessions: SessionConfig[];
}

export type FileClass = "independent" | "shared" | "critical";

export const DEFAULT_THEME_DIRS = ["assets", "blocks", "config", "layout", "locales", "sections", "snippets", "templates"];
export const DEFAULT_IGNORE = [
  "**/.DS_Store", "**/Thumbs.db", "**/desktop.ini",
  "**/*.tmp", "**/*.swp", "**/*.swx", "**/*~", "**/.#*", "**/#*#", "**/4913", "**/*.crswap",
];
export const DEFAULT_CRITICAL = ["layout/**", "config/settings_data.json", "config/settings_schema.json"];
export const DEFAULT_SHARED = ["templates/**/*.json", "sections/*.json", "locales/**", "config/**"];

const SESSION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function findConfig(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.MASP_CONFIG) return path.resolve(process.env.MASP_CONFIG);
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, "masp.config.json");
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("masp.config.json not found (use --config or MASP_CONFIG)");
    dir = up;
  }
}

export function loadConfig(configPath: string): MaspConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const root = path.dirname(configPath);
  const abs = (p: string) => path.resolve(root, p);
  if (!raw.repo || !raw.preview) throw new Error("config needs 'repo' and 'preview'");
  const sessions: SessionConfig[] = (raw.sessions ?? []).map((s: any) => {
    if (!SESSION_ID.test(String(s.id))) throw new Error(`invalid session id '${s.id}'`);
    if (!s.worktree) throw new Error(`session ${s.id} needs 'worktree'`);
    return {
      id: String(s.id),
      worktree: abs(s.worktree),
      task: s.task,
      owns: s.owns ?? [],
      shared: s.shared ?? [],
      autoPublish: s.autoPublish !== false,
      active: s.active !== false,
    };
  });
  const ids = new Set<string>();
  for (const s of sessions) {
    if (ids.has(s.id)) throw new Error(`duplicate session id '${s.id}'`);
    ids.add(s.id);
  }
  const cfg: MaspConfig = {
    configPath,
    root,
    repo: abs(raw.repo),
    preview: abs(raw.preview),
    dataDir: abs(raw.dataDir ?? ".masp"),
    themeDirs: raw.themeDirs ?? DEFAULT_THEME_DIRS,
    ignore: [...DEFAULT_IGNORE, ...(raw.ignore ?? [])],
    critical: raw.critical ?? DEFAULT_CRITICAL,
    shared: raw.shared ?? DEFAULT_SHARED,
    settleMs: raw.settleMs ?? 400,
    reconcileMs: raw.reconcileMs ?? 30000,
    jsonSamePosition: raw.jsonSamePosition === "after-existing" ? "after-existing" : "block",
    landBranch: landBranchOf(raw.landBranch),
    sessions,
  };
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  // The preview and MASP data must never live inside a worktree or each other.
  for (const s of sessions) {
    if (inside(cfg.preview, s.worktree) || inside(s.worktree, cfg.preview))
      throw new Error(`preview and worktree of session ${s.id} overlap`);
    if (inside(cfg.dataDir, s.worktree)) throw new Error(`dataDir is inside worktree of session ${s.id}`);
  }
  if (inside(cfg.dataDir, cfg.preview)) throw new Error("dataDir must not be inside the preview");
  return cfg;
}

function landBranchOf(v: unknown): string {
  if (v === undefined) return "main";
  if (typeof v !== "string" || !/^[A-Za-z0-9._/-]+$/.test(v) || v.startsWith("-") || v.includes(".."))
    throw new Error(`invalid landBranch '${String(v)}' in masp.config.json`);
  return v;
}

export function classify(cfg: MaspConfig, p: string): FileClass {
  if (matchAny(p, cfg.critical)) return "critical";
  if (matchAny(p, cfg.shared)) return "shared";
  return "independent";
}

export function isThemePath(cfg: MaspConfig, p: string): boolean {
  const top = p.split("/")[0];
  return cfg.themeDirs.includes(top) && !matchAny(p, cfg.ignore);
}
