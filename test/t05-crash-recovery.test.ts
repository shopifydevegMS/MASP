// Test 5: the integration process is killed during a staged update, then restarted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Sandbox, waitFor } from "./harness.ts";
import * as cmd from "../src/commands.ts";

const NEW_SECTION = `<section class="a-banner">{{ section.settings.title }}</section>
{% schema %}
{ "name": "A banner", "settings": [{ "type": "text", "id": "title", "label": "Title" }] }
{% endschema %}
`;

function twoFileChange(sb: Sandbox) {
  sb.write("A", "assets/dev1.css", ".a-banner { padding: 5rem; }\n");
  sb.write("A", "sections/a-banner.liquid", NEW_SECTION);
}

test("Test 5a: killed after the first of two files; restart rolls back to the last good preview", async (t) => {
  const sb = new Sandbox("t05a");
  t.after(() => sb.cleanup());
  twoFileChange(sb);
  const oldCss = sb.readPreview("assets/dev1.css");

  const run = sb.masp(["integrate"], { MASP_FAULT: "apply:1" });
  assert.notEqual(run.code, 0, "process was killed");
  // The preview is now a mix: first file new, second missing. That is exactly what the journal is for.
  assert.match(sb.readPreview("assets/dev1.css")!, /5rem/);
  assert.equal(sb.readPreview("sections/a-banner.liquid"), null);

  const st = cmd.status(sb.freshCtx());
  assert.equal(st.interrupted.length, 1);
  assert.match(st.levels.localPreview, /OUT OF SYNC/);

  const t0 = performance.now();
  const rec = cmd.recover(sb.ctx());
  t.diagnostic(`recovery time: ${(performance.now() - t0).toFixed(1)} ms`);
  assert.equal(rec.transactions[0].action, "rolled-back");
  assert.deepEqual(rec.transactions[0].reverted, ["assets/dev1.css"]);
  assert.equal(sb.readPreview("assets/dev1.css"), oldCss);
  assert.equal(cmd.verify(sb.ctx()).drift.length, 0);

  // Source changes are untouched, so the next pass publishes both files together.
  const r = await cmd.integrate(sb.ctx());
  assert.equal(r.checkpoints[0].outcome, "published");
  assert.match(sb.readPreview("sections/a-banner.liquid")!, /a-banner/);
  assert.equal(cmd.status(sb.ctx()).interrupted.length, 0);
});

test("Test 5b: killed after state was saved; restart completes instead of rolling back", async (t) => {
  const sb = new Sandbox("t05b");
  t.after(() => sb.cleanup());
  twoFileChange(sb);
  const run = sb.masp(["integrate"], { MASP_FAULT: "after-state" });
  assert.notEqual(run.code, 0);
  // Restarting the normal way (integrate) recovers automatically.
  const r = await cmd.integrate(sb.freshCtx());
  assert.equal(r.recovered[0].action, "completed");
  assert.match(sb.readPreview("assets/dev1.css")!, /5rem/);
  assert.match(sb.readPreview("sections/a-banner.liquid")!, /a-banner/);
  assert.equal(cmd.verify(sb.ctx()).drift.length, 0);
});

test("Test 5c: if someone touched the preview during the crash, MASP stops with a precise report", async (t) => {
  const sb = new Sandbox("t05c");
  t.after(() => sb.cleanup());
  twoFileChange(sb);
  sb.masp(["integrate"], { MASP_FAULT: "apply:1" });
  // An outside process (e.g. Theme Editor sync) writes into the preview meanwhile.
  fs.writeFileSync(path.join(sb.preview, "assets", "dev1.css"), "/* outside edit */\n");

  const rec = cmd.recover(sb.freshCtx());
  assert.equal(rec.transactions[0].action, "needs-reconciliation");
  assert.equal(rec.transactions[0].unexpected[0].path, "assets/dev1.css");
  assert.ok(rec.remaining);
  // Publishing is refused until a person decides.
  const r = await cmd.integrate(sb.ctx());
  assert.match(r.refused!, /reconciliation/);
  assert.equal(sb.readPreview("assets/dev1.css"), "/* outside edit */\n");
  assert.equal(sb.masp(["integrate"]).code, 3);

  // Explicit restore keeps a copy of the outside version, then puts MASP's version back.
  const fixed = cmd.recover(sb.ctx(), { restorePreview: true });
  assert.equal(fixed.remaining, null);
  assert.ok(fixed.restored[0].savedOutsideVersion);
  assert.equal(sb.ctx().store.getBlob(fixed.restored[0].savedOutsideVersion!).toString(), "/* outside edit */\n");
  const again = await cmd.integrate(sb.ctx());
  assert.equal(again.checkpoints[0].outcome, "published");
  assert.match(sb.readPreview("assets/dev1.css")!, /5rem/);
});

test("Test 5d: a locked preview file (Windows) makes the publish roll back cleanly in-process", async (t) => {
  const sb = new Sandbox("t05d");
  t.after(() => sb.cleanup());
  twoFileChange(sb);
  const run = sb.masp(["integrate", "--json"], { MASP_FAULT: "renamefail:2" });
  assert.equal(run.code, 0, run.stderr);
  const cp = run.json().checkpoints[0];
  assert.equal(cp.outcome, "failed");
  assert.match(cp.problems.at(-1).detail, /rolled back/);
  assert.doesNotMatch(sb.readPreview("assets/dev1.css")!, /5rem/, "first file was restored");
  assert.equal(cmd.verify(sb.freshCtx()).drift.length, 0);
  // Next pass (lock released) succeeds.
  const r = await cmd.integrate(sb.ctx());
  assert.equal(r.checkpoints[0].outcome, "published");
});

test("Test 5e: a second controller or writer is refused while one is running; a stale lock is taken over", async (t) => {
  const sb = new Sandbox("t05e");
  t.after(() => sb.cleanup());
  const c = sb.startController();
  await waitFor(() => (c as any).output().includes("controller started"), 15000, "controller start");
  const second = sb.masp(["start"]);
  assert.equal(second.code, 10);
  assert.match(second.stderr, /another MASP writer is running/);
  assert.equal(sb.masp(["integrate"]).code, 10);

  // Hard-kill the controller: its lock file stays behind.
  c.kill("SIGKILL");
  await waitFor(() => c.exitCode !== null || c.signalCode !== null, 10000, "kill");
  assert.ok(fs.existsSync(path.join(sb.data, "lock")));
  const r = sb.masp(["integrate"]);
  assert.equal(r.code, 0, r.stderr);
});
