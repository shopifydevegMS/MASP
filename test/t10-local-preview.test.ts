// Phase 3: the unified preview as a complete local theme, checked with Shopify Theme Check.
// (Remote preview, brief Test 10, is Phase 4 and needs an approved development store.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

const hasShopify = spawnSync("shopify", ["version"], { shell: true, encoding: "utf8" }).status === 0;

test("Phase 3a: Theme Check runs offline on the preview, never writes to it, and tracks staleness", { skip: !hasShopify && "Shopify CLI not installed" }, async (t) => {
  const sb = new Sandbox("p3a");
  t.after(() => sb.cleanup());
  const snap = () => fs.readdirSync(sb.preview, { recursive: true }).map(String).sort().join("|") + cmd.verify(sb.ctx()).drift.length;

  const before = snap();
  const clean = cmd.themeCheck(sb.ctx());
  assert.equal(clean.failure, undefined);
  assert.equal(clean.errorCount, 0, JSON.stringify(clean.offenses));
  assert.equal(snap(), before, "Theme Check did not add, remove or change preview files");
  assert.match(cmd.status(sb.ctx()).levels.themeCheck, /on the current preview/);

  // Passes MASP's own checks (balanced Liquid, files exist) but uses a filter that does not exist.
  sb.write("A", "sections/a-bad.liquid", `<p>{{ section.settings.title | no_such_filter }}</p>\n{% schema %}\n{ "name": "A bad", "settings": [{ "type": "text", "id": "title", "label": "Title" }] }\n{% endschema %}\n`);
  await cmd.integrate(sb.ctx());
  assert.ok(sb.readPreview("sections/a-bad.liquid"));
  assert.match(cmd.status(sb.ctx()).levels.themeCheck, /OUTDATED/);

  const r = cmd.themeCheck(sb.ctx());
  assert.ok(r.errorCount >= 1);
  const o = r.offenses.find((x) => x.check === "UnknownFilter")!;
  assert.equal(o.path, "sections/a-bad.liquid");
  assert.equal(o.line, 1);
  assert.match(cmd.previewCommand(sb.ctx()).notes.join(" "), /reported \d+ error/);
  assert.equal(sb.masp(["check"]).code, 7);
});

test("Phase 3b: a missing or broken Shopify CLI is reported, not mistaken for a pass", async (t) => {
  const sb = new Sandbox("p3b");
  t.after(() => sb.cleanup());
  process.env.MASP_SHOPIFY_BIN = "masp-no-such-shopify-binary";
  try {
    const r = cmd.themeCheck(sb.ctx());
    assert.ok(r.failure);
    assert.match(cmd.status(sb.ctx()).levels.themeCheck, /could not run/);
  } finally {
    delete process.env.MASP_SHOPIFY_BIN;
  }
});

test("Phase 3c: the preview preflight refuses to hand out the dev command while the preview is unsafe", async (t) => {
  const sb = new Sandbox("p3c");
  t.after(() => sb.cleanup());
  assert.equal(cmd.previewCommand(sb.ctx()).ready, true);
  // Someone (e.g. Theme Editor sync) writes into the preview.
  fs.writeFileSync(path.join(sb.preview, "templates", "index.json"), "{}");
  const p = cmd.previewCommand(sb.ctx());
  assert.equal(p.ready, false);
  assert.match(p.blockers.join("\n"), /changed outside MASP/);
  assert.equal(sb.masp(["preview"]).code, 8);
  const cli = sb.masp(["preview"]).stdout;
  assert.doesNotMatch(cli, /shopify theme dev/, "no command is printed when not ready");
});

test("Phase 3d: completeness rules for a servable theme", () => {
  const base = ["layout/theme.liquid", "config/settings_schema.json", "config/settings_data.json", "templates/index.json", "locales/en.default.json"];
  assert.deepEqual(cmd.themeCompleteness(base), []);
  const missing = cmd.themeCompleteness(base.filter((p) => p !== "layout/theme.liquid" && p !== "templates/index.json"));
  assert.deepEqual(missing.map((i) => [i.severity, i.path]), [["error", "layout/theme.liquid"], ["error", "templates/index.json"]]);
  assert.deepEqual(cmd.themeCompleteness(["layout/theme.liquid", "config/settings_schema.json", "templates/index.liquid"]).map((i) => i.severity), ["warning", "warning"]);
});
