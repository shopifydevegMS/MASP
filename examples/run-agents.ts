// Run real Claude Code sessions headless, one per MASP worktree, fenced in (see src/agents.ts).
//   node examples/run-agents.ts --config <masp.config.json> --claude <path to claude.exe> --task-A "<task>" --task-B "<task>"
// Every message and tool call of a session is logged to <workspace>/agents/<id>.log.jsonl.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { headlessArgs, prepareAgentFiles } from "../src/agents.ts";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const cfg = loadConfig(path.resolve(arg("config") ?? ""));
const claude = arg("claude") ?? process.env.MASP_CLAUDE ?? "claude";
const maxTurns = arg("max-turns") ?? "40";

const runs = cfg.sessions.filter((s) => arg(`task-${s.id}`)).map((s) => {
  const files = prepareAgentFiles(cfg, s);
  const log = path.join(files.dir, `${s.id}.log.jsonl`);
  const t0 = Date.now();
  const child = spawn(claude, headlessArgs(files, arg(`task-${s.id}`)!, maxTurns), {
    cwd: s.worktree,
    env: { ...process.env, ...files.env, PATH: `${files.binDir}${path.delimiter}${process.env.PATH}` },
    stdio: ["ignore", fs.openSync(log, "w"), fs.openSync(path.join(files.dir, `${s.id}.stderr.log`), "w")],
  });
  console.log(`session ${s.id}: started (pid ${child.pid}) in ${s.worktree}`);
  return new Promise<{ id: string; code: number | null; ms: number }>((res) => child.on("exit", (code) => res({ id: s.id, code, ms: Date.now() - t0 })));
});

for (const r of await Promise.all(runs)) console.log(`session ${r.id}: exited ${r.code} after ${(r.ms / 1000).toFixed(0)} s`);
