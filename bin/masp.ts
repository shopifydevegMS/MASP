#!/usr/bin/env node
// MASP command line. Run with: node bin/masp.ts <command> [options]
import { openCtx } from "../src/context.ts";
import * as cmd from "../src/commands.ts";
import { runController } from "../src/controller.ts";
import { LockHeldError } from "../src/lock.ts";
import { gc } from "../src/gc.ts";
import { serve, serveStop } from "../src/serve.ts";
import { land, resync } from "../src/land.ts";
import { newWorkspace } from "../src/setup.ts";
import { prepareAgentFiles } from "../src/agents.ts";

const HELP = `MASP v1: Multi-Agent Shopify Protocol (local integration controller)

Usage: masp <command> [options]      (global: --config <file>, --json)

  new <folder> --repo <path|url> [--branch main] [--sessions A,B] [--prefix masp-]
                                  create a workspace: fresh clone, one worktree per session, preview
  agent --session <id>            how to start an AI session (writes its rules and permissions)
  init [--base <commit>]          create the preview folder and MASP state from a commit
  start                           run the integration controller (Ctrl+C or 'masp stop' to end)
  stop                            ask a running controller to exit cleanly
  status                          sessions, pending files, conflicts, preview and sync state
  ready --session <id> [--files a,b] [--message "..."] [--no-wait]
                                  declare a change set ready (shared/critical files, deletions)
                                  [--rebased <path>@<hash>]  after merging the preview version by hand
  lint --session <id> [--files a,b] [--rebased <path>@<hash>]
                                  dry run of 'ready': same checks, nothing is published
  show <path>                     print the preview's current version of a file and its hash
  integrate                       run one integration pass now (when no controller is running)
  conflicts                       list blocked changes and files waiting on dependencies
  diff [--patch]                  preview vs base commit, with which session made each change
  verify                          check the preview folder against MASP records and validate it
  check                           run 'shopify theme check' on the preview (offline)
  recover [--restore-preview]     finish or roll back interrupted publishes; with
                                  --restore-preview, put MASP's versions back (outside versions are saved)
  preview                         print the Shopify command for the unified preview (does not run it)
  serve --store <dev store> [--port 9292]
                                  run the ONE 'shopify theme dev' on the preview (safe flags only) and
                                  record its uploads for 'masp status'; Ctrl+C or 'masp serve --stop' ends it
  land [--message "..."] [--branch main] [--yes] [--force]
                                  after reviewing the Shopify preview: commit exactly what it shows onto
                                  main as one commit (dry run unless --yes; never pushes)
  resync --session <id> [--yes]   move a finished session's worktree onto the latest landed commit
  gc [--keep N] [--apply]         clean up old checkpoints and unused snapshots (dry run unless --apply)
`;

