// `masp lint` (dry run of Ready) and theme block dependency checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Sandbox, DEFAULT_SESSIONS } from "./harness.ts";
import * as cmd from "../src/commands.ts";
import { liquidRefs } from "../src/deps.ts";
import { sha256 } from "../src/util.ts";

const SESSIONS = DEFAULT_SESSIONS.map((s) => ({ ...s, owns: [...s.owns, `blocks/${s.id.toLowerCase()}-*.liquid`] }));
const schema = (o: unknown) => `{% schema %}\n${JSON.stringify(o, null, 2)}\n{% endschema %}\n`;

test("lint: reports exactly what Ready would do, and changes nothing", async (t) => {
  const sb = new Sandbox("lint");
  t.after(() => sb.cleanup());
  const stateFile = path.join(sb.data, "state.json");
  const fingerprint = () => [sha256(fs.readFileSync(stateFile)), fs.readdirSync(path.join(sb.data, "requests")).length,
    fs.readdirSync(path.join(sb.data, "checkpoints")).length, cmd.verify(sb.ctx()).drift.length].join("|");

  // A template change that uses a section file that does not exist yet.
  sb.editJson("A", "templates/index.json", (v) => {
    v.sections.a_new = { type: "a-new", settings: {} };
    v.order.push("a_new");
  });
  const before = fingerprint();
  const r1 = cmd.lint(sb.ctx(), { session: "A" });
  assert.equal(r1.result?.outcome, "rejected");
  assert.match(r1.result!.problems[0].detail, /missing dependency sections\/a-new.liquid/);
  assert.equal(fingerprint(), before, "lint changed nothing: state, queue, checkpoints, preview");
  assert.equal(sb.masp(["lint", "--session", "A"]).code, 4);

  // Fixed: lint says it would publish, and Ready then does.
  sb.write("A", "sections/a-new.liquid", `<p>new</p>\n${schema({ name: "A new" })}`);
  const r2 = cmd.lint(sb.ctx(), { session: "A" });
  assert.equal(r2.result?.outcome, "would-publish");
  assert.equal(fingerprint(), before);
  assert.equal(sb.readPreview("sections/a-new.liquid"), null);
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");

  // A conflict is seen by lint before signalling.
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.heading = "B"));
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "A"));
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");
  const r3 = cmd.lint(sb.ctx(), { session: "B" });
  assert.equal(r3.result?.outcome, "rejected");
  assert.match(r3.result!.problems[0].detail, /section "hero" was changed both/);
  assert.equal(cmd.conflicts(sb.ctx()).conflicts.length, 0, "lint does not record conflicts");

  // After merging by hand, lint with --rebased agrees with Ready (the path the real AI session needed).
  const shown = cmd.show(sb.ctx(), "templates/index.json");
  sb.write("B", "templates/index.json", shown.content!);
  sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.button_label = "B label"));
  const spec = [`templates/index.json@${shown.hash!.slice(0, 16)}`];
  assert.equal(cmd.lint(sb.ctx(), { session: "B", rebased: spec }).result?.outcome, "would-publish");
  assert.equal((await cmd.ready(sb.ctx(), { session: "B", rebased: spec })).outcome?.outcome, "published");
});

const hasShopify = (await import("node:child_process")).spawnSync("shopify", ["version"], { shell: true }).status === 0;

