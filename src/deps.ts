// Static references between theme files, used to avoid publishing broken features.
// Only literal references are found; dynamic names (render variable) cannot be checked.
import fs from "node:fs";
import path from "node:path";
import { parseShopifyJson } from "./shopify-json.ts";
import { atomicWriteFile } from "./util.ts";

export interface Ref {
  target: string;   // theme path the file depends on
  via: string;      // how it was referenced, for messages
}

/** Read access to the theme as it would look after a change (used for template block checks). */
export interface Reader {
  has(p: string): boolean;
  read(p: string): Buffer;
  /** Content hash of p, if known. Lets results be cached so unchanged files are not re-read. */
  hash?(p: string): string | null;
}

// ---------------------------------------------------------------- caches (keyed by content hash)
// A Liquid file's own references and a section's local block types depend only on its content,
// so these caches are always valid. They are saved to disk so a restarted process starts warm.
const liquidCache = new Map<string, Ref[]>();
const localBlockCache = new Map<string, string[]>();
const jsonValueCache = new Map<string, unknown>(); // parsed templates, memory only
const MAX_ENTRIES = 50000;
let dirty = false;

function remember<V>(m: Map<string, V>, k: string, v: V): V {
  if (m.size >= MAX_ENTRIES) m.clear();
  m.set(k, v);
  dirty = true;
  return v;
}

export function loadRefCache(file: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [h, refs] of Object.entries<Ref[]>(raw.liquid ?? {})) liquidCache.set(h, refs);
    for (const [h, types] of Object.entries<string[]>(raw.localBlocks ?? {})) localBlockCache.set(h, types);
  } catch { /* no cache yet */ }
}

export function saveRefCache(file: string): void {
  // Never recreate a data folder that was deleted (e.g. a finished test sandbox) just to save a cache.
  if (!dirty || !fs.existsSync(path.dirname(file))) return;
  atomicWriteFile(file, JSON.stringify({ liquid: Object.fromEntries(liquidCache), localBlocks: Object.fromEntries(localBlockCache) }));
  dirty = false;
}

function stripLiquidComments(src: string): string {
  return src
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/\{%-?\s*#[^%]*-?%\}/g, "")
    .replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, "");
}

const SCHEMA = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

function schemaOf(src: string): any | null {
  const m = SCHEMA.exec(src);
  if (!m) return null;
  try {
    return parseShopifyJson(m[1]).value;
  } catch {
    return null;
  }
}

/** Is this block type something other than a theme block file? (@app, @theme, app blocks) */
function notAFile(type: unknown): boolean {
  return typeof type !== "string" || type.startsWith("@") || type.startsWith("shopify://");
}

