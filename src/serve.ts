// `masp serve`: run the ONE `shopify theme dev` for the preview, with safe flags only, and record
// its output so `masp status` can report which published files Shopify has received.
// Started only when the person runs `masp serve --store <dev store>`; MASP never starts it on its own.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Ctx } from "./context.ts";
import type { State } from "./store.ts";
import { previewCommand } from "./commands.ts";
import { pidAlive } from "./lock.ts";
import { atomicWriteFile, nowIso, sleep } from "./util.ts";

export interface ServeInfo {
  pid: number;          // the masp serve process
  childPid: number;     // the shopify CLI (shell) process
  store: string;
  port: number;
  startedAt: string;
}

export function serveInfo(ctx: Ctx): ServeInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(ctx.store.p("serve.json"), "utf8")) as ServeInfo;
    return pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** Kill a process and everything it started (Windows needs taskkill for the tree). */
export function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

export async function serve(ctx: Ctx, opts: { store: string; port?: number }): Promise<number> {
  const { store } = ctx;
  if (!/^[a-z0-9][a-z0-9-]*(\.myshopify\.com)?$/i.test(opts.store)) throw new Error(`'${opts.store}' is not a store name like my-dev-store or my-dev-store.myshopify.com`);
  const port = opts.port ?? 9292;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be a number between 1024 and 65535");
  const running = serveInfo(ctx);
  if (running) throw new Error(`already serving (pid ${running.pid}, store ${running.store}); run 'masp serve --stop' first`);
  const pre = previewCommand(ctx);
  if (!pre.ready) throw new Error(`the preview is not safe to serve:\n  - ${pre.blockers.join("\n  - ")}`);
  for (const n of pre.notes) console.log(`note: ${n}`);

  const bin = process.env.MASP_SHOPIFY_BIN ?? "shopify";
  // Only safe flags: no --theme (a separate development theme), no --theme-editor-sync, no --allow-live.
  const command = `${bin} theme dev --path "${ctx.cfg.preview}" --store ${opts.store} --port ${port} --no-color`;
  const log = store.p("shopify-dev.log");
  if (fs.existsSync(log)) fs.renameSync(log, store.p("shopify-dev.prev.log"));
  const out = fs.openSync(log, "a");
  const startedAt = nowIso();
  fs.writeSync(out, `${startedAt}\tMASP serve started: ${command}\n`);

  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const info: ServeInfo = { pid: process.pid, childPid: child.pid!, store: opts.store, port, startedAt };
  atomicWriteFile(store.p("serve.json"), JSON.stringify(info, null, 1));
  const stopFile = store.p("control", "serve-stop");
  fs.rmSync(stopFile, { force: true });

  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      fs.writeSync(out, `${nowIso()}\t${line}\n`);
      process.stdout.write(line + "\n");
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);

  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    fs.writeSync(out, `${nowIso()}\tMASP serve stopping (${why})\n`);
    killTree(child.pid!);
  };
  process.on("SIGINT", () => stop("Ctrl+C"));
  process.on("SIGTERM", () => stop("signal"));
  const poll = setInterval(() => { if (fs.existsSync(stopFile)) stop("masp serve --stop"); }, 300);

  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 0)));
  clearInterval(poll);
  fs.writeSync(out, `${nowIso()}\tMASP serve ended (shopify exit ${code})\n`);
  fs.closeSync(out);
  fs.rmSync(store.p("serve.json"), { force: true });
  fs.rmSync(stopFile, { force: true });
  return stopping ? 0 : code;
}

export async function serveStop(ctx: Ctx, timeoutMs = 20000): Promise<{ wasRunning: boolean; stopped: boolean }> {
  let info: ServeInfo | null = null;
  try { info = JSON.parse(fs.readFileSync(ctx.store.p("serve.json"), "utf8")); } catch { /* none */ }
  if (!info) return { wasRunning: false, stopped: true };
  if (!pidAlive(info.pid)) {
    // masp serve died without cleaning up: stop its Shopify process directly.
    killTree(info.childPid);
    fs.rmSync(ctx.store.p("serve.json"), { force: true });
    return { wasRunning: true, stopped: true };
  }
  atomicWriteFile(ctx.store.p("control", "serve-stop"), nowIso());
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(ctx.store.p("serve.json"))) {
    if (Date.now() > deadline) {
      killTree(info.childPid);
      return { wasRunning: true, stopped: false };
    }
    await sleep(200);
  }
  return { wasRunning: true, stopped: true };
}

// ---------------------------------------------------------------- sync report

