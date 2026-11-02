// Direct tests of the structured template merge (no sandbox needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTemplate } from "../src/jsonmerge.ts";

const HEADER = "/*\n * auto-generated\n */\n";
const doc = (sections: Record<string, unknown>, order: string[], extra: Record<string, unknown> = {}) =>
  HEADER + JSON.stringify({ ...extra, sections, order }, null, 2) + "\n";
const S = (h: string) => ({ type: "hero", settings: { heading: h } });
const BASE = doc({ a: S("a"), b: S("b"), c: S("c") }, ["a", "b", "c"]);
const body = (t: string) => JSON.parse(t.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));

function ok(r: ReturnType<typeof mergeTemplate>) {
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r as Extract<typeof r, { ok: true }>;
}
function fails(r: ReturnType<typeof mergeTemplate>, re: RegExp) {
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, re);
}

test("insert between existing sections and at the start", () => {
  const preview = doc({ a: S("a"), b: S("b"), c: S("c"), x: S("x") }, ["a", "x", "b", "c"]);
  const source = doc({ a: S("a"), b: S("b"), c: S("c"), y: S("y") }, ["y", "a", "b", "c"]);
  assert.deepEqual(body(ok(mergeTemplate(BASE, source, preview)).text).order, ["y", "a", "x", "b", "c"]);
});

test("removing a section the other side did not touch", () => {
  const preview = doc({ a: S("a2"), b: S("b"), c: S("c") }, ["a", "b", "c"]);
  const source = doc({ a: S("a"), c: S("c") }, ["a", "c"]);
  const v = body(ok(mergeTemplate(BASE, source, preview)).text);
  assert.deepEqual(v.order, ["a", "c"]);
  assert.equal(v.sections.a.settings.heading, "a2");
  assert.equal(v.sections.b, undefined);
});

test("removing a section the other side changed is a conflict", () => {
  const preview = doc({ a: S("a"), b: S("B!"), c: S("c") }, ["a", "b", "c"]);
  fails(mergeTemplate(BASE, doc({ a: S("a"), c: S("c") }, ["a", "c"]), preview), /"b" was removed here but changed/);
});

test("changing a section the other side removed is a conflict", () => {
  const preview = doc({ a: S("a"), c: S("c") }, ["a", "c"]);
  fails(mergeTemplate(BASE, doc({ a: S("a"), b: S("B!"), c: S("c") }, ["a", "b", "c"]), preview), /"b" was changed here but removed/);
});

test("insertion point deleted by the other side is a conflict", () => {
  const preview = doc({ a: S("a"), c: S("c") }, ["a", "c"]);
  const source = doc({ a: S("a"), b: S("b"), c: S("c"), y: S("y") }, ["a", "b", "y", "c"]);
  fails(mergeTemplate(BASE, source, preview), /"b" \(before the new section\) no longer exists/);
});

test("reordering is never merged", () => {
  const preview = doc({ a: S("a"), b: S("b"), c: S("c"), x: S("x") }, ["a", "b", "c", "x"]);
  fails(mergeTemplate(BASE, doc({ a: S("a"), b: S("b"), c: S("c") }, ["b", "a", "c"]), preview), /reordered/);
});

test("insertion point reordered by the other side is a conflict", () => {
  const preview = doc({ a: S("a"), b: S("b"), c: S("c") }, ["b", "a", "c"]);
  const source = doc({ a: S("a"), b: S("b"), c: S("c"), y: S("y") }, ["a", "y", "b", "c"]);
  fails(mergeTemplate(BASE, source, preview), /changed in the preview|reordered/);
});

test("same id added with different content is a conflict; identical content converges", () => {
  const preview = doc({ a: S("a"), b: S("b"), c: S("c"), y: S("theirs") }, ["a", "b", "c", "y"]);
  fails(mergeTemplate(BASE, doc({ a: S("a"), b: S("b"), c: S("c"), y: S("mine") }, ["a", "b", "c", "y"]), preview), /different section with that id/);
  const same = mergeTemplate(BASE, doc({ a: S("a"), b: S("b"), c: S("c"), y: S("theirs") }, ["a", "b", "c", "y"]), preview);
  assert.ok(ok(same).converged);
});

test("top-level keys: independent change merges, both changing it conflicts", () => {
  const preview = doc({ a: S("a"), b: S("b"), c: S("c"), x: S("x") }, ["a", "b", "c", "x"]);
  const source = doc({ a: S("a"), b: S("b"), c: S("c") }, ["a", "b", "c"], { layout: "alternate" });
  assert.equal(body(ok(mergeTemplate(BASE, source, preview)).text).layout, "alternate");
  const preview2 = doc({ a: S("a"), b: S("b"), c: S("c") }, ["a", "b", "c"], { layout: "other" });
  fails(mergeTemplate(BASE, source, preview2), /top-level "layout" was changed both/);
});

test("exact tokens, numeric-looking ids and key order are preserved", () => {
  const raw = (o: string[], extra = "") => `${HEADER}{
  "sections": {
    "hero": {
      "type": "hero",
      "settings": {
        "heading": "\\u003cb\\u003eHi\\u003c\\/b\\u003e",
        "ratio": 1.50
      }
    },
    "1678901234": {
      "type": "hero",
      "settings": {}
    }${extra}
  },
  "order": [
${o.map((x) => `    "${x}"`).join(",\n")}
  ]
}
`;
  const base = raw(["hero", "1678901234"]);
  const source = raw(["hero", "1678901234", "z"], `,\n    "z": {\n      "type": "hero",\n      "settings": {}\n    }`);
  const r = ok(mergeTemplate(base, source, base));
  assert.equal(r.text, source, "output is byte-identical to the source layout");
  assert.ok(r.text.includes("\\u003cb\\u003e"));
  assert.ok(r.text.includes("1.50"));
});

test("a template with comments inside its JSON is not merged (they would be lost)", () => {
  const withComment = BASE.replace('"order"', '/* keep me */ "order"');
  const source = doc({ a: S("a"), b: S("b"), c: S("c"), y: S("y") }, ["a", "b", "c", "y"]);
  fails(mergeTemplate(BASE, source, withComment), /contains comments/);
});

test("invalid or duplicate-key input is refused, never guessed", () => {
  fails(mergeTemplate(BASE, BASE.replace('"order"', '"sections": {}, "order"'), BASE), /duplicate keys/);
  fails(mergeTemplate(BASE, "{ not json", BASE), /not valid JSON/);
});
