// Structured three-way merge for Shopify JSON templates and section groups.
//
// The session's change (base -> source) is broken into a small set of operations.
// Each one is applied to the current preview only if its precondition still holds there:
//
//   set top-level key k       preview[k] is still the base value
//   add section id            id does not exist in the preview
//   remove section id         preview's section is still the base version
//   modify section id         preview's section is still the base version (whole section)
//   insert ids into order     the neighbours they were inserted between are still adjacent
//   remove ids from order     (with the section)
//
// Anything else (reordering, a section changed by both sides, a deleted insertion point,
// two inserts at the same position, duplicate ids) is reported as a conflict.
// Settings inside one section are never merged: two changes to one section always conflict.
import { del, get, has, parseTree, printTree, sameNode, set, str, type JNode, type ParsedTree } from "./shopify-json.ts";

export type SamePosition = "block" | "after-existing";

export type MergeResult =
  | { ok: true; text: string; changes: string[]; converged: boolean }
  | { ok: false; reason: string };

export function isMergeablePath(p: string): boolean {
  return /^templates\/.*\.json$/.test(p) || /^sections\/[^/]+\.json$/.test(p);
}

interface Doc {
  tree: ParsedTree;
  root: JNode & { t: "o" };
  sections: JNode & { t: "o" };
  order: string[];
}

function load(label: string, text: string): Doc | string {
  let tree: ParsedTree;
  try {
    tree = parseTree(text);
  } catch (e) {
    return `${label} version is not valid JSON: ${(e as Error).message}`;
  }
  if (tree.duplicates.length) return `${label} version has duplicate keys (${tree.duplicates.join(", ")})`;
  if (tree.comments) return `${label} version contains comments inside the JSON; merging would remove them, so it is not merged automatically`;
  const root = tree.root;
  if (root.t !== "o") return `${label} version is not a JSON object`;
  const sections = get(root, "sections");
  const order = get(root, "order");
  if (!sections || sections.t !== "o") return `${label} version has no 'sections' object`;
  if (!order || order.t !== "a" || order.v.some((x) => x.t !== "p" || !x.raw.startsWith('"')))
    return `${label} version has no valid 'order' array`;
  const ids = order.v.map((x) => JSON.parse((x as { raw: string }).raw) as string);
  if (new Set(ids).size !== ids.length) return `${label} version lists a section twice in 'order'`;
  return { tree, root: root as Doc["root"], sections: sections as Doc["sections"], order: ids };
}

const q = (id: string | null) => (id === null ? "the start" : `"${id}"`);

