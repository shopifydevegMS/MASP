// Single-writer lock. Created with O_EXCL so two controller processes cannot both hold it.
// A lock whose process is gone is treated as stale and taken over (after a crash).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { nowIso } from "./util.ts";

export interface LockInfo {
  pid: number;
  host: string;
  nonce: string;
  command: string;
  startedAt: string;
}

export class LockHeldError extends Error {
  info: LockInfo;
  constructor(info: LockInfo) {
    super(`another MASP writer is running (pid ${info.pid}, '${info.command}', since ${info.startedAt})`);
    this.info = info;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/** Returns the holder if the lock is held by a live process, else null. */
export function lockHolder(lockPath: string): LockInfo | null {
  const info = readLock(lockPath);
  if (!info) return null;
  if (info.host === os.hostname() && !pidAlive(info.pid)) return null;
  return info;
}

export class Lock {
  path: string;
  info: LockInfo;
  staleTakenOver: LockInfo | null = null;
  private constructor(p: string, info: LockInfo) {
    this.path = p;
    this.info = info;
  }

  static acquire(lockPath: string, command: string): Lock {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const info: LockInfo = {
      pid: process.pid, host: os.hostname(), nonce: crypto.randomBytes(8).toString("hex"), command, startedAt: nowIso(),
    };
    let stale: LockInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeSync(fd, JSON.stringify(info));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        const lock = new Lock(lockPath, info);
        lock.staleTakenOver = stale;
        return lock;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = readLock(lockPath);
      if (holder && (holder.host !== os.hostname() || pidAlive(holder.pid))) throw new LockHeldError(holder);
      // Stale (or unreadable, half-written) lock: move it aside. Only one process wins the rename.
      try {
        fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${process.pid}`);
        stale = holder;
      } catch { /* someone else moved it; retry */ }
    }
    throw new Error("could not acquire MASP lock");
  }

  release(): void {
    const cur = readLock(this.path);
    if (cur && cur.nonce === this.info.nonce) fs.unlinkSync(this.path);
  }
}
