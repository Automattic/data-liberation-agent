import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export class LockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Another preview action in progress (lock: ${lockPath})`);
    this.name = 'LockTimeoutError';
  }
}

type LockOpts = {
  timeoutMs?: number;
  pollMs?: number;
  /** Defaults to `process.kill(pid, 0)`. Overridable for tests. */
  isPidAlive?: (pid: number) => boolean;
};

interface LockRecord {
  pid: number;
  startedAt: string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but is foreign; treat as alive so we don't steal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort detection of a stale (crashed-holder) lock. Reads the PID +
 * timestamp from the lock file; considers it stale if the PID is not alive.
 * If the file is unreadable/unparseable we conservatively treat the lock as
 * alive — unlinking something we can't understand is riskier than waiting.
 */
function isLockStale(lockPath: string, isPidAlive: (pid: number) => boolean): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const rec = JSON.parse(raw) as LockRecord;
    if (typeof rec.pid !== 'number') return false;
    return !isPidAlive(rec.pid);
  } catch {
    return false;
  }
}

export async function acquireLock(
  lockPath: string,
  opts: LockOpts = {},
): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 100;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      const record: LockRecord = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(fd, JSON.stringify(record));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
        process.off('exit', release);
        process.off('SIGINT', release);
        process.off('SIGTERM', release);
      };
      process.once('exit', release);
      process.once('SIGINT', release);
      process.once('SIGTERM', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Steal the lock if the holder process is gone (crashed, killed, etc).
      // Otherwise wait and re-check — the current holder may finish before
      // the deadline.
      if (isLockStale(lockPath, isPidAlive)) {
        try { unlinkSync(lockPath); } catch { /* raced with real holder */ }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
