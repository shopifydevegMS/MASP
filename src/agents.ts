// Per-session files for AI coding sessions, written OUTSIDE the worktrees (in <workspace>/agents/):
//   <id>.md             the MASP rules for that session (docs/agent-instructions.md filled in)
//   <id>.settings.json  Claude Code permissions: edit only its worktree, Bash only `masp ...` and read-only git
//   start-<id>.ps1      opens an interactive Claude Code session for it (PowerShell)
//   bin/masp, masp.cmd  so `masp ...` works in Git Bash (Claude Code's shell) and in PowerShell/cmd
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MaspConfig, SessionConfig } from "./config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MASP_BIN = path.join(ROOT, "bin", "masp.ts");

export interface AgentFiles {
  dir: string;
  binDir: string;
  rulesFile: string;
  settingsFile: string;
  startScript: string;
  env: Record<string, string>;
}

/** Claude Code permission paths: "//" + lower-case drive letter + POSIX path. */
const rulePath = (p: string) => "//" + path.resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => d.toLowerCase());

export function sessionPrefix(s: SessionConfig): string {
  return s.owns.map((g) => g.split("/").pop()!.replace(/\*.*$/, "")).find(Boolean) ?? `masp-${s.id.toLowerCase()}-`;
}

export function prepareAgentFiles(cfg: MaspConfig, s: SessionConfig): AgentFiles {
  const dir = path.join(cfg.root, "agents");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const nodeExe = process.execPath;
  fs.writeFileSync(path.join(binDir, "masp"), `#!/bin/sh\nexec "${nodeExe.replace(/\\/g, "/")}" "${MASP_BIN.replace(/\\/g, "/")}" "$@"\n`);
  fs.writeFileSync(path.join(binDir, "masp.cmd"), `@"${nodeExe}" "${MASP_BIN}" %*\r\n`);

  const others = cfg.sessions.filter((o) => o.id !== s.id).map((o) => o.worktree);
  const outside = [cfg.preview, cfg.dataDir, cfg.repo, dir, ...others];
  const deny = [
    ...outside.flatMap((p) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].map((t) => `${t}(${rulePath(p)}/**)`)),
    ...["commit", "push", "reset", "checkout", "switch", "stash", "rebase", "merge", "branch", "worktree", "restore", "clean", "tag", "am", "cherry-pick", "revert", "config"]
      .map((g) => `Bash(git ${g}:*)`),
    "Bash(shopify:*)", "Bash(npx shopify:*)", "Bash(masp land:*)", "Bash(masp resync:*)", "Bash(masp serve:*)", "Bash(masp gc:*)",
    "WebFetch", "WebSearch",
  ];
  const allow = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit",
    "Bash(masp ready:*)", "Bash(masp lint:*)", "Bash(masp status:*)", "Bash(masp show:*)", "Bash(masp conflicts:*)", "Bash(masp diff:*)",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)"];
  const settingsFile = path.join(dir, `${s.id}.settings.json`);
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow, deny, defaultMode: "acceptEdits" } }, null, 2));

  const template = fs.readFileSync(path.join(ROOT, "docs", "agent-instructions.md"), "utf8");
  const rules = template
    .replaceAll("{{SESSION}}", s.id)
    .replaceAll("{{OWNS}}", s.owns.map((g) => `\`${g}\``).join(", "))
    .replaceAll("{{SHARED}}", s.shared.map((g) => `\`${g}\``).join(", ") || "none")
    .replaceAll("{{PREFIX}}", sessionPrefix(s));
  const rulesFile = path.join(dir, `${s.id}.md`);
  fs.writeFileSync(rulesFile, rules);

  const env = { MASP_CONFIG: cfg.configPath, MASP_SESSION: s.id };
  const startScript = path.join(dir, `start-${s.id}.ps1`);
  const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
  fs.writeFileSync(startScript, [
    `# Start an interactive Claude Code session for MASP session ${s.id}.`,
    `# Usage (from any PowerShell):  & ${q(startScript)}   [extra claude options]`,
    `$env:MASP_CONFIG = ${q(cfg.configPath)}`,
    `$env:MASP_SESSION = '${s.id}'`,
    `$env:PATH = ${q(binDir)} + ';' + $env:PATH`,
    `Set-Location ${q(s.worktree)}`,
    `$claude = if ($env:MASP_CLAUDE) { $env:MASP_CLAUDE } else { 'claude' }`,
    `& $claude --append-system-prompt-file ${q(rulesFile)} --settings ${q(settingsFile)} --setting-sources project,local --strict-mcp-config @args`,
    ``,
  ].join("\r\n"));
  return { dir, binDir, rulesFile, settingsFile, startScript, env };
}

/** Arguments for a headless (`claude -p`) run of one task. */
export function headlessArgs(files: AgentFiles, task: string, maxTurns: string): string[] {
  return [
    "-p", task,
    "--append-system-prompt-file", files.rulesFile,
    "--settings", files.settingsFile,
    "--setting-sources", "project,local", // ignore the user's global settings and their broader allow rules
    "--strict-mcp-config",                // no MCP servers (e.g. no Shopify connector that could change the store)
    "--permission-mode", "acceptEdits",
    "--max-turns", maxTurns,
    "--output-format", "stream-json", "--verbose",
  ];
}
