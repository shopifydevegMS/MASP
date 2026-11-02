import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShopifyJson } from "../src/shopify-json.ts";
import { checkJson, checkLiquid } from "../src/validate.ts";
import { liquidRefs, jsonRefs } from "../src/deps.ts";
import { canonicalize, globToRegExp, sha256 } from "../src/util.ts";
import { git } from "../src/git.ts";

test("Shopify JSON: keeps the auto-generated header and reports duplicate keys", () => {
  const src = `/*\n * auto-generated\n */\n{"sections":{"a":{"type":"x"},"a":{"type":"y"}},"order":["a"]}`;
  const r = parseShopifyJson(src);
  assert.match(r.header, /auto-generated/);
  assert.deepEqual(r.duplicates, ["/sections/a"]);
  assert.throws(() => JSON.parse(src)); // standard parser rejects the header
});

test("Shopify JSON: trailing commas and comments are accepted, as Shopify does (found in a real theme)", () => {
  const r = parseShopifyJson(`{\n  "settings": [\n    { "id": "a", },\n    /* { "id": "off" }, */\n    // note\n  ],\n  /*"presets": []*/\n}`);
  assert.deepEqual(r.value, { settings: [{ id: "a" }] });
  assert.equal(checkLiquid("s.liquid", `{% schema %}\n{ "name": "x", "settings": [ { "id": "a", }, ], /* "presets": [] */ }\n{% endschema %}`).length, 0);
  assert.throws(() => parseShopifyJson(`{ "a": 1 /* never closed }`), /unterminated comment/);
});

test("Shopify JSON: syntax errors carry a line number", () => {
  assert.throws(() => parseShopifyJson('{\n "a": 1\n "b": 2\n}'), /line 3/);
});

test("template structure checks", () => {
  const issues = checkJson("templates/index.json", JSON.stringify({ sections: { a: { type: "x" }, b: { type: "y" } }, order: ["a", "a", "c"] }));
  const msgs = issues.map((i) => `${i.severity}: ${i.message}`);
  assert.ok(msgs.some((m) => m.includes(`"a" appears twice`)));
  assert.ok(msgs.some((m) => m.includes(`lists "c" but there is no such section`)));
  assert.ok(msgs.some((m) => m.startsWith("warning") && m.includes(`"b" is not listed`)));
});

test("Liquid checks: unbalanced tags, unterminated output, bad schema JSON", () => {
  assert.equal(checkLiquid("s.liquid", "{% if a %}x{% endif %}{{ y }}").length, 0);
  assert.match(checkLiquid("s.liquid", "{% if a %}x")[0].message, /unclosed/);
  assert.match(checkLiquid("s.liquid", "{% for a in b %}{% endif %}")[0].message, /unexpected/);
  assert.match(checkLiquid("s.liquid", "<p>{{ product.title </p>")[0].message, /unterminated/);
  assert.match(checkLiquid("s.liquid", '{% schema %}{"name": "x" "settings": []}{% endschema %}')[0].message, /schema/);
  // Liquid inside {% raw %} and comments is not parsed.
  assert.equal(checkLiquid("s.liquid", "{% raw %}{{ {% if {% endraw %}").length, 0);
});

test("dependency extraction", () => {
  const refs = liquidRefs(`{% render 'card' %}{%- include "old" -%}{% section 'hero' %}{% sections 'header-group' %}{{ 'x.css' | asset_url }}{% comment %}{% render 'ignored' %}{% endcomment %}{% liquid\n  render 'inner'\n%}`);
  assert.deepEqual(refs.map((r) => r.target).sort(), [
    "assets/x.css", "sections/header-group.json", "sections/hero.liquid", "snippets/card.liquid", "snippets/inner.liquid", "snippets/old.liquid",
  ]);
  const j = jsonRefs("templates/index.json", `/* h */ {"sections":{"a":{"type":"hero"},"b":{"type":"shopify://apps/x/blocks/y"},"c":{"type":"apps"}},"order":["a","b","c"]}`);
  assert.deepEqual(j.map((r) => r.target), ["sections/hero.liquid"]);
});

test("reference cache: results follow content changes (cached by content hash)", async () => {
  const { refsAt } = await import("../src/deps.ts");
  const files: Record<string, string> = {
    "sections/s.liquid": `{% render 'one' %}`,
    "sections/sec.liquid": `{% schema %}{"name":"S","blocks":[{"type":"note","name":"Note"}]}{% endschema %}`,
    "templates/index.json": JSON.stringify({ sections: { a: { type: "sec", blocks: { b1: { type: "note" } } } }, order: ["a"] }),
  };
  const reader = {
    has: (p: string) => p in files,
    read: (p: string) => Buffer.from(files[p]),
    hash: (p: string) => (p in files ? sha256(files[p]) : null),
  };
  const targets = (p: string) => refsAt(p, reader).map((r) => r.target).sort();
  assert.deepEqual(targets("sections/s.liquid"), ["snippets/one.liquid"]);
  files["sections/s.liquid"] = `{% render 'two' %}`;
  assert.deepEqual(targets("sections/s.liquid"), ["snippets/two.liquid"], "new content, new result");
  // "note" is a local block of the section: no block file needed.
  assert.deepEqual(targets("templates/index.json"), ["sections/sec.liquid"]);
  // The section stops defining "note" locally: the unchanged template now needs blocks/note.liquid.
  files["sections/sec.liquid"] = `{% schema %}{"name":"S","blocks":[{"type":"@theme"}]}{% endschema %}`;
  assert.deepEqual(targets("templates/index.json"), ["blocks/note.liquid", "sections/sec.liquid"]);
});

test("line endings: CRLF and LF versions hash the same; binary is untouched", () => {
  assert.equal(sha256(canonicalize(Buffer.from("a\r\nb\r\n"))), sha256(Buffer.from("a\nb\n")));
  const bin = Buffer.from([0, 13, 10, 1]);
  assert.equal(canonicalize(bin), bin);
});

test("globs", () => {
  assert.ok(globToRegExp("templates/**/*.json").test("templates/index.json"));
  assert.ok(globToRegExp("templates/**/*.json").test("templates/customers/login.json"));
  assert.ok(!globToRegExp("sections/a-*.liquid").test("sections/b-x.liquid"));
  assert.ok(globToRegExp("assets/{dev1,dev2}.css").test("assets/dev2.css"));
});

test("Git policy: only masp land/resync (src/land.ts) and masp new (src/setup.ts) can use Git write access", async () => {
  const fs = await import("node:fs");
  const users = fs.readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "gitwrite.ts" && fs.readFileSync(`src/${f}`, "utf8").includes("gitwrite"));
  assert.deepEqual(users, ["land.ts", "setup.ts"]);
  const { gitWrite } = await import("../src/gitwrite.ts");
  for (const args of [["push", "origin", "main"], ["commit", "-m", "x"], ["reset", "--soft", "HEAD~1"], ["update-ref", "refs/heads/main", "abc"], ["merge", "x"], ["branch", "-D", "main"]])
    assert.throws(() => gitWrite(".", args), /MASP git write policy/);
});

test("Git policy: write commands are refused before Git is even started", () => {
  for (const args of [["commit", "-m", "x"], ["push"], ["reset", "--hard"], ["rebase", "main"], ["merge", "x"], ["worktree", "add", "x"], ["config", "user.name", "x"], ["checkout", "x"], ["stash"]])
    assert.throws(() => git(".", args), /MASP git policy/);
});
