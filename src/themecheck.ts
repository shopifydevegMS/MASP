// Runs Shopify Theme Check on the unified preview, offline and read-only.
// Never passes --auto-correct or --init: both would write into the preview.
// A passing check does not prove the storefront renders correctly.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Ctx } from "./context.ts";
import type { State } from "./store.ts";
import { atomicWriteFile, nowIso, sha256, toPosix } from "./util.ts";

export interface ThemeCheckResult {
  at: string;
  previewDigest: string;       // which preview version was checked
  consistent: boolean;         // false if the preview changed while the check ran
  durationMs: number;
  exitCode: number | null;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  offenses: { path: string; check: string; severity: string; line: number; message: string }[];
  failure?: string;            // the CLI could not run or produced unreadable output
}

/** Fingerprint of the preview manifest: changes whenever any preview file changes. */
export function previewDigest(state: State): string {
  return sha256(Object.keys(state.preview).sort().map((p) => `${p}\0${state.preview[p]}`).join("\n"));
}

export function lastThemeCheck(ctx: Ctx): ThemeCheckResult | null {
  try {
    return JSON.parse(fs.readFileSync(ctx.store.p("theme-check.json"), "utf8"));
  } catch {
    return null;
  }
}

export function runThemeCheck(ctx: Ctx, opts: { bin?: string } = {}): ThemeCheckResult {
  const preview = ctx.cfg.preview;
  if (preview.includes('"')) throw new Error("preview path must not contain quotes");
  const before = previewDigest(ctx.store.readState());
  const t0 = Date.now();
  const bin = opts.bin ?? process.env.MASP_SHOPIFY_BIN ?? "shopify";
  // shell is needed on Windows because 'shopify' is a .cmd shim; every argument is fixed or quoted.
  if (!/^[\w.\-\\/:]+$/.test(bin)) throw new Error("MASP_SHOPIFY_BIN must be a plain command or path");
  const command = `${bin} theme check --path "${preview}" --output json --no-color --fail-level crash`;
  const r = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const after = previewDigest(ctx.store.readState());
  const res: ThemeCheckResult = {
    at: nowIso(), previewDigest: before, consistent: before === after, durationMs: Date.now() - t0,
    exitCode: r.status, errorCount: 0, warningCount: 0, infoCount: 0, offenses: [],
  };
  const start = (r.stdout ?? "").indexOf("[");
  let parsed: any[] | null = null;
  if (start >= 0) {
    try {
      parsed = JSON.parse(r.stdout.slice(start));
    } catch { /* handled below */ }
  }
  if (!Array.isArray(parsed)) {
    res.failure = `Theme Check did not produce JSON (exit ${r.status}): ${(r.error?.message ?? r.stderr ?? "").trim().slice(0, 500)}`;
  } else {
    for (const file of parsed) {
      const rel = toPosix(path.relative(preview.toLowerCase(), String(file.path).toLowerCase()));
      // Theme Check reports lower-cased Windows paths; map back to the real relative path.
      const real = Object.keys(ctx.store.readState().preview).find((p) => p.toLowerCase() === rel) ?? rel;
      for (const o of file.offenses ?? []) {
        res.offenses.push({ path: real, check: o.check, severity: o.severity, line: (o.start_row ?? 0) + 1, message: o.message });
        if (o.severity === "error") res.errorCount++;
        else if (o.severity === "warning") res.warningCount++;
        else res.infoCount++;
      }
    }
  }
  atomicWriteFile(ctx.store.p("theme-check.json"), JSON.stringify(res, null, 1));
  return res;
}

/** Theme Check checks that are about one file's own validity (meaningful on a file checked alone). */
export const SYNTAX_CHECKS = new Set([
  "LiquidSyntaxError", "LiquidHTMLSyntaxError", "UnknownFilter", "ValidSchema", "ValidSchemaName",
  "ValidJSON", "JSONSyntaxError", "UniqueSettingId", "UniqueStaticBlockId", "ValidBlockTarget",
]);

/**
 * Quick Theme Check on a few files, copied alone into a temp folder (about 2 s instead of a whole-theme run).
 * Only SYNTAX_CHECKS are kept: missing-file checks would be noise here, and MASP checks dependencies itself.
 * Returns null if the Shopify CLI is not available.
 */
export function quickCheck(ctx: Ctx, files: { path: string; buf: Buffer }[]): { offenses: ThemeCheckResult["offenses"]; failure?: string } | null {
  if (!files.length) return { offenses: [] };
  const dir = ctx.store.p("tmp", `qc-${process.pid}-${Date.now()}`);
  try {
    for (const f of files) {
      const dst = path.join(dir, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.buf);
    }
    const bin = process.env.MASP_SHOPIFY_BIN ?? "shopify";
    const r = spawnSync(`${bin} theme check --path "${dir}" --output json --no-color --fail-level crash`, {
      shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000,
    });
    const start = (r.stdout ?? "").indexOf("[");
    if (start < 0) {
      if (/not recognized|not found|ENOENT/i.test((r.stderr ?? "") + (r.error?.message ?? ""))) return null;
      return { offenses: [], failure: `Theme Check did not run: ${(r.stderr ?? "").trim().slice(0, 200)}` };
    }
    const offenses: ThemeCheckResult["offenses"] = [];
    for (const file of JSON.parse(r.stdout.slice(start)) as any[]) {
      const rel = toPosix(path.relative(dir.toLowerCase(), String(file.path).toLowerCase()));
      const real = files.find((f) => f.path.toLowerCase() === rel)?.path ?? rel;
      for (const o of file.offenses ?? [])
        if (SYNTAX_CHECKS.has(o.check)) offenses.push({ path: real, check: o.check, severity: o.severity, line: (o.start_row ?? 0) + 1, message: o.message });
    }
    return { offenses };
  } catch (e) {
    return { offenses: [], failure: (e as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One line for `masp status`. */
export function themeCheckLevel(ctx: Ctx, state: State): string {
  const last = lastThemeCheck(ctx);
  if (!last) return "not run ('masp check')";
  if (last.failure) return `could not run at ${last.at}: ${last.failure.slice(0, 120)}`;
  const summary = `${last.errorCount} error(s), ${last.warningCount} warning(s)`;
  if (!last.consistent) return `${summary}, but the preview changed during the check: run 'masp check' again`;
  if (last.previewDigest !== previewDigest(state)) return `${summary} at ${last.at}; OUTDATED: the preview changed since`;
  return `${summary} on the current preview (${last.at})`;
}
