// Generates a synthetic Shopify theme of realistic size for performance runs.
// Deterministic (seeded) so runs are comparable.
import fs from "node:fs";
import path from "node:path";

export interface GenOptions {
  sections?: number;
  snippets?: number;
  css?: number;
  js?: number;
  images?: number;
  templates?: number;
  locales?: number;
}

export function generateTheme(dir: string, o: GenOptions = {}): number {
  const n = { sections: 120, snippets: 300, css: 120, js: 80, images: 300, templates: 40, locales: 40, ...o };
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let count = 0;
  const w = (rel: string, data: string | Buffer) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    count++;
  };
  const filler = (k: number) => Array.from({ length: k }, (_, i) => `  <!-- block ${i} -->`).join("\n");

  w("layout/theme.liquid", `<!doctype html>\n<html>\n<head>\n{{ content_for_header }}\n{{ 'base.css' | asset_url | stylesheet_tag }}\n</head>\n<body>\n{% sections 'header-group' %}\n{{ content_for_layout }}\n</body>\n</html>\n`);
  w("config/settings_schema.json", JSON.stringify([{ name: "theme_info", theme_name: "Synthetic", theme_version: "1.0.0", theme_author: "MASP", theme_documentation_url: "https://example.com", theme_support_url: "https://example.com" }], null, 2));
  w("config/settings_data.json", JSON.stringify({ current: {} }, null, 2));
  w("assets/base.css", "body { margin: 0; }\n");
  w("sections/header.liquid", `<header></header>\n{% schema %}\n{ "name": "Header" }\n{% endschema %}\n`);
  w("sections/header-group.json", JSON.stringify({ type: "header", name: "Header group", sections: { header: { type: "header", settings: {} } }, order: ["header"] }, null, 2));
  for (let i = 0; i < n.snippets; i++) w(`snippets/snippet-${i}.liquid`, `{%- comment -%} snippet ${i} {%- endcomment -%}\n<div class="s${i}">{{ text | escape }}</div>\n${filler(20)}\n`);
  for (let i = 0; i < n.sections; i++) {
    const s1 = Math.floor(rnd() * n.snippets), s2 = Math.floor(rnd() * n.snippets);
    w(`sections/section-${i}.liquid`, `<section class="section-${i}">\n  {% render 'snippet-${s1}', text: section.settings.title %}\n  {% render 'snippet-${s2}' %}\n${filler(60)}\n</section>\n{% schema %}\n{ "name": "Section ${i}", "settings": [{ "type": "text", "id": "title", "label": "Title" }], "presets": [{ "name": "Section ${i}" }] }\n{% endschema %}\n`);
  }
  for (let i = 0; i < n.css; i++) w(`assets/component-${i}.css`, Array.from({ length: 80 }, (_, k) => `.c${i}-${k} { padding: ${k}px; color: #${(k * 997).toString(16).padStart(6, "0").slice(0, 6)}; }`).join("\n") + "\n");
  for (let i = 0; i < n.js; i++) w(`assets/component-${i}.js`, Array.from({ length: 120 }, (_, k) => `export function f${i}_${k}(x) { return x + ${k}; }`).join("\n") + "\n");
  for (let i = 0; i < n.images; i++) {
    const b = Buffer.alloc(8000 + Math.floor(rnd() * 40000));
    for (let k = 0; k < b.length; k++) b[k] = Math.floor(rnd() * 256);
    b.write("\x89PNG\r\n\x1a\n", 0, "latin1");
    b[8] = 0; // binary
    w(`assets/image-${i}.png`, b);
  }
  const header = "/*\n * IMPORTANT: The contents of this file are auto-generated.\n */\n";
  for (let i = 0; i < n.templates; i++) {
    const name = i === 0 ? "index" : `page.t${i}`;
    const sections: Record<string, unknown> = {};
    const order: string[] = [];
    for (let k = 0; k < 8; k++) {
      const id = `s${k}_${Math.floor(rnd() * 1e9)}`;
      sections[id] = { type: `section-${Math.floor(rnd() * n.sections)}`, settings: { title: `Title ${k}` } };
      order.push(id);
    }
    w(`templates/${name}.json`, header + JSON.stringify({ sections, order }, null, 2) + "\n");
  }
  for (let i = 0; i < n.locales; i++) {
    const strings: Record<string, string> = {};
    for (let k = 0; k < 200; k++) strings[`key_${k}`] = `String ${k} for locale ${i}`;
    w(`locales/${i === 0 ? "en.default" : `l${i}`}.json`, JSON.stringify({ general: strings }, null, 2));
  }
  return count;
}
