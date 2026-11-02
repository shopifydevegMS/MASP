// `masp land` (reviewed preview -> one commit on main) and `masp resync`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";
import { land, resync } from "../src/land.ts";
import { sha256, canonicalize } from "../src/util.ts";

const g = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const SECTION = (c: string) => `<section class="${c}">x</section>\n{% schema %}\n{ "name": "${c}", "presets": [{ "name": "${c}" }] }\n{% endschema %}\n`;

async function twoSessionsOfWork(sb: Sandbox) {
  sb.write("A", "assets/dev1.css", ".a { color: red; }\n");
  sb.write("A", "sections/a-promo.liquid", SECTION("a-promo"));
  sb.editJson("A", "templates/index.json", (v) => { v.sections.a_promo = { type: "a-promo", settings: {} }; v.order.push("a_promo"); });
  sb.write("B", "sections/b-promo.liquid", SECTION("b-promo"));
  sb.editJson("B", "templates/index.json", (v) => { v.sections.b_promo = { type: "b-promo", settings: {} }; v.order.unshift("b_promo"); });
  await cmd.integrate(sb.ctx());
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "published");
}

test("land: the reviewed preview becomes exactly one commit on main; nothing else moves", async (t) => {
  const sb = new Sandbox("land");
  t.after(() => sb.cleanup());
  await twoSessionsOfWork(sb);
  const before = { main: g(sb.repo, ["rev-parse", "main"]), a: g(sb.repo, ["rev-parse", "session-a"]), b: g(sb.repo, ["rev-parse", "session-b"]) };

  const dry = land(sb.ctx());
  assert.equal(dry.blockers.length, 0, dry.blockers.join("\n"));
  assert.equal(dry.commit, undefined);
  assert.deepEqual(dry.files.map((f) => `${f.change} ${f.path}`), [
    "modified assets/dev1.css", "added sections/a-promo.liquid", "added sections/b-promo.liquid", "modified templates/index.json",
  ]);
  assert.deepEqual(dry.files.find((f) => f.path === "templates/index.json")!.by.sort(), ["A", "B"]);
  assert.equal(g(sb.repo, ["rev-parse", "main"]), before.main, "dry run changed nothing");

  const r = land(sb.ctx(), { yes: true, message: "Add A and B promos" });
  assert.equal(r.recorded, "landed");
  const commit = g(sb.repo, ["rev-parse", "main"]);
  assert.equal(commit, r.commit);
  assert.equal(g(sb.repo, ["rev-parse", "main^"]), before.main, "exactly one commit on top of the base");
  assert.match(g(sb.repo, ["log", "-1", "--format=%B", "main"]), /Add A and B promos[\s\S]*Sessions: A, B/);
  // Every theme file in the commit equals the preview (as MASP compares: line endings normalised).
  const state = sb.ctx().store.readState();
  for (const p of Object.keys(state.preview)) {
    const blob = execFileSync("git", ["show", `main:${p}`], { cwd: sb.repo });
    assert.equal(sha256(canonicalize(blob)), state.preview[p], p);
  }
  // The main checkout was fast-forwarded and is clean; session branches did not move; no remote touched.
  assert.equal(g(sb.repo, ["status", "--porcelain"]), "");
  assert.match(fs.readFileSync(path.join(sb.repo, "templates", "index.json"), "utf8"), /b_promo[\s\S]*a_promo/);
  assert.equal(g(sb.repo, ["rev-parse", "session-a"]), before.a);
  assert.equal(g(sb.repo, ["rev-parse", "session-b"]), before.b);
  assert.equal(g(sb.repo, ["remote"]), "");
  // MASP now builds on the new commit: nothing left to land.
  assert.equal(cmd.diff(sb.ctx()).rows.length, 0);
  assert.match(land(sb.ctx()).blockers.join(), /nothing to land/);

  // Sessions keep working from their old start commit without disruption.
  sb.write("A", "assets/dev1.css", ".a { color: green; }\n");
  await cmd.integrate(sb.ctx());
  assert.match(sb.readPreview("assets/dev1.css")!, /green/);
  sb.editJson("B", "templates/index.json", (v) => (v.sections.b_promo.settings.x = 1));
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "published");
  const v = JSON.parse(sb.readPreview("templates/index.json")!.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
  assert.ok(v.sections.a_promo && v.sections.b_promo.settings.x === 1, "B's later change merged without dropping A's landed section");
});

test("land onto a developer's own branch (team setup: one branch per developer, PRs into main)", async (t) => {
  const sb = new Sandbox("land-dev", { extraConfig: { landBranch: "dev1" } });
  t.after(() => sb.cleanup());
  g(sb.repo, ["branch", "dev1", sb.baseCommit]);
  const main = g(sb.repo, ["rev-parse", "main"]);
  await twoSessionsOfWork(sb);
  const r = land(sb.ctx(), { yes: true, message: "dev1: promos" });
  assert.equal(r.branch, "dev1");
  assert.equal(g(sb.repo, ["rev-parse", "dev1"]), r.commit);
  assert.equal(g(sb.repo, ["rev-parse", "dev1^"]), sb.baseCommit);
  assert.equal(g(sb.repo, ["rev-parse", "main"]), main, "main is not touched");
  assert.equal(g(sb.repo, ["status", "--porcelain"]), "", "the main checkout is untouched (dev1 is not checked out)");
  // An ordinary merge into main afterwards (what a pull request does) works.
  g(sb.repo, ["merge", "-q", "--ff-only", "dev1"]);
  assert.equal(g(sb.repo, ["rev-parse", "main"]), r.commit);
});

