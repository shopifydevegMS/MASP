// Strict JSON parser for Shopify theme JSON.
// - Accepts a leading /* ... */ header comment (Shopify's "auto-generated" banner) and keeps it.
// - Reports duplicate object keys, which JSON.parse silently drops.
// - Builds an order-preserving tree (JNode) that keeps every string and number exactly as
//   written (e.g. "<p>"), so a merge rewrites only what it changes. Plain JS objects
//   would move numeric-looking keys such as section ids to the front.

export type JNode =
  | { t: "o"; e: [string, JNode][] }
  | { t: "a"; v: JNode[] }
  | { t: "p"; raw: string };

export interface ParsedTree {
  header: string;            // leading comment + whitespace, verbatim ("" if none)
  root: JNode;
  duplicates: string[];      // JSON-pointer-ish paths of duplicate keys
  trailingCommas: number;    // accepted, as Shopify does; dropped when a merge rewrites the file
  comments: number;          // comments inside the JSON body (not the header); a merge would lose them
  trailingNewline: boolean;
  indent: string;            // indentation unit detected from the text (default two spaces)
}

export interface ParsedJson {
  header: string;
  value: unknown;
  duplicates: string[];
}

export class JsonSyntaxError extends Error {
  pos: number;
  constructor(msg: string, pos: number, text: string) {
    const before = text.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n");
    super(`${msg} at line ${line}, column ${col}`);
    this.pos = pos;
  }
}

export function splitHeader(text: string): { header: string; body: string } {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
    } else break;
  }
  const header = text.slice(0, i);
  return /\/\*/.test(header) ? { header, body: text.slice(i) } : { header: "", body: text };
}

