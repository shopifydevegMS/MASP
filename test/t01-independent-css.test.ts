// Test 1: two workers change different CSS files; both appear in the preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sandbox, waitFor } from "./harness.ts";
import * as cmd from "../src/commands.ts";

test("Test 1 (one-shot): independent CSS changes from A and B both reach the preview", async (t) => {
  const sb = new Sandbox("t01");
  t.after(() => sb.cleanup());
  sb.write("A", "assets/dev1.css", "/* A */\n.a-banner { padding: 4rem; }\n");
  sb.write("B", "assets/dev2.css", "/* B */\n.b-promo { color: tomato; }\n");

  const r = await cmd.integrate(sb.ctx());
  assert.equal(r.refused, undefined);
  assert.deepEqual(r.checkpoints.map((c) => [c.session, c.outcome]), [["A", "published"], ["B", "published"]]);
  assert.match(sb.readPreview("assets/dev1.css")!, /padding: 4rem/);
  assert.match(sb.readPreview("assets/dev2.css")!, /tomato/);
  // Preview files use LF even though the workers wrote CRLF.
  assert.ok(!sb.readPreview("assets/dev1.css")!.includes("\r"));

  const d = cmd.diff(sb.ctx());
  assert.deepEqual(d.rows.map((x) => [x.path, x.by]), [["assets/dev1.css", "A"], ["assets/dev2.css", "B"]]);
  assert.equal(cmd.verify(sb.ctx()).drift.length, 0);
});

test("Test 1 (controller): the running controller picks up both edits from file events", async (t) => {
  const sb = new Sandbox("t01w", { settleMs: 150 });
  t.after(() => sb.cleanup());
  const c = sb.startController();
  await waitFor(() => (c as any).output().includes("controller started"), 15000, "controller start");

  // Rapid bursts of writes plus an editor-style safe save: only the final content may appear.
  for (let i = 0; i < 15; i++) sb.write("A", "assets/dev1.css", `.a-banner { padding: ${i}px; }\n`);
  sb.writeAtomic("B", "assets/dev2.css", ".b-promo { color: navy; }\n");
  sb.write("A", "assets/dev1.css", ".a-banner { padding: 99px; }\n");

  const ms = await waitFor(() => sb.readPreview("assets/dev1.css")?.includes("99px") === true && sb.readPreview("assets/dev2.css")?.includes("navy") === true, 15000, "publish");
  t.diagnostic(`edit-to-preview time with controller: ${ms} ms (settle ${150} ms)`);

  const published = sb.ctx().store.listCheckpoints().filter((c: any) => c.outcome === "published");
  // No intermediate burst version was published.
  const versions = published.flatMap((cp: any) => cp.files.filter((f: any) => f.path === "assets/dev1.css"));
  assert.equal(versions.length, 1, "exactly one publish of dev1.css (the final version)");

  const st = sb.masp(["stop"]);
  assert.equal(st.code, 0, st.stdout + st.stderr);
  await waitFor(() => c.exitCode !== null, 10000, "controller exit");
  assert.equal(c.exitCode, 0);
});
