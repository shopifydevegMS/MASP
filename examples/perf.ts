// Performance run on a synthetic theme of realistic size (about 1,000 files).
//   node examples/perf.ts            (takes about 2 minutes; the idle phase is 60 s)
// Everything happens under .tmp/ and is deleted afterwards. No Shopify connection.
import fs from "node:fs";
import path from "node:path";
import { Sandbox, ROOT, waitFor } from "../test/harness.ts";
import { generateTheme } from "../test/gen-theme.ts";
import { openCtx } from "../src/context.ts";
import * as cmd from "../src/commands.ts";

const IDLE_MS = Number(process.env.MASP_PERF_IDLE_MS ?? 60000);
const out: [string, string][] = [];
const rec = (k: string, v: string) => {
  out.push([k, v]);
  console.log(`${k.padEnd(52)} ${v}`);
};
const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)} ms`;

const fixture = path.join(ROOT, ".tmp", `perf-fixture-${process.pid}`);
const files = generateTheme(fixture);
const bytes = fs.readdirSync(fixture, { recursive: true }).map(String)
  .reduce((a, f) => { const st = fs.statSync(path.join(fixture, f)); return a + (st.isFile() ? st.size : 0); }, 0);
rec("theme size", `${files} files, ${(bytes / 1048576).toFixed(1)} MB`);

let t0 = performance.now();
const sb = new Sandbox("perf", { fixture, init: false, settleMs: 300, extraConfig: { reconcileMs: 30000 } });
rec("harness: git repo + 2 worktrees", ms(t0));
try {
  t0 = performance.now();
  cmd.init(sb.ctx());
  rec("masp init (read commit, write preview + snapshots)", ms(t0));

  const fresh = openCtx(sb.config, () => {});
  t0 = performance.now();
  fresh.scanner.scan(fresh.cfg, sb.worktrees.A);
  rec("cold scan of one worktree (hash every file)", ms(t0));
  t0 = performance.now();
  fresh.scanner.scan(fresh.cfg, sb.worktrees.A);
  rec("warm scan of one worktree (size+mtime cache)", ms(t0));

  t0 = performance.now();
  const v = cmd.verify(sb.ctx());
  rec("masp verify (drift + all local checks + deps)", `${ms(t0)}  (${v.issues.filter((i) => i.severity === "error").length} errors)`);

  t0 = performance.now();
  const tc = cmd.themeCheck(sb.ctx());
  rec("Shopify Theme Check on the whole preview", tc.failure ? `failed: ${tc.failure.slice(0, 80)}` : `${(tc.durationMs / 1000).toFixed(1)} s (${tc.errorCount} errors, ${tc.warningCount} warnings)`);

  // One-shot pass with nothing to do: the cost of a reconciliation pass.
  await cmd.integrate(sb.ctx());
  t0 = performance.now();
  await cmd.integrate(sb.ctx());
  rec("integration pass, no changes (2 sessions, warm)", ms(t0));

  // Controller: event-driven edits, then idle.
  const ctl = sb.startController();
  await waitFor(() => (ctl as any).output().includes("controller started"), 30000, "controller");
  await new Promise((r) => setTimeout(r, 1500));
  const lat: number[] = [];
  for (let i = 0; i < 10; i++) {
    const css = `.perf-${i} { padding: ${i}px; }\n`;
    const start = Date.now();
    sb.write(i % 2 ? "B" : "A", i % 2 ? "assets/dev2.css" : "assets/dev1.css", css);
    await waitFor(() => (sb.readPreview(i % 2 ? "assets/dev2.css" : "assets/dev1.css") ?? "").includes(`.perf-${i} `), 30000, "publish");
    lat.push(Date.now() - start);
  }
  lat.sort((a, b) => a - b);
  rec("CSS edit -> preview, controller (settle 300 ms), n=10", `median ${lat[5]} ms, max ${lat[9]} ms`);

  sb.editJson("A", "templates/index.json", (x) => {
    x.sections.a_perf = { type: "section-1", settings: { title: "perf" } };
    x.order.push("a_perf");
  });
  t0 = performance.now();
  const r = sb.masp(["ready", "--session", "A"]);
  rec("masp ready (template insert) -> published, incl. Node start", `${ms(t0)}  (${/PUBLISHED/.test(r.stdout) ? "published" : r.stdout.trim()})`);

  const statsFile = path.join(sb.data, "controller-stats.json");
  const readStats = () => JSON.parse(fs.readFileSync(statsFile, "utf8"));
  await new Promise((r2) => setTimeout(r2, 3000)); // let the last publish settle
  const idle0 = readStats();
  const tIdle = Date.now();
  await new Promise((r2) => setTimeout(r2, IDLE_MS));
  // Force one more stats write: a full pass happens at most every 30 s, so wait for the next one.
  await waitFor(() => readStats().fullPasses > idle0.fullPasses, 40000, "full pass");
  const idle1 = readStats();
  const idleCpu = idle1.cpuMs - idle0.cpuMs;
  const idleSpan = Date.parse(idle1.at) - Date.parse(idle0.at);
  rec(`idle controller (${(idleSpan / 1000).toFixed(0)} s, reconcile every 30 s)`, `${idleCpu} ms CPU = ${((idleCpu / idleSpan) * 100).toFixed(3)}% of one core, ${idle1.fullPasses - idle0.fullPasses} full pass(es), memory ${idle1.rssMB} MB`);
  void tIdle;
  sb.masp(["stop"]);
  await waitFor(() => ctl.exitCode !== null, 30000, "stop");
  const stats = readStats();
  rec("controller run total", `${stats.passes} passes (${stats.fullPasses} full) in ${(stats.uptimeMs / 1000).toFixed(0)} s, ${stats.cpuMs} ms CPU, peak ${stats.peakRssMB} MB, ${stats.filesHashed} files read`);

  // Restart: the saved hash cache should avoid re-reading the theme.
  const ctl2 = sb.startController();
  await waitFor(() => fs.existsSync(statsFile) && readStats().passes >= 1 && readStats().uptimeMs < 60000 && (ctl2 as any).output().includes("controller started"), 30000, "restart");
  await new Promise((r2) => setTimeout(r2, 500));
  const s2 = readStats();
  sb.masp(["stop"]);
  await waitFor(() => ctl2.exitCode !== null, 30000, "stop 2");
  rec("controller restart: files re-read on first full pass", `${s2.filesHashed} (of ~${files * 3} in 2 worktrees + preview), ${s2.cpuMs} ms CPU`);

  const store = fs.readdirSync(sb.data, { recursive: true }).map(String)
    .reduce((a, f) => { const st = fs.statSync(path.join(sb.data, f)); return a + (st.isFile() ? st.size : 0); }, 0);
  rec("MASP data folder size", `${(store / 1048576).toFixed(1)} MB`);
} finally {
  await sb.cleanup();
  fs.rmSync(fixture, { recursive: true, force: true });
}
fs.writeFileSync(path.join(ROOT, "docs", "perf-results.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, results: Object.fromEntries(out) }, null, 2));
