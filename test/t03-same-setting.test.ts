// Test 3: two workers change the same setting differently. The second is blocked;
// nothing is lost in either worktree or the preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

test("Test 3: conflicting edits to the same template setting are blocked, all versions preserved", async (t) => {
  const sb = new Sandbox("t03");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "Heading from A"));
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.heading = "Heading from B"));
  const aBefore = sb.readWorker("A", "templates/index.json");
  const bBefore = sb.readWorker("B", "templates/index.json");

  // Shared file: never auto-published.
  await cmd.integrate(sb.ctx());
  assert.match(sb.readPreview("templates/index.json")!, /"Welcome"/);
  const st = cmd.status(sb.ctx());
  assert.equal(st.sessions.find((s) => s.id === "A")!.files[0].state, "needs-ready");

  const ra = await cmd.ready(sb.ctx(), { session: "A", message: "hero heading" });
  assert.equal(ra.outcome?.outcome, "published");
  assert.match(sb.readPreview("templates/index.json")!, /Heading from A/);
  // The Shopify header comment survives.
  assert.match(sb.readPreview("templates/index.json")!, /auto-generated/);

  const rb = await cmd.ready(sb.ctx(), { session: "B", message: "hero heading" });
  assert.equal(rb.outcome?.outcome, "rejected");
  assert.equal(rb.outcome?.problems[0].kind, "conflict");
  assert.match(rb.outcome!.problems[0].detail, /section "hero" was changed both here and in the preview \(last published by session A\)/);
  assert.match(sb.readPreview("templates/index.json")!, /Heading from A/, "A's version is not overwritten");

  // Both worktrees untouched, B's change still pending as a conflict.
  assert.equal(sb.readWorker("A", "templates/index.json"), aBefore);
  assert.equal(sb.readWorker("B", "templates/index.json"), bBefore);
  const c = cmd.conflicts(sb.ctx());
  assert.deepEqual(c.conflicts.map((x) => [x.session, x.path, x.kind]), [["B", "templates/index.json", "conflict"]]);
  // The conflict stays on later passes until B changes the file again.
  await cmd.integrate(sb.ctx());
  assert.equal(cmd.conflicts(sb.ctx()).conflicts.length, 1);

  // CLI exit code for open conflicts.
  assert.equal(sb.masp(["conflicts"]).code, 5);
});

test("Test 3b: different settings of the same section still conflict (no merging inside a section)", async (t) => {
  const sb = new Sandbox("t03b");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "A heading"));
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.button_label = "B label"));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");
  const r = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r.outcome?.outcome, "rejected");
  assert.match(r.outcome!.problems[0].detail, /section "hero" was changed both/);
});
