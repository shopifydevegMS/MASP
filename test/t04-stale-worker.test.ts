// Test 4: a worker's change is based on an outdated version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

test("Test 4a: a stale change to the same section is blocked; integrates only after an explicit, verified rebase", async (t) => {
  const sb = new Sandbox("t04a");
  t.after(() => sb.cleanup());
  // A changes product.json and it is integrated first.
  sb.editJson("A", "templates/product.json", (v) => (v.sections.main.settings.show_vendor = true));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");

  // B edits the same file from the original version: stale.
  sb.editJson("B", "templates/product.json", (v) => (v.sections.main.settings.gallery = "grid"));
  const r1 = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r1.outcome?.outcome, "rejected");
  assert.equal(r1.outcome?.problems[0].kind, "conflict");
  assert.match(r1.outcome!.problems[0].detail, /section "main" was changed both/);
  assert.match(sb.readPreview("templates/product.json")!, /show_vendor/);
  assert.doesNotMatch(sb.readPreview("templates/product.json")!, /gallery/);

  // A guessed or outdated hash is refused.
  await assert.rejects(cmd.ready(sb.ctx(), { session: "B", rebased: ["templates/product.json@0123456789abcdef"] }), /not the current preview version/);

  // B looks at the preview version, merges by hand and signals that it built on that version.
  const shown = cmd.show(sb.ctx(), "templates/product.json");
  assert.equal(shown.by, "A");
  sb.editJson("B", "templates/product.json", (v) => (v.sections.main.settings.show_vendor = true));
  const r2 = await cmd.ready(sb.ctx(), { session: "B", rebased: [`templates/product.json@${shown.hash!.slice(0, 16)}`] });
  assert.equal(r2.outcome?.outcome, "published");
  const merged = JSON.parse(sb.readPreview("templates/product.json")!);
  assert.equal(merged.sections.main.settings.show_vendor, true);
  assert.equal(merged.sections.main.settings.gallery, "grid");
  assert.equal(cmd.conflicts(sb.ctx()).conflicts.length, 0);
});

test("Test 4b: a rebase is refused if the preview changed again after the session looked", async (t) => {
  const sb = new Sandbox("t04b");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/product.json", (v) => (v.sections.main.settings.x = 1));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");

  // B reviews the preview (version 1) and merges by hand ...
  const seen = cmd.show(sb.ctx(), "templates/product.json");
  sb.editJson("B", "templates/product.json", (v) => { v.sections.main.settings.x = 1; v.sections.main.settings.y = 2; });
  // ... meanwhile A queues another change, then B queues its rebased change.
  sb.editJson("A", "templates/product.json", (v) => (v.sections.main.settings.x = 3));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A", wait: false })).note, "queued");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await cmd.ready(sb.ctx(), { session: "B", rebased: [`templates/product.json@${seen.hash!.slice(0, 16)}`], wait: false })).note, "queued");

  // Requests are processed in arrival order: A publishes version 2, so B's review is out of date.
  const r = await cmd.integrate(sb.ctx());
  assert.deepEqual(r.checkpoints.map((c) => [c.session, c.outcome]), [["A", "published"], ["B", "rejected"]]);
  assert.match(r.checkpoints[1].problems[0].detail, /changed again after you reviewed/);
  const preview = JSON.parse(sb.readPreview("templates/product.json")!);
  assert.equal(preview.sections.main.settings.x, 3);
  assert.equal(preview.sections.main.settings.y, undefined);
});

test("Test 4c: a worktree whose HEAD is not based on the preview base is blocked entirely", async (t) => {
  const sb = new Sandbox("t04c");
  t.after(() => sb.cleanup());
  // Simulate an agent that switched B's worktree to an older commit.
  execFileSync("git", ["checkout", "-q", "--detach", sb.parentCommit], { cwd: sb.worktrees.B });
  sb.write("B", "assets/dev2.css", ".b-promo { color: green; }\n");
  const r = await cmd.integrate(sb.ctx());
  assert.equal(r.checkpoints.filter((c) => c.session === "B").length, 0);
  assert.doesNotMatch(sb.readPreview("assets/dev2.css")!, /green/);
  const st = cmd.status(sb.ctx());
  assert.match(st.sessions.find((s) => s.id === "B")!.problem!, /not based on this session.s start commit/);
  // The older commit's base.css must not leak into the preview either.
  assert.match(sb.readPreview("assets/base.css")!, /system-ui/);
});

test("Test 4d: sessions must start from the preview's base commit", async (t) => {
  const sb = new Sandbox("t04d", { init: false });
  t.after(() => sb.cleanup());
  execFileSync("git", ["checkout", "-q", "--detach", sb.parentCommit], { cwd: sb.worktrees.B });
  const r = cmd.init(sb.ctx());
  assert.deepEqual(r.registered, ["A"]);
  assert.match(r.errors.B, /differs from the preview base/);
});

test("Test 4e: a stale change that is provably compatible (different sections) is merged", async (t) => {
  const sb = new Sandbox("t04e");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "From A"));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");
  // B worked from the original template and changed a different section.
  sb.editJson("B", "templates/index.json", (v) => (v.sections.featured_text.settings.text = "From B"));
  const r = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r.outcome?.outcome, "published");
  const v = JSON.parse(sb.readPreview("templates/index.json")!.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
  assert.equal(v.sections.hero.settings.heading, "From A");
  assert.equal(v.sections.featured_text.settings.text, "From B");
  const d = cmd.diff(sb.ctx()).rows.find((x) => x.path === "templates/index.json")!;
  assert.equal(d.by, "B");
  const prov = sb.ctx().store.readState().provenance["templates/index.json"];
  assert.deepEqual(prov.contributors, ["A", "B"]);
});