test("lint: quick Theme Check catches Liquid that MASP's own checks pass (seen in the real AI run)", { skip: !hasShopify && "Shopify CLI not installed" }, async (t) => {
  const sb = new Sandbox("lint-tc");
  t.after(() => sb.cleanup());
  // The exact mistake session C made: a filter inside the {% form %} tag's options.
  const bad = `<div>\n  {%- form 'customer', id: 'a-form-' | append: section.id, class: 'a-form' -%}\n    <input type="email" name="contact[email]">\n  {%- endform -%}\n</div>\n${schema({ name: "A form" })}`;
  sb.write("A", "sections/a-form.liquid", bad);
  await cmd.integrate(sb.ctx());
  assert.ok(sb.readPreview("sections/a-form.liquid"), "MASP's own checks let it through (auto-published)");
  const r = cmd.lint(sb.ctx(), { session: "A" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.themeCheck.checked, ["sections/a-form.liquid"]);
  assert.equal(r.themeCheck.offenses[0].check, "LiquidSyntaxError");
  assert.equal(r.themeCheck.offenses[0].line, 2);
  assert.equal(sb.masp(["lint", "--session", "A"]).code, 4);

  sb.write("A", "sections/a-form.liquid", bad.replace(" | append: section.id", ""));
  assert.equal(cmd.lint(sb.ctx(), { session: "A" }).ok, true);
});

test("theme blocks: reference rules", () => {
  const src = `{% content_for 'block', type: 'heading', id: 'h' %}
{% content_for "blocks" %}
${schema({ name: "S", blocks: [{ type: "@theme" }, { type: "@app" }, { type: "card" }, { type: "local_item", name: "Item" }] })}`;
  assert.deepEqual(liquidRefs(src).map((r) => r.target).sort(), ["blocks/card.liquid", "blocks/heading.liquid"]);
});

test("theme blocks: a section is held until the block file it allows exists", async (t) => {
  const sb = new Sandbox("blocks1", { sessions: SESSIONS });
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-feature.liquid", `<div>{% content_for 'blocks' %}</div>\n${schema({ name: "A feature", blocks: [{ type: "a-card" }] })}`);
  await cmd.integrate(sb.ctx());
  assert.equal(sb.readPreview("sections/a-feature.liquid"), null);
  assert.match(cmd.conflicts(sb.ctx()).held[0].detail, /missing dependency blocks\/a-card.liquid \(schema block type "a-card"\)/);
  sb.write("A", "blocks/a-card.liquid", `<div class="card">{{ block.settings.title }}</div>\n${schema({ name: "Card", settings: [{ type: "text", id: "title", label: "Title" }] })}`);
  await cmd.integrate(sb.ctx());
  assert.ok(sb.readPreview("sections/a-feature.liquid") && sb.readPreview("blocks/a-card.liquid"));
});

test("theme blocks: template block instances must be local blocks or existing block files", async (t) => {
  const sb = new Sandbox("blocks2", { sessions: SESSIONS });
  t.after(() => sb.cleanup());
  sb.write("A", "blocks/a-card.liquid", `<div>{% content_for 'blocks' %}</div>\n${schema({ name: "Card", blocks: [{ type: "@theme" }] })}`);
  sb.write("A", "sections/a-feature.liquid", `<div>{% content_for 'blocks' %}</div>\n${schema({ name: "A feature", blocks: [{ type: "a-card" }, { type: "note", name: "Note" }] })}`);
  await cmd.integrate(sb.ctx());

  const add = (blocks: Record<string, unknown>) => sb.editJson("A", "templates/index.json", (v) => {
    v.sections.a_feature = { type: "a-feature", blocks, settings: {} };
    if (!v.order.includes("a_feature")) v.order.push("a_feature");
  });
  // Nested block of a type that has no file.
  add({ c1: { type: "a-card", blocks: { n1: { type: "a-ghost" } } }, n1: { type: "note" } });
  const bad = cmd.lint(sb.ctx(), { session: "A" });
  assert.equal(bad.result?.outcome, "rejected");
  assert.match(bad.result!.problems[0].detail, /missing dependency blocks\/a-ghost.liquid \(section "a_feature" block "n1" type "a-ghost"\)/);

  // Local block ("note") and an existing theme block ("a-card"), nested: fine.
  add({ c1: { type: "a-card", blocks: { c2: { type: "a-card" } } }, n1: { type: "note" } });
  assert.equal(cmd.lint(sb.ctx(), { session: "A" }).result?.outcome, "would-publish");
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");

  // Deleting a block file the template still uses is refused.
  sb.rm("A", "blocks/a-card.liquid");
  const del = await cmd.ready(sb.ctx(), { session: "A", files: ["blocks/a-card.liquid"] });
  assert.equal(del.outcome?.outcome, "rejected");
  assert.ok(del.outcome!.problems.some((p) => /cannot delete: still referenced by/.test(p.detail)));
  assert.ok(sb.readPreview("blocks/a-card.liquid"));
});
