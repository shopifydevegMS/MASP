// Test 2: two workers each insert a section into the same Shopify JSON template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "./harness.ts";
import * as cmd from "../src/commands.ts";

const section = (cls: string) =>
  `<section class="${cls}">{{ section.settings.text }}</section>\n{% schema %}\n{ "name": "${cls}", "settings": [{ "type": "text", "id": "text", "label": "Text" }], "presets": [{ "name": "${cls}" }] }\n{% endschema %}\n`;

function body(text: string): any {
  return JSON.parse(text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
}

test("Test 2: compatible section insertions from A and B both appear, nothing else changes", async (t) => {
  const sb = new Sandbox("t02");
  t.after(() => sb.cleanup());
  const original = sb.readPreview("templates/index.json")!;

  // A inserts after "hero"; B appends at the end. Each also adds its section file.
  sb.write("A", "sections/a-promo.liquid", section("a-promo"));
  sb.editJson("A", "templates/index.json", (v) => {
    v.sections.a_promo = { type: "a-promo", settings: { text: "A" } };
    v.order.splice(1, 0, "a_promo");
  });
  sb.write("B", "sections/b-promo.liquid", section("b-promo"));
  sb.editJson("B", "templates/index.json", (v) => {
    v.sections.b_promo = { type: "b-promo", settings: { text: "B" } };
    v.order.push("b_promo");
  });

  assert.equal((await cmd.ready(sb.ctx(), { session: "A", message: "A promo" })).outcome?.outcome, "published");
  const rb = await cmd.ready(sb.ctx(), { session: "B", message: "B promo" });
  assert.equal(rb.outcome?.outcome, "published", JSON.stringify(rb.outcome?.problems));

  const text = sb.readPreview("templates/index.json")!;
  const v = body(text);
  assert.deepEqual(v.order, ["hero", "a_promo", "featured_text", "b_promo"]);
  assert.deepEqual(Object.keys(v.sections), ["hero", "featured_text", "a_promo", "b_promo"]);
  assert.deepEqual(v.sections.hero, body(original).sections.hero, "unrelated sections untouched");
  assert.deepEqual(v.sections.featured_text, body(original).sections.featured_text);
  assert.ok(text.startsWith(original.slice(0, original.indexOf("*/") + 2)), "Shopify header comment kept");
  assert.ok(sb.readPreview("sections/a-promo.liquid") && sb.readPreview("sections/b-promo.liquid"));
  assert.equal(cmd.verify(sb.ctx()).issues.filter((i) => i.severity === "error").length, 0);

  // Both sessions are now in sync; their worktrees still hold only their own change.
  const st = cmd.status(sb.ctx());
  assert.deepEqual(st.sessions.map((s) => s.files.length), [0, 0]);
  assert.doesNotMatch(sb.readWorker("A", "templates/index.json"), /b_promo/);

  // A later edit by B merges again without undoing A's section.
  sb.editJson("B", "templates/index.json", (x) => (x.sections.b_promo.settings.text = "B v2"));
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "published");
  const v2 = body(sb.readPreview("templates/index.json")!);
  assert.deepEqual(v2.order, ["hero", "a_promo", "featured_text", "b_promo"]);
  assert.equal(v2.sections.b_promo.settings.text, "B v2");
  assert.equal(v2.sections.a_promo.settings.text, "A");
});

test("Test 2b: two inserts at the same position are blocked by default", async (t) => {
  const sb = new Sandbox("t02b");
  t.after(() => sb.cleanup());
  for (const s of ["A", "B"]) {
    const id = `${s.toLowerCase()}_x`;
    sb.editJson(s, "templates/index.json", (v) => {
      v.sections[id] = { type: "hero", settings: { heading: s } };
      v.order.push(id);
    });
  }
  assert.equal((await cmd.ready(sb.ctx(), { session: "A" })).outcome?.outcome, "published");
  const r = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r.outcome?.outcome, "rejected");
  assert.match(r.outcome!.problems[0].detail, /already has "a_x" between "featured_text" and the end; the position is ambiguous/);
});

test("Test 2c: with jsonSamePosition=after-existing, same-position inserts go after earlier ones", async (t) => {
  const sb = new Sandbox("t02c", { extraConfig: { jsonSamePosition: "after-existing" } });
  t.after(() => sb.cleanup());
  for (const s of ["A", "B"]) {
    const id = `${s.toLowerCase()}_x`;
    sb.editJson(s, "templates/index.json", (v) => {
      v.sections[id] = { type: "hero", settings: { heading: s } };
      v.order.push(id);
    });
  }
  await cmd.ready(sb.ctx(), { session: "A" });
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "published");
  assert.deepEqual(body(sb.readPreview("templates/index.json")!).order, ["hero", "featured_text", "a_x", "b_x"]);
});

test("Test 2d: section groups merge the same way", async (t) => {
  const sb = new Sandbox("t02d");
  t.after(() => sb.cleanup());
  sb.write("A", "sections/a-bar.liquid", section("a-bar"));
  sb.editJson("A", "sections/header-group.json", (v) => {
    v.sections.a_bar = { type: "a-bar", settings: {} };
    v.order.unshift("a_bar");
  });
  sb.write("B", "sections/b-bar.liquid", section("b-bar"));
  sb.editJson("B", "sections/header-group.json", (v) => {
    v.sections.b_bar = { type: "b-bar", settings: {} };
    v.order.push("b_bar");
  });
  await cmd.ready(sb.ctx(), { session: "A" });
  assert.equal((await cmd.ready(sb.ctx(), { session: "B" })).outcome?.outcome, "published");
  const v = JSON.parse(sb.readPreview("sections/header-group.json")!);
  assert.deepEqual(v.order, ["a_bar", "header", "b_bar"]);
  assert.equal(v.type, "header");
});

test("Test 2e: a section added with a missing section file is rejected even though the merge works", async (t) => {
  const sb = new Sandbox("t02e");
  t.after(() => sb.cleanup());
  sb.editJson("A", "templates/index.json", (v) => (v.sections.hero.settings.heading = "A"));
  await cmd.ready(sb.ctx(), { session: "A" });
  sb.editJson("B", "templates/index.json", (v) => {
    v.sections.b_ghost = { type: "b-ghost", settings: {} };
    v.order.push("b_ghost");
  });
  const r = await cmd.ready(sb.ctx(), { session: "B" });
  assert.equal(r.outcome?.outcome, "rejected");
  assert.match(r.outcome!.problems[0].detail, /missing dependency sections\/b-ghost.liquid/);
  assert.doesNotMatch(sb.readPreview("templates/index.json")!, /b_ghost/);
});
