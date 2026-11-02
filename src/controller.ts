// `masp start`: the long-running integration controller.
// File-system events wake it up and trigger a pass over just the session that changed.
// A full reconciliation pass (every session + the preview) runs every reconcileMs to catch
// missed events. All integration runs serially in this one process, under the writer lock.
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { Lock } from "./lock.ts";
import { integratePass } from "./engine.ts";
import { matchAny } from "./util.ts";
import { saveRefCache } from "./deps.ts";

export async function runController(ctx: Ctx): Promise<number> {
  const { cfg, store } = ctx;
  if (!store.hasState()) throw new Error("not initialised; run 'masp init' first");
  store.ensure();
  const lock = Lock.acquire(store.p("lock"), "start");
  if (lock.staleTakenOver) ctx.log(`took over a stale lock from pid ${lock.staleTakenOver.pid} (previous controller crashed?)`);
  const stopFile = store.p("control", "stop");
  fs.rmSync(stopFile, { force: true });
  const cacheFile = store.p("scan-cache.json");
  ctx.scanner.load(cacheFile);

  let stopping = false;
  let wake: (() => void) | null = null;
  let dueAt = 0;                         // next targeted pass (0 = now)
  let nextFull = 0;                      // next full reconciliation pass
  const dirty = new Set<string>();       // sessions with file events since the last pass
  let previewDirty = true;
  const poke = (delay: number) => {
    const t = Date.now() + delay;
    if (t < dueAt || dueAt === Infinity) dueAt = t;
    wake?.();
  };
  const requestStop = (why: string) => {
    if (stopping) return;
    ctx.log(`stopping (${why})`);
    stopping = true;
    wake?.();
  };

  const watchers: fs.FSWatcher[] = [];
  const watch = (dir: string, onEvent: (file: string) => void) => {
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, file) => onEvent(file ? String(file).split(path.sep).join("/") : ""));
      w.on("error", (e) => ctx.log(`watcher error on ${dir}: ${e.message}; relying on reconciliation scans`));
      watchers.push(w);
    } catch (e) {
      ctx.log(`cannot watch ${dir}: ${(e as Error).message}; relying on reconciliation scans`);
    }
  };
  for (const s of cfg.sessions) {
    if (!s.active) continue;
    watch(s.worktree, (f) => {
      if (f === "" || (cfg.themeDirs.includes(f.split("/")[0]) && !matchAny(f, cfg.ignore))) {
        dirty.add(s.id);
        poke(cfg.settleMs);
      }
    });
  }
  watch(store.p("requests"), (f) => { if (!f.startsWith("done")) poke(0); });
  watch(store.p("control"), () => { if (fs.existsSync(stopFile)) requestStop("masp stop"); });
  // Outside edits to the preview: look promptly (our own publishes also land here; harmless).
  watch(cfg.preview, () => { previewDirty = true; poke(cfg.settleMs); });

  const onSignal = () => requestStop("signal");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  ctx.log(`controller started (pid ${process.pid}); preview: ${cfg.preview}`);
  let exitCode = 0;
  let refusedBefore = "";
  let passes = 0;
  let fullPasses = 0;
  let peakRss = process.memoryUsage().rss;
  const cpu0 = process.cpuUsage();
  const t0All = Date.now();
  const writeStats = () => {
    const cpu = process.cpuUsage(cpu0);
    const stats = {
      at: new Date().toISOString(), uptimeMs: Date.now() - t0All, passes, fullPasses, filesHashed: ctx.scanner.hashedFiles,
      peakRssMB: +(peakRss / 1048576).toFixed(1), rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    };
    try { fs.writeFileSync(store.p("controller-stats.json"), JSON.stringify(stats, null, 1)); } catch { /* ignore */ }
    return stats;
  };
  try {
    while (!stopping) {
      if (fs.existsSync(stopFile)) break;
      const now = Date.now();
      const full = now >= nextFull;
      if (full || now >= dueAt) {
        dueAt = Infinity;
        const sessions = full ? null : new Set(dirty);
        const checkDrift = full || previewDirty;
        dirty.clear();
        previewDirty = false;
        const t0 = performance.now();
        const r = integratePass(ctx, { stableMs: cfg.settleMs, sessions, checkDrift });
        passes++;
        if (full) {
          fullPasses++;
          nextFull = Date.now() + cfg.reconcileMs;
          ctx.scanner.save(cacheFile);
          try { saveRefCache(store.p("refs-cache.json")); } catch { /* cache only */ }
        }
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        for (const rec of r.recovered) ctx.log(`recovery: transaction ${rec.txn} ${rec.action}${rec.reverted.length ? ` (reverted ${rec.reverted.join(", ")})` : ""}`);
        for (const [id, err] of Object.entries(r.registrationErrors)) ctx.log(`session ${id} not registered: ${err}`);
        if (r.refused && r.refused !== refusedBefore) ctx.log(`REFUSING TO PUBLISH: ${r.refused}`);
        refusedBefore = r.refused ?? "";
        // Files still settling: look at those sessions again.
        for (const id of r.unstableSessions) dirty.add(id);
        if (r.unstable > 0) poke(cfg.settleMs);
        if (r.checkpoints.length) ctx.log(`pass took ${(performance.now() - t0).toFixed(0)} ms`);
        writeStats();
      }
      const waitMs = Math.max(10, Math.min(dueAt, nextFull) - Date.now());
      await new Promise<void>((res) => {
        const t = setTimeout(res, waitMs);
        wake = () => { clearTimeout(t); res(); };
      });
      wake = null;
    }
  } catch (e) {
    ctx.log(`controller error: ${(e as Error).stack ?? e}`);
    exitCode = 1;
  } finally {
    for (const w of watchers) w.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    fs.rmSync(stopFile, { force: true });
    try { ctx.scanner.save(cacheFile); } catch { /* cache only */ }
    lock.release();
    const stats = writeStats();
    ctx.log(`controller stopped; state is saved and recoverable. stats: ${JSON.stringify(stats)}`);
  }
  return exitCode;
}
