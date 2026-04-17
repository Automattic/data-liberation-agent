import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockTimeoutError } from './lockfile.js';

let tempDirs: string[] = [];

function mkTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'preview-lock-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

describe('acquireLock', () => {
  it('acquires a lock when the file does not exist', async () => {
    const dir = mkTempDir();
    const lockPath = join(dir, '.lock');
    const release = await acquireLock(lockPath, { timeoutMs: 500 });
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent acquisitions', async () => {
    const dir = mkTempDir();
    const lockPath = join(dir, '.lock');
    const release1 = await acquireLock(lockPath, { timeoutMs: 2000 });
    const start = Date.now();
    const p = acquireLock(lockPath, { timeoutMs: 2000, pollMs: 20 });
    setTimeout(() => release1(), 100);
    const release2 = await p;
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    release2();
  });

  it('throws LockTimeoutError when the lock is not released in time', async () => {
    const dir = mkTempDir();
    const lockPath = join(dir, '.lock');
    const release1 = await acquireLock(lockPath, { timeoutMs: 500 });
    await expect(acquireLock(lockPath, { timeoutMs: 200, pollMs: 20 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    release1();
  });
});