test("land refuses when main moved, the preview drifted, or Shopify rejected a file", async (t) => {
  const sb = new Sandbox("land2");
  t.after(() => sb.cleanup());
  await twoSessionsOfWork(sb);

  // Shopify rejected an upload (as recorded by 'masp serve').
  const pub = sb.ctx().store.readState().provenance["sections/a-promo.liquid"].at!;
  const t0 = new Date(Date.parse(pub) - 1000).toISOString();
  const t1 = new Date(Date.parse(pub) + 1000).toISOString();
  fs.writeFileSync(path.join(sb.data, "shopify-dev.log"),
    `${t0}\tMASP serve started: shopify theme dev ...\n${t1}\t│  Failed to upload file "sections/a-promo.liquid" to remote theme.  │\n${t1}\t│  Liquid syntax error (line 1): x  │\n${t1}\t╰────╯\n`);
  assert.match(land(sb.ctx(), { yes: true }).blockers.join("\n"), /Shopify rejected sections\/a-promo.liquid/);
  assert.equal(land(sb.ctx(), { force: true }).blockers.length, 0, "--force overrides only that blocker");
  fs.rmSync(path.join(sb.data, "shopify-dev.log"));

  // Someone changed the preview by hand.
  fs.writeFileSync(path.join(sb.preview, "assets", "dev2.css"), "/* hand edit */");
  assert.match(land(sb.ctx(), { yes: true }).blockers.join("\n"), /changed outside MASP/);
  cmd.recover(sb.ctx(), { restorePreview: true });

  // main gets a commit MASP has not seen (e.g. Shopify's GitHub integration).
  fs.writeFileSync(path.join(sb.repo, "assets", "base.css"), "body { margin: 1px; }\n");
  g(sb.repo, ["commit", "-qam", "Update from Shopify"]);
  const moved = g(sb.repo, ["rev-parse", "main"]);
  const r = land(sb.ctx(), { yes: true });
  assert.match(r.blockers.join("\n"), /'main' has moved since the preview was built[\s\S]*Update from Shopify/);
  assert.equal(g(sb.repo, ["rev-parse", "main"]), moved, "main untouched");
  assert.equal(sb.masp(["land", "--yes"]).code, 9);
});

test("land: a crash after the commit reached Git is recorded on the next run", async (t) => {
  const sb = new Sandbox("land3");
  t.after(() => sb.cleanup());
  await twoSessionsOfWork(sb);
  const run = sb.masp(["land", "--yes"], { MASP_FAULT: "land-after-ref" });
  assert.notEqual(run.code, 0);
  const tip = g(sb.repo, ["rev-parse", "main"]);
  assert.notEqual(tip, sb.baseCommit, "the commit reached main");
  assert.notEqual(g(sb.repo, ["status", "--porcelain"]), "", "the main checkout was left behind by the crash");
  const r = land(sb.freshCtx(), { yes: true });
  assert.equal(r.recorded, "recovered");
  assert.equal(sb.ctx().store.readState().baseCommit, tip);
  assert.equal(g(sb.repo, ["status", "--porcelain"]), "", "recovery finished updating the main checkout");
});

test("resync: only when nothing unpublished or un-landed would be lost", async (t) => {
  const sb = new Sandbox("resync");
  t.after(() => sb.cleanup());
  await twoSessionsOfWork(sb);
  land(sb.ctx(), { yes: true });
  const main = g(sb.repo, ["rev-parse", "main"]);

  sb.write("A", "assets/dev1.css", ".a { color: blue; }\n"); // unpublished work
  assert.match(resync(sb.ctx(), { session: "A", yes: true }).blockers.join(), /unpublished changes would be lost: assets\/dev1.css/);
  await cmd.integrate(sb.ctx());                              // published, but not landed yet
  assert.match(resync(sb.ctx(), { session: "A", yes: true }).blockers.join(), /assets\/dev1.css has changes from this session that are not on 'main' yet/);

  // B has nothing pending: resync moves its worktree onto main.
  const r = resync(sb.ctx(), { session: "B", yes: true });
  assert.equal(r.done, true, r.blockers.join());
  assert.equal(g(sb.worktrees.B, ["rev-parse", "HEAD"]), main);
  assert.equal(g(sb.worktrees.B, ["status", "--porcelain"]), "");
  assert.match(sb.readWorker("B", "templates/index.json"), /a_promo/, "B now sees A's landed work");
  assert.equal(cmd.status(sb.ctx()).sessions.find((s) => s.id === "B")!.files.length, 0);
  // And keeps working normally from there.
  sb.write("B", "assets/dev2.css", ".b { color: navy; }\n");
  await cmd.integrate(sb.ctx());
  assert.match(sb.readPreview("assets/dev2.css")!, /navy/);

  // After landing A's later change too, A can resync.
  land(sb.ctx(), { yes: true });
  assert.equal(resync(sb.ctx(), { session: "A", yes: true }).done, true);
});
