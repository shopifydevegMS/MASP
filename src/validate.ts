// Local Shopify checks run before anything is published.
// These catch broken JSON, broken template structure, unbalanced Liquid and missing
// referenced files. They do not prove the storefront renders; Theme Check and a visual
// review are separate steps (see `masp check`).
import { parseShopifyJson } from "./shopify-json.ts";
import { refsAt } from "./deps.ts";

export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

const BLOCK_TAGS = new Set([
  "if", "unless", "for", "case", "capture", "form", "paginate", "schema", "style",
  "javascript", "stylesheet", "comment", "raw", "tablerow", "doc",
]);
const OPAQUE = new Set(["comment", "raw", "schema", "javascript", "stylesheet", "style", "doc"]);

export function checkLiquid(p: string, src: string): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: "error", path: p, message });
  const stack: string[] = [];
  const tagRe = /\{%-?\s*([a-zA-Z_#]\w*)?[\s\S]*?-?%\}|\{\{-?[\s\S]*?-?\}\}/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  let unclosed = false;
  while ((m = tagRe.exec(src))) {
    // Any '{%' or '{{' skipped over without a closing delimiter means an unterminated tag.
    const gap = src.slice(consumed, m.index);
    if (gap.includes("{%") || gap.includes("{{")) unclosed = true;
    consumed = m.index + m[0].length;
    if (!m[0].startsWith("{%")) continue;
    const name = m[1] ?? "";
    if (OPAQUE.has(name)) {
      // Content of raw/comment/schema/style blocks is not Liquid markup: jump to the end tag.
      const endRe = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, "g");
      endRe.lastIndex = consumed;
      const end = endRe.exec(src);
      if (!end) {
        err(`unclosed {% ${name} %}`);
        return issues;
      }
      consumed = tagRe.lastIndex = end.index + end[0].length;
      continue;
    }
    if (BLOCK_TAGS.has(name)) stack.push(name);
    else if (name.startsWith("end")) {
      const open = name.slice(3);
      if (!BLOCK_TAGS.has(open)) continue;
      if (stack[stack.length - 1] !== open) {
        err(`unexpected {% ${name} %}` + (stack.length ? ` (open: ${stack[stack.length - 1]})` : ""));
        return issues;
      }
      stack.pop();
    }
  }
  const rest = src.slice(consumed);
  if (unclosed || /\{%|\{\{/.test(rest))
    err("unterminated Liquid tag or output ('{%' or '{{' without a closing delimiter)");
  if (stack.length) err(`unclosed {% ${stack[stack.length - 1]} %}`);

  const schema = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(src);
  if (schema) {
    try {
      const parsed = parseShopifyJson(schema[1]);
      for (const d of parsed.duplicates) err(`duplicate key in {% schema %}: ${d}`);
    } catch (e) {
      err(`invalid JSON in {% schema %}: ${(e as Error).message}`);
    }
  }
  return issues;
}

export function checkJson(p: string, src: string): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: "error", path: p, message });
  const warn = (message: string) => issues.push({ severity: "warning", path: p, message });
  let parsed;
  try {
    parsed = parseShopifyJson(src);
  } catch (e) {
    err(`invalid JSON: ${(e as Error).message}`);
    return issues;
  }
  for (const d of parsed.duplicates) err(`duplicate key ${d} (one of them would be silently lost)`);
  const isTemplate = /^templates\/.*\.json$/.test(p);
  const isGroup = /^sections\/[^/]+\.json$/.test(p);
  if (!isTemplate && !isGroup) return issues;
  const v = parsed.value as any;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    err("template must be a JSON object");
    return issues;
  }
  if (!v.sections || typeof v.sections !== "object" || Array.isArray(v.sections)) {
    err("missing 'sections' object");
    return issues;
  }
  if (!Array.isArray(v.order)) {
    err("missing 'order' array");
    return issues;
  }
  if (isGroup && (typeof v.type !== "string" || typeof v.name !== "string")) err("section group needs 'type' and 'name'");
  const ids = Object.keys(v.sections);
  const seen = new Set<string>();
  for (const id of v.order) {
    if (typeof id !== "string") err(`order contains a non-string entry`);
    else if (seen.has(id)) err(`section id "${id}" appears twice in order`);
    else if (!(id in v.sections)) err(`order lists "${id}" but there is no such section`);
    seen.add(id);
  }
  for (const id of ids) {
    const s = v.sections[id];
    if (!s || typeof s !== "object" || typeof s.type !== "string") err(`section "${id}" has no 'type'`);
    if (!seen.has(id)) warn(`section "${id}" is not listed in order`);
  }
  if (ids.length > 25) warn(`${ids.length} sections; Shopify allows at most 25 per template`);
  return issues;
}

export function checkFile(p: string, content: Buffer): Issue[] {
  if (p.endsWith(".liquid")) return checkLiquid(p, content.toString("utf8"));
  if (p.endsWith(".json")) return checkJson(p, content.toString("utf8"));
  return [];
}

/** A view of the theme as it would look after a change set is applied. */
export interface TreeView {
  has(p: string): boolean;
  read(p: string): Buffer;
  paths(): string[];
  /** Content hash, when known: lets reference checks skip unchanged files. */
  hash?(p: string): string | null;
}

/**
 * Validate a change set against the resulting tree:
 * - each changed file passes its own checks;
 * - each changed file's references exist in the resulting tree;
 * - nothing left in the tree references a deleted file.
 */
export function checkChangeSet(tree: TreeView, changed: string[], deleted: string[]): Issue[] {
  const issues: Issue[] = [];
  for (const p of changed) {
    const content = tree.read(p);
    issues.push(...checkFile(p, content));
    for (const r of refsAt(p, tree)) {
      if (!tree.has(r.target)) issues.push({ severity: "error", path: p, message: `missing dependency ${r.target} (${r.via})` });
    }
  }
  if (deleted.length) {
    const gone = new Set(deleted);
    for (const p of tree.paths()) {
      if (!p.endsWith(".liquid") && !p.endsWith(".json")) continue;
      for (const r of refsAt(p, tree)) {
        if (gone.has(r.target))
          issues.push({ severity: "error", path: r.target, message: `cannot delete: still referenced by ${p} (${r.via})` });
      }
    }
  }
  return issues;
}
