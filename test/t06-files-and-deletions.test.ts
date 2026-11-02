// Test 6: new untracked files, renames and deletions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

const SECTION = (cls: string) => `<section class="${cls}">x</section>\n{% schema %}\n{ "name": "${cls}" }\n{% endschema %}\n`;

test("Test 6a: new untracked file is auto-published; editor temp files are ignored", async (t) => {
  const sb = new Sandbox("t06a");
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-new.liquid", SECTION("a-new"));
  sb.write("A", "sections/a-new.liquid.tmp", "half written {%");
  sb.write("A", "sections/.#a-new.liquid", "lock");
  await cmd.integrate(sb.ctx());
  assert.match(sb.readPreview("sections/a-new.liquid")!, /a-new/);
  assert.equal(sb.readPreview("sections/a-new.liquid.tmp"), null);
  assert.equal(sb.readPreview("sections/.#a-new.liquid"), null);
});

test("Test 6b: a rename publishes the new name automatically, but the deletion waits for Ready", async (t) => {
  const sb = new Sandbox("t06b");
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-old.liquid", SECTION("a-old"));
  await cmd.integrate(sb.ctx());
  fs.renameSync(path.join(sb.worktrees.A, "sections", "a-old.liquid"), path.join(sb.worktrees.A, "sections", "a-renamed.liquid"));

  await cmd.integrate(sb.ctx());
  assert.ok(sb.readPreview("sections/a-renamed.liquid"));
  assert.ok(sb.readPreview("sections/a-old.liquid"), "deletion is not automatic");
  const files = cmd.status(sb.ctx()).sessions.find((s) => s.id === "A")!.files;
  assert.deepEqual(files.map((f) => [f.path, f.state, f.detail]), [["sections/a-old.liquid", "needs-ready", "deletion"]]);

  const r = await cmd.ready(sb.ctx(), { session: "A", message: "rename a-old to a-renamed" });
  assert.equal(r.outcome?.outcome, "published");
  assert.equal(sb.readPreview("sections/a-old.liquid"), null);
  const d = cmd.diff(sb.ctx());
  assert.deepEqual(d.rows.map((x) => [x.path, x.change]), [["sections/a-renamed.liquid", "added"]]);
});

test("Test 6c: deleting a file that something still references is refused", async (t) => {
  const sb = new Sandbox("t06c");
  t.after(() => sb.cleanup());
  sb.rm("A", "assets/dev1.css"); // layout/theme.liquid links to it
  const r = await cmd.ready(sb.ctx(), { session: "A" });
  assert.equal(r.outcome?.outcome, "rejected");
  assert.equal(r.outcome?.problems[0].kind, "dependency");
  assert.match(r.outcome!.problems[0].detail, /still referenced by layout\/theme.liquid/);
  assert.ok(sb.readPreview("assets/dev1.css"));
});

test("Test 6d: files outside a session's scope are never published, even with Ready", async (t) => {
  const sb = new Sandbox("t06d");
  t.after(() => sb.cleanup());
  sb.rm("B", "sections/featured-text.liquid");       // not B's file
  sb.write("B", "assets/dev1.css", ".hijack {}\n");   // A's file
  sb.write("B", "snippets/shared-button.liquid", "x"); // critical, owned by nobody
  await cmd.integrate(sb.ctx());
  const r = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r.outcome?.outcome, "rejected");
  const kinds = Object.fromEntries(r.outcome!.problems.map((p) => [p.path, p.kind]));
  assert.deepEqual(kinds, { "assets/dev1.css": "scope", "sections/featured-text.liquid": "scope", "snippets/shared-button.liquid": "scope" });
  assert.ok(sb.readPreview("sections/featured-text.liquid"));
  assert.doesNotMatch(sb.readPreview("assets/dev1.css")!, /hijack/);
});

test("Test 6e: a file changed in the worktree after Ready is not published", async (t) => {
  const sb = new Sandbox("t06e");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "Ready version"));
  const q = await cmd.ready(sb.ctx(), { session: "A", wait: false });
  assert.equal(q.note, "queued");
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "Edited after ready"));
  const r = await cmd.integrate(sb.ctx());
  assert.equal(r.checkpoints[0].outcome, "rejected");
  assert.equal(r.checkpoints[0].problems[0].kind, "changed-after-ready");
  assert.match(sb.readPreview("templates/index.json")!, /Welcome/);
});