export function liquidRefs(src: string): Ref[] {
  const text = stripLiquidComments(src);
  const refs: Ref[] = [];
  const add = (target: string, via: string) => {
    if (!refs.some((r) => r.target === target)) refs.push({ target, via });
  };
  // {% render 'x' %}, {% include 'x' %}, also inside {% liquid %} blocks: render 'x'
  for (const m of text.matchAll(/(?:\{%-?|\n|^)\s*(render|include)\s+(['"])([^'"]+)\2/g))
    add(`snippets/${m[3]}.liquid`, `${m[1]} '${m[3]}'`);
  for (const m of text.matchAll(/(?:\{%-?|\n|^)\s*section\s+(['"])([^'"]+)\1/g))
    add(`sections/${m[2]}.liquid`, `section '${m[2]}'`);
  for (const m of text.matchAll(/(?:\{%-?|\n|^)\s*sections\s+(['"])([^'"]+)\1/g))
    add(`sections/${m[2]}.json`, `sections '${m[2]}'`);
  for (const m of text.matchAll(/(['"])([^'"{}]+)\1\s*\|\s*asset_url/g))
    add(`assets/${m[2]}`, `'${m[2]}' | asset_url`);
  // Static theme blocks: {% content_for 'block', type: 'x', id: 'y' %}
  for (const m of text.matchAll(/content_for\s+(['"])block\1\s*,\s*type:\s*(['"])([^'"]+)\2/g))
    add(`blocks/${m[3]}.liquid`, `content_for 'block', type: '${m[3]}'`);
  // Schema entries without a name refer to theme block files: "blocks": [{ "type": "x" }]
  const schema = schemaOf(src);
  for (const b of Array.isArray(schema?.blocks) ? schema.blocks : []) {
    if (!b || notAFile(b.type) || b.name) continue;
    add(`blocks/${b.type}.liquid`, `schema block type "${b.type}"`);
  }
  return refs;
}

/**
 * Block instances in a template or section group: each block's type must be a local block of
 * its section (a schema entry with a name) or a theme block file. Nested blocks are checked
 * against the schema of the theme block that contains them.
 */
/** Block types a section or theme block defines itself (schema entries with a name). */
function localBlockTypes(owner: string, reader: Reader): Set<string> {
  if (!reader.has(owner)) return new Set();
  const h = reader.hash?.(owner) ?? null;
  const cached = h ? localBlockCache.get(h) : undefined;
  if (cached) return new Set(cached);
  const schema = schemaOf(reader.read(owner).toString("utf8"));
  const types = (Array.isArray(schema?.blocks) ? schema.blocks : []).filter((b: any) => b?.name && typeof b.type === "string").map((b: any) => b.type as string);
  if (h) remember(localBlockCache, h, types);
  return new Set(types);
}

function templateBlockRefs(sectionId: string, sectionType: string, blocks: unknown, reader: Reader, refs: Ref[], depth = 0): void {
  if (!blocks || typeof blocks !== "object" || depth > 8) return;
  const local = localBlockTypes(sectionType, reader);
  for (const [id, b] of Object.entries<any>(blocks as Record<string, unknown>)) {
    const type = b?.type;
    if (notAFile(type) || local.has(type)) continue;
    const target = `blocks/${type}.liquid`;
    if (!refs.some((r) => r.target === target)) refs.push({ target, via: `section "${sectionId}" block "${id}" type "${type}"` });
    if (reader.has(target)) templateBlockRefs(sectionId, target, b.blocks, reader, refs, depth + 1);
  }
}

/** Templates and section groups reference section files by `type`, and theme blocks inside them. */
export function jsonRefs(p: string, text: string, reader?: Reader): Ref[] {
  if (!/^(templates\/.*|sections\/[^/]+)\.json$/.test(p)) return [];
  let v: any;
  try {
    v = parseShopifyJson(text).value;
  } catch {
    return [];
  }
  return jsonRefsFromValue(v, reader);
}

function jsonRefsFromValue(v: any, reader?: Reader): Ref[] {
  const refs: Ref[] = [];
  const sections = v && typeof v === "object" ? v.sections : undefined;
  if (sections && typeof sections === "object") {
    for (const [id, s] of Object.entries<any>(sections)) {
      const type = s?.type;
      // "apps" is Shopify's built-in app section; shopify:// types come from apps.
      if (typeof type !== "string" || type.startsWith("shopify://") || type === "apps") continue;
      const target = `sections/${type}.liquid`;
      if (!refs.some((r) => r.target === target)) refs.push({ target, via: `section "${id}" type "${type}"` });
      if (reader && reader.has(target)) templateBlockRefs(id, target, s.blocks, reader, refs);
    }
  }
  if (v && typeof v.layout === "string" && v.layout !== "none" && v.layout !== false)
    refs.push({ target: `layout/${v.layout}.liquid`, via: `layout "${v.layout}"` });
  return refs;
}

/**
 * References of the file at p in the given tree. Uses the content hash when the tree knows it,
 * so an unchanged Liquid file is neither read nor parsed again.
 */
export function refsAt(p: string, reader: Reader): Ref[] {
  if (p.endsWith(".liquid")) {
    const h = reader.hash?.(p) ?? null;
    const hit = h ? liquidCache.get(h) : undefined;
    if (hit) return hit;
    const refs = liquidRefs(reader.read(p).toString("utf8"));
    return h ? remember(liquidCache, h, refs) : refs;
  }
  if (p.endsWith(".json")) {
    if (!/^(templates\/.*|sections\/[^/]+)\.json$/.test(p)) return [];
    const h = reader.hash?.(p) ?? null;
    let v = h ? jsonValueCache.get(h) : undefined;
    if (v === undefined) {
      try {
        v = parseShopifyJson(reader.read(p).toString("utf8")).value;
      } catch {
        return [];
      }
      if (h) {
        if (jsonValueCache.size >= MAX_ENTRIES) jsonValueCache.clear();
        jsonValueCache.set(h, v);
      }
    }
    // Template references also depend on the section schemas they use, so they are
    // recomputed each time (cheap: schemas' local block types are cached).
    return jsonRefsFromValue(v, reader);
  }
  return [];
}

export function refsOf(p: string, content: Buffer, reader?: Reader): Ref[] {
  if (p.endsWith(".liquid")) return liquidRefs(content.toString("utf8"));
  if (p.endsWith(".json")) return jsonRefs(p, content.toString("utf8"), reader);
  return [];
}
