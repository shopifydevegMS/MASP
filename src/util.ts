// Small shared helpers: hashing, line endings, atomic writes, globbing, file walking.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * Canonical form used for hashing, storing and publishing.
 * Text files get LF line endings so that core.autocrlf=true worktrees (CRLF on disk)
 * compare equal to Git's LF content. Binary files are left untouched.
 */
export function canonicalize(buf: Buffer): Buffer {
  if (buf.indexOf(13) === -1 || !isText(buf)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 13 && buf[i + 1] === 10) continue;
    out[j++] = c;
  }
  return out.subarray(0, j);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${prefix}-${t}-${crypto.randomBytes(3).toString("hex")}`;
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * Windows refuses to replace or delete a file another process has open
 * (Shopify CLI, antivirus, editors). Retry with backoff before giving up.
 */
export function withRetry<T>(fn: () => T, attempts = 8): T {
  let delay = 25;
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= attempts - 1) throw e;
      sleepSync(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }
}

export function fsyncFile(p: string): void {
  const fd = fs.openSync(p, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write to a temp file in the same directory, fsync, then rename over the target. */
export function atomicWriteFile(target: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    withRetry(() => fs.renameSync(tmp, target));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Glob to RegExp. Supports **, *, ? and {a,b}. Paths are POSIX, relative. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      const alts = glob.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&"));
      re += `(?:${alts.join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

const globCache = new Map<string, RegExp>();
export function matchAny(p: string, globs: string[] | undefined): boolean {
  if (!globs) return false;
  for (const g of globs) {
    let re = globCache.get(g);
    if (!re) {
      re = globToRegExp(g);
      globCache.set(g, re);
    }
    if (re.test(p)) return true;
  }
  return false;
}

/** Recursively list files under root/dirs as POSIX relative paths. */
export function walkFiles(root: string, dirs: string[], ignore: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (matchAny(r, ignore) || matchAny(e.name, ignore)) continue;
      if (e.isDirectory()) visit(r);
      else if (e.isFile()) out.push(r);
    }
  };
  for (const d of dirs) visit(d);
  return out.sort();
}
