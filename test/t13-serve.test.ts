// `masp serve`: one dev server with safe flags, upload tracking in `masp status`, clean stop.
// Uses test/fake-shopify.mjs instead of the real CLI (no network, no store).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Sandbox, BIN, ROOT, waitFor } from "./harness.ts";
import * as cmd from "../src/commands.ts";
import { pidAlive } from "../src/lock.ts";

const FAKE = `"${process.execPath}" "${path.join(ROOT, "test", "fake-shopify.mjs")}"`;
const SESSIONS = [
  { id: "A", owns: ["assets/dev1.css", "sections/a-*.liquid"], shared: ["templates/index.json"] },
  { id: "B", owns: ["assets/dev2.css", "sections/b-*.liquid"], shared: ["templates/index.json"] },
];

function startServe(sb: Sandbox, extra: string[] = []) {
  const c = spawn(process.execPath, [BIN, "serve", "--store", "masp-test-store", "--config", sb.config, ...extra], {
    env: { ...process.env, MASP_SHOPIFY_BIN: FAKE }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  c.stdout!.on("data", (d) => (out += d));
  c.stderr!.on("data", (d) => (out += d));
  sb.children.push(c);
  return { c, out: () => out };
}

test("serve: tracks which published files the Shopify CLI uploaded, and stops its whole process tree", async (t) => {
  const sb = new Sandbox("serve", { sessions: SESSIONS });
  t.after(() => sb.cleanup());
  const s = startServe(sb);
  await waitFor(() => s.out().includes("Preview your theme"), 20000, "fake dev server");
  const info = JSON.parse(fs.readFileSync(path.join(sb.data, "serve.json"), "utf8"));
  assert.match(fs.readFileSync(path.join(sb.data, "shopify-dev.log"), "utf8"), /theme dev --path ".*preview" --store masp-test-store --port 9292 --no-color/);
  assert.doesNotMatch(fs.readFileSync(path.join(sb.data, "shopify-dev.log"), "utf8"), /--theme |--theme-editor-sync|--allow-live/);

  // A second server is refused.
  const second = sb.masp(["serve", "--store", "masp-test-store"], { MASP_SHOPIFY_BIN: FAKE });
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already serving/);

  sb.write("A", "assets/dev1.css", ".a { color: red; }\n");
  sb.write("B", "sections/b-fail-upload.liquid", `<p>x</p>\n{% schema %}\n{ "name": "B" }\n{% endschema %}\n`);
  await cmd.integrate(sb.ctx());
  await waitFor(() => /1 publish\(es\) confirmed.*1 REJECTED/.test(cmd.status(sb.ctx()).levels.shopifySync), 15000, "sync lines");
  const st = cmd.status(sb.ctx());
  assert.match(st.levels.shopifySync, /serving masp-test-store on port 9292/);
  assert.match(st.levels.shopifySync, /1 REJECTED by Shopify: sections\/b-fail-upload.liquid/);
  assert.doesNotMatch(st.levels.shopifySync, /other error line/, "the failure box is not counted as loose error lines");
  const b = st.sessions.find((x) => x.id === "B")!;
  assert.equal(b.uploadFailures![0].path, "sections/b-fail-upload.liquid");
  assert.match(b.uploadFailures![0].message, /Liquid syntax error \(line 1\): simulated/);
  assert.match(sb.masp(["status"]).stdout, /Shopify REJECTED sections\/b-fail-upload.liquid/);

  // Another publish that uploads fine is confirmed alongside.
  sb.write("A", "assets/dev1.css", ".a { color: blue; }\n");
  await cmd.integrate(sb.ctx());
  await waitFor(() => /1 publish\(es\) confirmed.*1 REJECTED/.test(cmd.status(sb.ctx()).levels.shopifySync) &&
    cmd.status(sb.ctx()).levels.shopifySync.includes("confirmed"), 15000, "second sync");

  const stop = sb.masp(["serve", "--stop"]);
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  await waitFor(() => s.c.exitCode !== null, 15000, "serve exit");
  assert.equal(s.c.exitCode, 0);
  await waitFor(() => !pidAlive(info.childPid), 10000, "Shopify process tree gone");
  assert.ok(!fs.existsSync(path.join(sb.data, "serve.json")));
  assert.match(cmd.status(sb.ctx()).levels.shopifySync, /server NOT running/);
});

test("serve: refuses to start when the preview is not safe to serve", async (t) => {
  const sb = new Sandbox("serve2", { sessions: SESSIONS });
  t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.preview, "assets", "dev1.css"), "/* outside edit */");
  const r = sb.masp(["serve", "--store", "masp-test-store"], { MASP_SHOPIFY_BIN: FAKE });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not safe to serve[\s\S]*changed outside MASP/);
  assert.ok(!fs.existsSync(path.join(sb.data, "serve.json")));
  const bad = sb.masp(["serve", "--store", "evil; rm -rf /"], { MASP_SHOPIFY_BIN: FAKE });
  assert.match(bad.stderr, /not a store name/);
});
