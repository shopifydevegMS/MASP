// Test 8: no Git history pollution. Test 9: worker worktrees are never modified.
// Runs a full scenario (auto publish, ready, conflict, deletion, crash + recovery,
// controller start/stop) and compares Git and worktree state before and after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sandbox, waitFor } from "./harness.ts";
import * as cmd from "../src/commands.ts";

test("Test 8 + 9: a full MASP session leaves Git history and every worktree file untouched", async (t) => {
  const sb = new Sandbox("t08");
  t.after(() => sb.cleanup());

  // Worker edits happen first; from here on only MASP runs.
  sb.write("A", "assets/dev1.css", ".a { color: red; }\n");
  sb.write("A", "sections/a-hero.liquid", `<div>{% render 'a-missing' %}</div>\n`);
  sb.write("B", "assets/dev2.css", ".b { color: blue; }\n");
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "A"));
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.heading = "B"));
  sb.rm("B", "sections/featured-text.liquid");

  const gitBefore = sb.gitSnapshot();
  const filesBefore = sb.worktreeSnapshot();

  await cmd.integrate(sb.ctx());
  await cmd.ready(sb.ctx(), { session: "A" });
  await cmd.ready(sb.ctx(), { session: "B" });
  sb.masp(["integrate"], { MASP_FAULT: "staged" });
  cmd.recover(sb.freshCtx());
  cmd.status(sb.ctx());
  cmd.diff(sb.ctx(), { patch: true });
  cmd.verify(sb.ctx());
  sb.masp(["status"]);
  sb.masp(["diff", "--patch"]);
  const c = sb.startController();
  await waitFor(() => (c as any).output().includes("controller started"), 15000, "controller start");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sb.masp(["stop"]).code, 0);
  await waitFor(() => c.exitCode !== null, 10000, "controller exit");

  assert.equal(sb.gitSnapshot(), gitBefore, "Test 8: commits, refs, reflogs, stash, remotes and index files are unchanged");
  assert.deepEqual(sb.worktreeSnapshot(), filesBefore, "Test 9: no worktree file was created, changed or touched");
  // Sanity: the scenario did publish something.
  assert.match(sb.readPreview("assets/dev1.css")!, /color: red/);
  assert.match(sb.readPreview("assets/dev2.css")!, /color: blue/);
});