function parse(argv: string[]) {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["json", "patch", "no-wait", "restore-preview", "help", "apply", "stop", "yes", "force"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { args, flags };
}

function print(json: boolean, value: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human();
}

async function main(): Promise<number> {
  const { args, flags } = parse(process.argv.slice(2));
  const command = args[0];
  const json = flags.json === true;
  if (!command || flags.help || command === "help") {
    console.log(HELP);
    return 0;
  }
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  if (command === "new") {
    // Runs before any workspace exists, so it does not open a config.
    if (!args[1] || !str("repo")) throw new Error("usage: masp new <folder> --repo <path or url> [--branch main] [--sessions A,B] [--prefix masp-]");
    const r = newWorkspace({ folder: args[1], repo: str("repo")!, branch: str("branch"), sessions: str("sessions")?.split(",").map((x) => x.trim()).filter(Boolean), prefix: str("prefix") });
    print(json, r, () => {
      console.log(`Workspace ready: ${r.folder}`);
      console.log(`  branch '${r.branch}' at ${r.baseCommit.slice(0, 10)}, ${r.files} theme files in preview\\`);
      for (const s of r.sessions) console.log(`  session ${s.id}: worktrees\\${s.id.toLowerCase()} (branch ${s.branch})`);
      console.log(`\nNext, from ${r.folder}:`);
      console.log(`  masp start                                   (terminal 1: the controller)`);
      console.log(`  masp serve --store <your-dev-store>          (terminal 2: the one Shopify preview)`);
      for (const s of r.sessions) console.log(`  & '${s.startScript}'   (an AI session for ${s.id})`);
    });
    return 0;
  }
  const ctx = openCtx(typeof flags.config === "string" ? flags.config : undefined, json ? () => {} : undefined);

  switch (command) {
    case "init": {
      const r = cmd.init(ctx, { base: str("base") });
      print(json, r, () => {
        console.log(`Initialised. Base commit ${r.baseCommit.slice(0, 10)}, ${r.files} theme files in ${r.preview}`);
        for (const id of r.registered) console.log(`  session ${id}: registered`);
        for (const [id, e] of Object.entries(r.errors)) console.log(`  session ${id}: NOT registered: ${e}`);
      });
      return Object.keys(r.errors).length ? 2 : 0;
    }
    case "start":
      return await runController(ctx);
    case "stop": {
      const r = await cmd.stop(ctx);
      print(json, r, () => console.log(!r.wasRunning ? "No controller is running." : r.stopped ? "Controller stopped." : "Controller did not stop in time."));
      return r.stopped ? 0 : 1;
    }
    case "integrate": {
      const r = await cmd.integrate(ctx);
      print(json, r, () => {
        for (const t of r.recovered) console.log(`recovery: ${t.txn} ${t.action}`);
        for (const [id, e] of Object.entries(r.registrationErrors)) console.log(`session ${id} not registered: ${e}`);
        if (r.refused) console.log(`REFUSED: ${r.refused}`);
        if (!r.checkpoints.length && !r.refused) console.log("Nothing to integrate.");
      });
      return r.refused ? 3 : 0;
    }
    case "ready": {
      const session = str("session") ?? process.env.MASP_SESSION;
      if (!session) throw new Error("--session is required (or set MASP_SESSION)");
      const files = str("files")?.split(",").map((f) => f.trim()).filter(Boolean);
      const rebased = str("rebased")?.split(",").map((f) => f.trim()).filter(Boolean);
      const r = await cmd.ready(ctx, { session, files, message: str("message"), wait: flags["no-wait"] !== true, rebased });
      print(json, r, () => {
        if (!r.request) return console.log(r.note);
        console.log(`Ready signal ${r.request.id}: ${Object.keys(r.request.files).length} file(s): ${Object.keys(r.request.files).join(", ")}`);
        if (!r.outcome) return console.log(r.note);
        console.log(`Outcome: ${r.outcome.outcome.toUpperCase()} (checkpoint ${r.outcome.checkpoint})`);
        for (const p of r.outcome.problems) console.log(`  ${p.kind}: ${p.detail}`);
      });
      if (!r.outcome) return r.request ? 0 : 0;
      return r.outcome.outcome === "published" || r.outcome.outcome === "noop" ? 0 : 4;
    }
    case "agent": {
      const session = str("session") ?? process.env.MASP_SESSION;
      if (!session) throw new Error("--session is required");
      const s = ctx.cfg.sessions.find((x) => x.id === session);
      if (!s) throw new Error(`unknown session '${session}'`);
      const f = prepareAgentFiles(ctx.cfg, s);
      print(json, f, () => {
        console.log(`Session ${s.id} works in ${s.worktree}`);
        console.log(`  rules:        ${f.rulesFile}`);
        console.log(`  permissions:  ${f.settingsFile}`);
        console.log(`\nStart it in a new PowerShell terminal:\n  & '${f.startScript}'`);
        console.log(`\nOther AI tools: open ${s.worktree} as the working folder, give it the rules file above as instructions,`);
        console.log(`set MASP_CONFIG=${ctx.cfg.configPath} and MASP_SESSION=${s.id}, and put ${f.binDir} on PATH (see docs/providers.md).`);
      });
      return 0;
    }
    case "lint": {
      const session = str("session") ?? process.env.MASP_SESSION;
      if (!session) throw new Error("--session is required (or set MASP_SESSION)");
      const files = str("files")?.split(",").map((f) => f.trim()).filter(Boolean);
      const rebased = str("rebased")?.split(",").map((f) => f.trim()).filter(Boolean);
      const r = cmd.lint(ctx, { session, files, rebased });
      print(json, r, () => {
        console.log(`Lint (${r.note}): ${r.ok ? "OK" : "PROBLEMS FOUND"}`);
        if (r.result) {
          const readyOk = r.result.outcome === "would-publish" || r.result.outcome === "noop";
          console.log(`  'masp ready' would ${readyOk && !r.result.problems.some((p) => p.kind === "theme-check") ? "publish" : "REJECT"} your unintegrated changes:`);
          for (const f of r.result.files) console.log(`    ${f.action.padEnd(9)} ${f.path}`);
          for (const p of r.result.problems) console.log(`    ${p.kind}: ${p.path}: ${p.detail}`);
        }
        const tc = r.themeCheck;
        if (tc.skipped) console.log(`  Theme Check: skipped (${tc.skipped})`);
        else {
          console.log(`  Theme Check (syntax and schema) on ${tc.checked.length} file(s) you changed: ${tc.offenses.length ? "" : "no problems"}`);
          for (const o of tc.offenses) console.log(`    ${o.severity.toUpperCase()} ${o.path}:${o.line} ${o.check}: ${o.message}`);
        }
      });
      return r.ok ? 0 : 4;
    }
    case "show": {
      if (!args[1]) throw new Error("usage: masp show <path>");
      const r = cmd.show(ctx, args[1]);
      print(json, r, () => {
        if (!r.hash) return console.log(`${r.path} is not in the preview.`);
        console.error(`# ${r.path}  version ${r.hash.slice(0, 16)}  (from session ${r.by})`);
        console.error(`# after merging your change into this version, check:  masp lint --session <id> --rebased ${r.path}@${r.hash.slice(0, 16)}`);
        console.error(`# then signal:  masp ready --session <id> --files ${r.path} --rebased ${r.path}@${r.hash.slice(0, 16)}`);
        process.stdout.write(r.content ?? "");
      });
      return 0;
    }
    case "status": {
      const r = cmd.status(ctx);
      print(json, r, () => {
        if (!r.initialised) return console.log("Not initialised. Run 'masp init'.");
        console.log(`Controller:        ${r.controller ? `running (pid ${r.controller.pid}, ${r.controller.command})` : "not running"}`);
        console.log(`Base commit:       ${r.baseCommit?.slice(0, 10)}`);
        console.log(`Preview:           ${r.preview} (${r.previewFiles} files, last publish ${r.lastPublishAt ?? "never"})`);
        console.log(`Local integration: ${r.levels.localIntegration}`);
        console.log(`Local preview:     ${r.levels.localPreview}`);
        console.log(`Theme Check:       ${r.levels.themeCheck}`);
        console.log(`Shopify sync:      ${r.levels.shopifySync}`);
        console.log(`Visual check:      ${r.levels.visualCheck}`);
        if (r.needsReconciliation) console.log(`\n!! ${r.needsReconciliation.reason}`);
        if (r.interrupted.length) console.log(`!! interrupted transactions: ${r.interrupted.join(", ")}`);
        for (const d of r.drift) console.log(`!! preview file changed outside MASP: ${d.path}`);
        for (const s of r.sessions) {
          console.log(`\nSession ${s.id}${s.task ? ` (${s.task})` : ""}: ${s.registered ? (s.active ? "active" : "inactive") : "NOT REGISTERED"}`);
          if (s.problem) console.log(`  !! ${s.problem}`);
          for (const w of s.warnings) console.log(`  note: ${w}`);
          for (const u of s.uploadFailures ?? []) console.log(`  !! Shopify REJECTED ${u.path} (published by this session): ${u.message}`);
          if (!s.files.length) console.log("  no unintegrated changes");
          for (const f of s.files) console.log(`  ${f.state.padEnd(19)} ${f.path}${f.detail ? `  (${f.detail})` : ""}`);
        }
      });
      return 0;
    }
    case "conflicts": {
      const r = cmd.conflicts(ctx);
      print(json, r, () => {
        if (!r.conflicts.length && !r.held.length) return console.log("No conflicts.");
        for (const c of r.conflicts) console.log(`[${c.session}] ${c.kind.padEnd(19)} ${c.path}\n    ${c.detail}`);
        for (const h of r.held) console.log(`[${h.session}] held               ${h.path}\n    ${h.detail}`);
      });
      return r.conflicts.length ? 5 : 0;
    }
    case "diff": {
      const r = cmd.diff(ctx, { patch: flags.patch === true });
      print(json, r, () => {
        if (!r.rows.length) return console.log(`Preview is identical to base commit ${r.baseCommit.slice(0, 10)}.`);
        console.log(`Preview vs base commit ${r.baseCommit.slice(0, 10)}:`);
        for (const x of r.rows) console.log(`  ${x.change.padEnd(9)} ${x.path}  [session ${x.by}${x.checkpoint ? `, ${x.checkpoint}` : ""}]`);
        if (r.patch) console.log("\n" + r.patch);
      });
      return 0;
    }
    case "verify": {
      const r = cmd.verify(ctx);
      print(json, r, () => {
        for (const d of r.drift) console.log(`DRIFT   ${d.path} (changed outside MASP)`);
        for (const i of r.issues) console.log(`${i.severity.toUpperCase().padEnd(7)} ${i.path}: ${i.message}`);
        if (!r.drift.length && !r.issues.length) console.log("Preview matches MASP records and passes local checks.");
      });
      return r.drift.length || r.issues.some((i) => i.severity === "error") ? 6 : 0;
    }
    case "check": {
      if (!json) console.log("Running Shopify Theme Check on the preview (offline, read-only)...");
      const r = cmd.themeCheck(ctx);
      print(json, r, () => {
        if (r.failure) return console.log(`Theme Check could not run: ${r.failure}`);
        for (const o of r.offenses) console.log(`${o.severity.toUpperCase().padEnd(8)} ${o.path}:${o.line}  ${o.check}: ${o.message}`);
        console.log(`${r.errorCount} error(s), ${r.warningCount} warning(s), ${r.infoCount} info in ${(r.durationMs / 1000).toFixed(1)} s`);
        if (!r.consistent) console.log("The preview changed while the check ran; run it again for a reliable result.");
        console.log("Theme Check does not prove the storefront renders correctly; review the preview visually.");
      });
      return r.failure ? 1 : r.errorCount || !r.consistent ? 7 : 0;
    }
    case "recover": {
      const r = cmd.recover(ctx, { restorePreview: flags["restore-preview"] === true });
      print(json, r, () => {
        if (!r.transactions.length && !r.restored.length && !r.remaining) console.log("Nothing to recover.");
        for (const t of r.transactions) {
          console.log(`transaction ${t.txn}: ${t.action}${t.reverted.length ? ` (reverted ${t.reverted.join(", ")})` : ""}`);
          for (const u of t.unexpected) console.log(`  unexpected content in ${u.path}`);
        }
        for (const x of r.restored) console.log(`restored ${x.path}${x.savedOutsideVersion ? ` (outside version saved as ${x.savedOutsideVersion.slice(0, 12)})` : ""}`);
        if (r.reportFile) console.log(`report: ${r.reportFile}`);
        if (r.remaining) console.log(`STILL NEEDS RECONCILIATION: ${r.remaining}\nInspect with 'masp verify', then run 'masp recover --restore-preview' to put MASP's versions back.`);
      });
      return r.remaining ? 3 : 0;
    }
    case "serve": {
      if (flags.stop === true) {
        const r = await serveStop(ctx);
        print(json, r, () => console.log(!r.wasRunning ? "No preview server is running." : r.stopped ? "Preview server stopped." : "Preview server did not stop in time; its process tree was killed."));
        return 0;
      }
      const storeName = str("store");
      if (!storeName) throw new Error("--store <development store> is required, e.g. --store my-dev-store.myshopify.com");
      return await serve(ctx, { store: storeName, port: str("port") ? Number(str("port")) : undefined });
    }
    case "land": {
      const r = land(ctx, { message: str("message"), branch: str("branch"), yes: flags.yes === true, force: flags.force === true });
      print(json, r, () => {
        if (r.recorded === "recovered") return console.log(`Recorded an earlier landing that had reached Git: ${r.commit!.slice(0, 10)} on ${r.branch}.`);
        console.log(`${r.commit ? "LANDED" : r.blockers.length ? "CANNOT LAND" : "Would land (dry run; add --yes)"}: ${r.files.length} file(s) onto '${r.branch}' (base ${r.base.slice(0, 10)})`);
        for (const f of r.files) console.log(`  ${f.change.padEnd(9)} ${f.path}  [${f.by.join(", ")}]`);
        for (const b of r.blockers) console.log(`  BLOCKED: ${b}`);
        for (const w of r.warnings) console.log(`  note: ${w}`);
        if (r.commit) {
          console.log(`\nCommit ${r.commit.slice(0, 10)} is on '${r.branch}'. Nothing was pushed.`);
          for (const n of r.next ?? []) console.log(`  ${n}`);
        }
      });
      return r.blockers.length ? 9 : 0;
    }
    case "resync": {
      const session = str("session") ?? process.env.MASP_SESSION;
      if (!session) throw new Error("--session is required");
      const r = resync(ctx, { session, yes: flags.yes === true });
      print(json, r, () => {
        if (r.done) return console.log(`Session ${r.session} now starts from ${r.to.slice(0, 10)} (was ${r.from.slice(0, 10)}).`);
        if (r.blockers.length) { console.log(`Cannot resync session ${r.session}:`); for (const b of r.blockers) console.log(`  - ${b}`); return; }
        console.log(`Would move session ${r.session} from ${r.from.slice(0, 10)} to ${r.to.slice(0, 10)} (dry run; add --yes). Its worktree is reset to that commit; nothing unpublished is lost.`);
      });
      return r.blockers.length && !r.done ? 9 : 0;
    }
    case "gc": {
      const keep = str("keep") ? Number(str("keep")) : undefined;
      const r = gc(ctx, { apply: flags.apply === true, keep });
      const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
      print(json, r, () => {
        console.log(`${r.applied ? "Removed" : "Would remove (dry run; add --apply)"}:`);
        console.log(`  ${r.checkpoints.remove} of ${r.checkpoints.total} checkpoint records (keeping the newest ${r.keep}), ${r.requests.remove} processed Ready requests`);
        console.log(`  ${r.blobs.remove} of ${r.blobs.total} snapshots no longer referenced (${mb(r.blobs.bytes)})`);
        console.log(`  ${r.other.remove.length} leftover staging/temp/stale-lock item(s) (${mb(r.other.bytes)})`);
        console.log(`Kept: ${r.kept.blobs} snapshots (${mb(r.kept.bytes)}) still needed by the preview, sessions, conflicts or kept checkpoints; the journal is never trimmed.`);
      });
      return 0;
    }
    case "preview": {
      const r = cmd.previewCommand(ctx);
      print(json, { ...r, rules: cmd.PREVIEW_RULES }, () => {
        if (r.blockers.length) {
          console.log("NOT READY to serve the preview:");
          for (const b of r.blockers) console.log(`  - ${b}`);
          return;
        }
        for (const n of r.notes) console.log(`note: ${n}`);
        console.log(`\n  ${r.command}\n`);
        for (const l of cmd.PREVIEW_RULES) console.log(l);
      });
      return r.ready ? 0 : 8;
    }
    default:
      console.error(`unknown command '${command}'\n\n${HELP}`);
      return 1;
  }
}

main().then((code) => process.exit(code), (e) => {
  if (e instanceof LockHeldError) console.error(`MASP: ${e.message}`);
  else console.error(`MASP error: ${(e as Error).message}`);
  process.exit(e instanceof LockHeldError ? 10 : 1);
});
