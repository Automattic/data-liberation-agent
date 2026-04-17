import { closeSync, openSync, unlinkSync } from 'node:fs';

export class LockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Another preview action in progress (lock: ${lockPath})`);
    this.name = 'LockTimeoutError';
  }
}

type LockOpts = { timeoutMs?: number; pollMs?: number };

export async function acquireLock(
  lockPath: string,
  opts: LockOpts = {},
): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
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
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
