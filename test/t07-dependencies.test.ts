// Test 7: a new section depends on a snippet that is not integrated yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

const PROMO = `<section class="a-promo">
  {% render 'a-promo-badge', text: section.settings.text %}
</section>
{% schema %}
{ "name": "A promo", "settings": [{ "type": "text", "id": "text", "label": "Text" }], "presets": [{ "name": "A promo" }] }
{% endschema %}
`;

test("Test 7a: a section that renders a missing snippet is held, then published together with the snippet", async (t) => {
  const sb = new Sandbox("t07a");
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-promo.liquid", PROMO); // valid Liquid on its own

  await cmd.integrate(sb.ctx());
  assert.equal(sb.readPreview("sections/a-promo.liquid"), null, "not published: dependency missing");
  const held = cmd.conflicts(sb.ctx()).held;
  assert.deepEqual(held.map((h) => [h.path, h.detail]), [["sections/a-promo.liquid", "missing dependency snippets/a-promo-badge.liquid (render 'a-promo-badge')"]]);
  assert.equal(cmd.status(sb.ctx()).sessions[0].files[0].state, "held");

  sb.write("A", "snippets/a-promo-badge.liquid", `<span class="badge">{{ text }}</span>\n`);
  const r = await cmd.integrate(sb.ctx());
  const cp = r.checkpoints.find((c) => c.outcome === "published")!;
  assert.deepEqual(cp.files.map((f) => f.path).sort(), ["sections/a-promo.liquid", "snippets/a-promo-badge.liquid"], "one transaction");
  assert.equal(cmd.conflicts(sb.ctx()).held.length, 0);
});

test("Test 7b: a template change that uses a section not yet published is rejected as a whole", async (t) => {
  const sb = new Sandbox("t07b");
  t.after(() => sb.cleanup());
  sb.write("B", "sections/b-promo.liquid", `{% render 'b-missing' %}\n{% schema %}\n{ "name": "B promo" }\n{% endschema %}\n`);
  sb.editJson("B", "templates/index.json", (v) => {
    v.sections.b_promo = { type: "b-promo", settings: {} };
    v.order.push("b_promo");
  });
  const r = await cmd.ready(sb.ctx(), { session: "B", message: "add promo section to home" });
  assert.equal(r.outcome?.outcome, "rejected");
  assert.ok(r.outcome!.problems.some((p) => p.kind === "dependency" && /snippets\/b-missing/.test(p.detail)));
  assert.match(sb.readPreview("templates/index.json")!, /"order": \["hero", "featured_text"\]/);
  assert.equal(sb.readPreview("sections/b-promo.liquid"), null);
});

test("Test 7c: syntactically broken files are held, not published", async (t) => {
  const sb = new Sandbox("t07c");
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-broken.liquid", `<div>{% if x %}</div>\n`);
  sb.write("A", "assets/dev1.css", ".ok { color: red; }\n");
  await cmd.integrate(sb.ctx());
  assert.equal(sb.readPreview("sections/a-broken.liquid"), null);
  assert.match(sb.readPreview("assets/dev1.css")!, /color: red/, "unrelated file still publishes");
  assert.match(cmd.conflicts(sb.ctx()).held[0].detail, /unclosed \{% if %\}/);
});