export interface SyncReport {
  serving: ServeInfo | null;
  startedAt: string | null;
  confirmed: { path: string; session: string; publishedAt: string; syncedAt: string }[];
  failed: { path: string; session: string; publishedAt: string; failedAt: string; message: string }[];
  pending: { path: string; session: string; publishedAt: string; ageMs: number }[];
  beforeStart: number;     // published before the server started: uploaded by its start-up sync, not itemised
  errors: string[];        // other error output from the CLI, not tied to one file
}

const SYNCED = /Synced\s*»\s*(update|delete)\s+(\S+)/;
const FAILED = /Failed to upload file "([^"]+)"/;
const boxText = (t: string) => t.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Compare MASP's publishes with what the Shopify CLI printed:
 *   "Synced » update <path>"            upload confirmed
 *   "Failed to upload file "<path>""     Shopify rejected it (the box that follows holds the reason)
 * For each file, the latest CLI event after MASP's latest publish of it decides its state.
 */
export function syncReport(ctx: Ctx, state: State): SyncReport {
  const serving = serveInfo(ctx);
  const rep: SyncReport = { serving, startedAt: null, confirmed: [], failed: [], pending: [], beforeStart: 0, errors: [] };
  let lines: string[];
  try {
    lines = fs.readFileSync(ctx.store.p("shopify-dev.log"), "utf8").split("\n");
  } catch {
    return rep;
  }
  const start = lines.find((l) => l.includes("\tMASP serve started"));
  if (!start) return rep;
  rep.startedAt = start.split("\t")[0];
  const events = new Map<string, { at: string; ok: boolean; message?: string }[]>();
  const push = (p: string, e: { at: string; ok: boolean; message?: string }) => {
    const list = events.get(p) ?? [];
    list.push(e);
    events.set(p, list);
  };
  let open: { path: string; at: string; parts: string[] } | null = null;
  const close = () => {
    if (open) push(open.path, { at: open.at, ok: false, message: open.parts.join(" ").slice(0, 300) });
    open = null;
  };
  for (const l of lines) {
    const tab = l.indexOf("\t");
    if (tab < 0) continue;
    const at = l.slice(0, tab);
    const text = l.slice(tab + 1);
    const failed = FAILED.exec(text);
    if (failed) {
      close();
      open = { path: failed[1], at, parts: [] };
      continue;
    }
    if (open) {
      if (text.includes("╰")) close();
      else if (boxText(text)) open.parts.push(boxText(text));
      continue;
    }
    const m = SYNCED.exec(text);
    if (m) push(m[2], { at, ok: true });
    else if (/\berror\b|failed/i.test(text) && !/error-overlay/i.test(text) && boxText(text).toLowerCase() !== "error")
      rep.errors.push(`${at} ${boxText(text).slice(0, 200)}`);
  }
  close();
  const now = Date.now();
  for (const [p, prov] of Object.entries(state.provenance)) {
    if (prov.session === "base" || !prov.at) continue;
    if (prov.at < rep.startedAt) {
      rep.beforeStart++;
      continue;
    }
    const after = (events.get(p) ?? []).filter((e) => e.at >= prov.at!);
    const last = after.at(-1);
    if (!last) rep.pending.push({ path: p, session: prov.session, publishedAt: prov.at, ageMs: now - Date.parse(prov.at) });
    else if (last.ok) rep.confirmed.push({ path: p, session: prov.session, publishedAt: prov.at, syncedAt: last.at });
    else rep.failed.push({ path: p, session: prov.session, publishedAt: prov.at, failedAt: last.at, message: last.message ?? "" });
  }
  return rep;
}

export function syncLevel(ctx: Ctx, state: State): string {
  const r = syncReport(ctx, state);
  if (!r.startedAt) return "unconfirmed: start the preview with 'masp serve --store <dev store>' to track uploads";
  const where = r.serving ? `serving ${r.serving.store} on port ${r.serving.port}` : "server NOT running (last run's log)";
  const parts = [`${r.confirmed.length} publish(es) confirmed uploaded`];
  if (r.failed.length) parts.push(`${r.failed.length} REJECTED by Shopify: ${r.failed.map((f) => f.path).join(", ")}`);
  if (r.pending.length) parts.push(`${r.pending.length} WAITING (oldest ${Math.round(Math.max(...r.pending.map((p) => p.ageMs)) / 1000)} s: ${r.pending.slice(0, 3).map((p) => p.path).join(", ")})`);
  if (r.errors.length) parts.push(`${r.errors.length} other error line(s) in the CLI log; last: ${r.errors.at(-1)}`);
  if (r.beforeStart) parts.push(`${r.beforeStart} published before start (covered by the start-up upload)`);
  return `${where}; ${parts.join("; ")}`;
}

export const SERVE_LOG = (ctx: Ctx) => path.relative(ctx.cfg.root, ctx.store.p("shopify-dev.log"));
