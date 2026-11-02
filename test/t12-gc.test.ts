// `masp gc`: removes only what nothing needs; MASP keeps working afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Sandbox, waitFor } from "./harness.ts";
import * as cmd from "../src/commands.ts";
import { gc } from "../src/gc.ts";

test("gc: dry run deletes nothing; --apply keeps everything still needed", async (t) => {
  const sb = new Sandbox("gc");
  t.after(() => sb.cleanup());
  // Ten published versions of A's CSS: nine old snapshots become unreferenced history.
  for (let i = 0; i < 10; i++) {
    sb.write("A", "assets/dev1.css", `.a { padding: ${i}px; }\n`);
    await cmd.integrate(sb.ctx());
  }
  // An open conflict and its snapshot must survive.
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "A"));
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.heading = "B"));
  await cmd.ready(sb.ctx(), { session: "A" });
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "rejected");

  const store = sb.ctx().store;
  const count = () => fs.readdirSync(store.p("blobs"), { recursive: true }).filter((f) => /[0-9a-f]{64}$/.test(String(f))).length;
  const before = count();
  const dry = gc(sb.ctx(), { keep: 2 });
  assert.ok(dry.blobs.remove >= 8, `expected old CSS snapshots to be removable, got ${dry.blobs.remove}`);
  assert.equal(count(), before, "dry run removed nothing");

  const r = gc(sb.ctx(), { keep: 2, apply: true });
  assert.equal(count(), before - r.blobs.remove);

  // Every snapshot the state refers to still exists and is intact.
  const st = store.readState();
  for (const h of [...Object.values(st.preview), ...Object.values(st.baseTree)]) store.getBlob(h);
  for (const ss of Object.values(st.sessions)) for (const h of Object.values(ss.base)) if (h) store.getBlob(h);
  for (const c of Object.values(st.conflicts)) if (c.sourceHash) store.getBlob(c.sourceHash);
  assert.equal(cmd.verify(sb.ctx()).drift.length, 0);
  assert.equal(cmd.conflicts(sb.ctx()).conflicts.length, 1, "open conflict kept");

  // MASP keeps working: show + rebased resolution, and new publishes.
  const shown = cmd.show(sb.ctx(), "templates/index.json");
  sb.write("B", "templates/index.json", shown.content!);
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.button_label = "B"));
  assert.equal((await cmd.ready(sb.ctx(), { session: "B", rebased: [`templates/index.json@${shown.hash!.slice(0, 16)}`] })).outcome?.outcome, "published");
  sb.write("A", "assets/dev1.css", ".a { padding: 99px; }\n");
  await cmd.integrate(sb.ctx());
  assert.match(sb.readPreview("assets/dev1.css")!, /99px/);
});

test("gc --apply refuses while the controller is running", async (t) => {
  const sb = new Sandbox("gc2");
  t.after(() => sb.cleanup());
  const c = sb.startController();
  await waitFor(() => (c as any).output().includes("controller started"), 15000, "controller");
  assert.throws(() => gc(sb.ctx(), { apply: true }), /another MASP writer is running/);
  assert.doesNotThrow(() => gc(sb.ctx(), {}), "dry run is read-only and allowed");
  assert.equal(sb.masp(["stop"]).code, 0);
  await waitFor(() => c.exitCode !== null, 10000, "stop");
});