export function parseTree(text: string): ParsedTree {
  const { header, body } = splitHeader(text);
  const offset = text.length - body.length;
  const duplicates: string[] = [];
  let trailingCommas = 0;
  let comments = 0;
  let i = 0;
  const fail = (msg: string): never => {
    throw new JsonSyntaxError(msg, offset + i, text);
  };
  // Whitespace, plus /* */ and // comments, which Shopify also accepts inside theme JSON.
  const ws = () => {
    while (i < body.length) {
      const c = body[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && body[i + 1] === "*") {
        const end = body.indexOf("*/", i + 2);
        if (end === -1) fail("unterminated comment");
        i = end + 2;
        comments++;
      } else if (c === "/" && body[i + 1] === "/") {
        const end = body.indexOf("\n", i);
        i = end === -1 ? body.length : end;
        comments++;
      } else break;
    }
  };
  const strRaw = (): string => {
    if (body[i] !== '"') fail("expected string");
    const start = i;
    i++;
    while (i < body.length) {
      const c = body[i];
      if (c === '"') {
        i++;
        const raw = body.slice(start, i);
        try {
          JSON.parse(raw);
        } catch {
          i = start;
          fail("invalid string escape");
        }
        return raw;
      }
      if (c === "\\") i += 2;
      else if (c < " ") fail("control character in string");
      else i++;
    }
    return fail("unterminated string");
  };
  const node = (ptr: string): JNode => {
    ws();
    const c = body[i];
    if (c === "{") {
      i++;
      const e: [string, JNode][] = [];
      const seen = new Set<string>();
      ws();
      if (body[i] === "}") {
        i++;
        return { t: "o", e };
      }
      for (;;) {
        ws();
        const k = JSON.parse(strRaw()) as string;
        if (seen.has(k)) duplicates.push(`${ptr}/${k}`);
        seen.add(k);
        ws();
        if (body[i] !== ":") fail("expected ':'");
        i++;
        e.push([k, node(`${ptr}/${k}`)]);
        ws();
        if (body[i] === ",") {
          i++;
          ws();
          // Shopify accepts a trailing comma before '}' (common in real themes).
          if (body[i] === "}") { i++; trailingCommas++; return { t: "o", e }; }
          continue;
        }
        if (body[i] === "}") { i++; return { t: "o", e }; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const v: JNode[] = [];
      ws();
      if (body[i] === "]") {
        i++;
        return { t: "a", v };
      }
      for (;;) {
        v.push(node(`${ptr}/${v.length}`));
        ws();
        if (body[i] === ",") {
          i++;
          ws();
          if (body[i] === "]") { i++; trailingCommas++; return { t: "a", v }; }
          continue;
        }
        if (body[i] === "]") { i++; return { t: "a", v }; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return { t: "p", raw: strRaw() };
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(body.slice(i, i + 64));
    if (!m) return fail("unexpected token");
    i += m[0].length;
    return { t: "p", raw: m[0] };
  };
  const root = node("");
  ws();
  if (i < body.length) fail("unexpected content after JSON value");
  const ind = /\n([ \t]+)\S/.exec(body);
  return { header, root, duplicates, trailingCommas, comments, trailingNewline: /\n\s*$/.test(body), indent: ind ? ind[1] : "  " };
}

export function toValue(n: JNode): unknown {
  if (n.t === "p") return JSON.parse(n.raw);
  if (n.t === "a") return n.v.map(toValue);
  const o: Record<string, unknown> = {};
  for (const [k, v] of n.e) o[k] = toValue(v);
  return o;
}

export function parseShopifyJson(text: string): ParsedJson {
  const t = parseTree(text);
  return { header: t.header, value: toValue(t.root), duplicates: t.duplicates };
}

/** Semantic equality: key order ignored, strings compared after decoding escapes. */
export function sameNode(a: JNode | undefined, b: JNode | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.t !== b.t) return false;
  if (a.t === "p") return a.raw === (b as typeof a).raw || JSON.stringify(JSON.parse(a.raw)) === JSON.stringify(JSON.parse((b as typeof a).raw));
  if (a.t === "a") {
    const bv = (b as typeof a).v;
    return a.v.length === bv.length && a.v.every((x, i) => sameNode(x, bv[i]));
  }
  const be = (b as typeof a).e;
  if (a.e.length !== be.length) return false;
  return a.e.every(([k, v]) => sameNode(v, get(b, k)));
}

export function get(n: JNode | undefined, key: string): JNode | undefined {
  if (!n || n.t !== "o") return undefined;
  for (let i = n.e.length - 1; i >= 0; i--) if (n.e[i][0] === key) return n.e[i][1];
  return undefined;
}

export function has(n: JNode, key: string): boolean {
  return n.t === "o" && n.e.some(([k]) => k === key);
}

/** Replace in place (keeps position), or append if new. */
export function set(n: JNode, key: string, v: JNode): void {
  if (n.t !== "o") throw new Error("not an object");
  const i = n.e.findIndex(([k]) => k === key);
  if (i >= 0) n.e[i] = [key, v];
  else n.e.push([key, v]);
}

export function del(n: JNode, key: string): void {
  if (n.t !== "o") throw new Error("not an object");
  n.e = n.e.filter(([k]) => k !== key);
}

export function str(s: string): JNode {
  return { t: "p", raw: JSON.stringify(s) };
}

/** Same layout as JSON.stringify(value, null, indent), but with the original raw tokens. */
export function serialize(n: JNode, indent = "  ", level = 0): string {
  if (n.t === "p") return n.raw;
  const pad = indent.repeat(level + 1);
  const close = indent.repeat(level);
  if (n.t === "a") {
    if (!n.v.length) return "[]";
    return `[\n${n.v.map((x) => pad + serialize(x, indent, level + 1)).join(",\n")}\n${close}]`;
  }
  if (!n.e.length) return "{}";
  return `{\n${n.e.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${serialize(v, indent, level + 1)}`).join(",\n")}\n${close}}`;
}

export function printTree(t: ParsedTree, root: JNode): string {
  return t.header + serialize(root, t.indent) + (t.trailingNewline ? "\n" : "");
}
