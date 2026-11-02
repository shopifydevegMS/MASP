// Hashing theme files with a size+mtime cache so repeated scans stay cheap.
import fs from "node:fs";
import path from "node:path";
import type { MaspConfig } from "./config.ts";
import { atomicWriteFile, canonicalize, sha256, walkFiles } from "./util.ts";

interface Sig {
  size: number;
  mtimeMs: number;
  hash: string;
}

export class Scanner {
  private cache = new Map<string, Sig>();
  hashedFiles = 0; // files actually read (for overhead measurements)

  /** Canonical content + hash of one file, or null if it does not exist. */
  read(abs: string): { buf: Buffer; hash: string } | null {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
    const buf = canonicalize(raw);
    return { buf, hash: sha256(buf) };
  }

  hashOf(abs: string): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      this.cache.delete(abs);
      return null;
    }
    if (!st.isFile()) return null;
    const c = this.cache.get(abs);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash;
    const r = this.read(abs);
    if (!r) return null;
    this.hashedFiles++;
    this.cache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, hash: r.hash });
    return r.hash;
  }

  /** Persist the cache so a restarted controller does not re-read every file. Entries are
   * only (path, size, mtime) -> hash facts, so a cache written by another process is still valid. */
  load(file: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, [number, number, string]>;
      for (const [abs, [size, mtimeMs, hash]] of Object.entries(raw)) this.cache.set(abs, { size, mtimeMs, hash });
    } catch { /* no cache yet */ }
  }
  save(file: string): void {
    const out: Record<string, [number, number, string]> = {};
    for (const [abs, s] of this.cache) out[abs] = [s.size, s.mtimeMs, s.hash];
    atomicWriteFile(file, JSON.stringify(out));
  }

  /** All theme files under root: relative POSIX path -> canonical hash. */
  scan(cfg: MaspConfig, root: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const rel of walkFiles(root, cfg.themeDirs, cfg.ignore)) {
      const h = this.hashOf(path.join(root, rel));
      if (h) out.set(rel, h);
    }
    return out;
  }
}