export function mergeTemplate(
  baseText: string, sourceText: string, previewText: string,
  opts: { samePosition?: SamePosition; other?: string } = {},
): MergeResult {
  const other = opts.other ?? "the preview";
  const base = load("base", baseText);
  if (typeof base === "string") return { ok: false, reason: base };
  const src = load("this session's", sourceText);
  if (typeof src === "string") return { ok: false, reason: src };
  const prev = load("preview", previewText);
  if (typeof prev === "string") return { ok: false, reason: prev };

  const out = prev; // apply onto the preview tree (fresh parse, safe to mutate)
  const changes: string[] = [];
  let converged = true;
  const conflict = (reason: string): MergeResult => ({ ok: false, reason });

  // 1. Top-level keys other than sections/order (e.g. layout, wrapper, name, type).
  const topKeys = new Set<string>();
  for (const [k] of base.root.e) topKeys.add(k);
  for (const [k] of src.root.e) topKeys.add(k);
  topKeys.delete("sections");
  topKeys.delete("order");
  for (const k of topKeys) {
    const b = get(base.root, k), s = get(src.root, k), p = get(out.root, k);
    if (sameNode(b, s)) continue;
    if (sameNode(p, s)) { changes.push(`top-level "${k}" already matches`); continue; }
    if (!sameNode(p, b)) return conflict(`top-level "${k}" was changed both here and in ${other}`);
    if (s === undefined) del(out.root, k);
    else set(out.root, k, s);
    converged = false;
    changes.push(`${s === undefined ? "removed" : "set"} top-level "${k}"`);
  }

  // 2. Sections (whole-section granularity).
  const baseIds = new Set(base.sections.e.map(([k]) => k));
  const srcIds = new Set(src.sections.e.map(([k]) => k));
  const removed = [...baseIds].filter((id) => !srcIds.has(id));
  const added = [...srcIds].filter((id) => !baseIds.has(id));
  for (const id of removed) {
    const p = get(out.sections, id);
    if (p === undefined) { changes.push(`section "${id}" already removed`); continue; }
    if (!sameNode(p, get(base.sections, id))) return conflict(`section "${id}" was removed here but changed in ${other}`);
    del(out.sections, id);
    converged = false;
    changes.push(`removed section "${id}"`);
  }
  for (const id of srcIds) {
    if (!baseIds.has(id)) continue;
    const b = get(base.sections, id)!, s = get(src.sections, id)!, p = get(out.sections, id);
    if (sameNode(b, s)) continue;
    if (p === undefined) return conflict(`section "${id}" was changed here but removed in ${other}`);
    if (sameNode(p, s)) { changes.push(`section "${id}" already matches`); continue; }
    if (!sameNode(p, b)) return conflict(`section "${id}" was changed both here and in ${other}; changes inside one section are never merged automatically`);
    set(out.sections, id, s);
    converged = false;
    changes.push(`modified section "${id}"`);
  }
  const alreadyAdded = new Set<string>();
  for (const id of added) {
    const p = get(out.sections, id);
    const s = get(src.sections, id)!;
    if (p !== undefined) {
      if (sameNode(p, s)) { alreadyAdded.add(id); continue; }
      return conflict(`section id "${id}" was added here, but ${other} already has a different section with that id`);
    }
    set(out.sections, id, s);
    converged = false;
    changes.push(`added section "${id}"`);
  }

  // 3. Order. The session may only insert and remove ids; surviving ids keep their relative order.
  const srcOrderSet = new Set(src.order);
  const survivors = base.order.filter((id) => srcOrderSet.has(id));
  const srcBaseIds = src.order.filter((id) => base.order.includes(id));
  if (survivors.join("\0") !== srcBaseIds.join("\0"))
    return conflict(`this session reordered existing sections; reordering is not merged automatically`);
  for (const id of base.order) {
    if (!srcOrderSet.has(id) && srcIds.has(id)) return conflict(`section "${id}" was taken out of 'order' but kept; not supported`);
  }
  for (const id of src.order) {
    if (!base.order.includes(id) && baseIds.has(id)) return conflict(`existing section "${id}" was added to 'order'; not supported`);
  }

  let Q = out.order.filter((id) => !removed.includes(id));
  if (Q.length !== out.order.length) converged = false;

  // Runs of consecutive inserted ids, each with the base neighbours it sits between.
  const runs: { ids: string[]; before: string | null; after: string | null }[] = [];
  for (let i = 0; i < src.order.length; i++) {
    const id = src.order[i];
    if (base.order.includes(id)) continue;
    const run = [id];
    while (i + 1 < src.order.length && !base.order.includes(src.order[i + 1])) run.push(src.order[++i]);
    const before = src.order.slice(0, i - run.length + 1).filter((x) => base.order.includes(x)).at(-1) ?? null;
    const after = src.order.slice(i + 1).find((x) => base.order.includes(x)) ?? null;
    runs.push({ ids: run, before, after });
  }
  for (const r of runs) {
    const present = r.ids.filter((id) => Q.includes(id));
    if (present.length === r.ids.length && r.ids.every((id) => alreadyAdded.has(id))) continue; // identical change already there
    if (present.length) return conflict(`section(s) ${present.map((x) => `"${x}"`).join(", ")} are already in the preview's order`);
    const iB = r.before === null ? -1 : Q.indexOf(r.before);
    const iA = r.after === null ? Q.length : Q.indexOf(r.after);
    if (r.before !== null && iB < 0) return conflict(`insertion point: section ${q(r.before)} (before the new section) no longer exists in the preview`);
    if (r.after !== null && iA < 0) return conflict(`insertion point: section ${q(r.after)} (after the new section) no longer exists in the preview`);
    if (iA <= iB) return conflict(`insertion point: sections ${q(r.before)} and ${q(r.after)} were reordered in the preview`);
    const between = Q.slice(iB + 1, iA);
    let at = iB + 1;
    if (between.length) {
      const othersOnly = between.every((id) => !base.order.includes(id));
      const where = `between ${q(r.before)} and ${r.after === null ? "the end" : q(r.after)}`;
      if (!othersOnly) return conflict(`insertion point ${where} changed in the preview`);
      if (opts.samePosition !== "after-existing")
        return conflict(`${other} already has ${between.map((x) => `"${x}"`).join(", ")} ${where}; the position is ambiguous (set "jsonSamePosition": "after-existing" to place it after them)`);
      at = iA;
    }
    Q = [...Q.slice(0, at), ...r.ids, ...Q.slice(at)];
    converged = false;
    changes.push(`inserted ${r.ids.map((x) => `"${x}"`).join(", ")} into order after ${q(at === 0 ? null : Q[at - 1])}`);
  }

  // Write the order back, reusing the preview's original tokens.
  const tokens = new Map((get(out.root, "order") as { t: "a"; v: JNode[] }).v.map((x) => [JSON.parse((x as { raw: string }).raw) as string, x]));
  set(out.root, "order", { t: "a", v: Q.map((id) => tokens.get(id) ?? str(id)) });

  // Every listed id must have a section and vice versa for ids this merge touched.
  for (const id of Q) if (!has(out.sections, id)) return conflict(`merged order lists "${id}" but no such section exists`);
  return { ok: true, text: printTree(out.tree, out.root), changes, converged };
}
