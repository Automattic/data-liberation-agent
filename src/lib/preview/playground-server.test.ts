import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPidFile,
  writePidFile,
  deletePidFile,
  pidFilePath,
  isPidAlive,
  ensurePlaygroundDir,
  logFilePath,
} from './playground-server.js';

let tempDirs: string[] = [];
function mkDir() {
  const d = mkdtempSync(join(tmpdir(), 'pv-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  tempDirs = [];
});

describe('pid file helpers', () => {
  it('writes and reads a valid PID record (and creates the playground/ dir)', () => {
    const dir = mkDir();
    const rec = { pid: 42, port: 9400, startedAt: '2026-04-16T12:00:00Z' };
    writePidFile(dir, rec);
    expect(existsSync(pidFilePath(dir))).toBe(true);
    expect(readPidFile(dir)).toEqual(rec);
  });

  it('returns null for a missing PID file', () => {
    const dir = mkDir();
    expect(readPidFile(dir)).toBeNull();
  });

  it('returns null and deletes a corrupt PID file', () => {
    const dir = mkDir();
    mkdirSync(join(dir, 'playground'));
    writeFileSync(pidFilePath(dir), '{not json');
    expect(readPidFile(dir)).toBeNull();
    expect(existsSync(pidFilePath(dir))).toBe(false);
  });

  it('deletePidFile is a no-op when the file is gone', () => {
    const dir = mkDir();
    expect(() => deletePidFile(dir)).not.toThrow();
  });

  it('isPidAlive returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for a PID that does not exist', () => {
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });
});

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

function makeFakeChild(overrides: Partial<{ pid: number; exitAfterMs: number }> = {}) {
  const child: any = new EventEmitter();
  child.pid = overrides.pid ?? 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  if (overrides.exitAfterMs !== undefined) {
    setTimeout(() => child.emit('exit', 0, null), overrides.exitAfterMs);
  }
  return child;
}

describe('startPreview — happy path', () => {
  it('writes blueprint, spawns subprocess, writes PID, returns ready URL', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const fake = makeFakeChild();
    const spawnCalls: any[] = [];

    const result = await startPreview({
      outputDir: dir,
      _spawn: ((...args: any[]) => {
        spawnCalls.push(args);
        return fake as any;
      }) as any,
      _probeFn: async () => true,
      _noStudio: true,
    } as any);

    expect(result.status).toBe('ready');
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.pid).toBe(12345);
    expect(existsSync(pidFilePath(dir))).toBe(true);
    expect(existsSync(join(dir, 'playground', 'blueprint.json'))).toBe(true);
    expect(spawnCalls.length).toBe(1);
  });

  it('invokes onPhase callback during phases', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const fake = makeFakeChild();
    const phases: string[] = [];

    await startPreview({
      outputDir: dir,
      onPhase: (p: string) => phases.push(p),
      _spawn: (() => fake as any) as any,
      _probeFn: async () => true,
      _noStudio: true,
    } as any);

    expect(phases).toContain('spawn');
    expect(phases).toContain('probe');
  });

  it('fails gracefully when outputDir lacks output.wxr', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    const result = await startPreview({ outputDir: dir } as any);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/output\.wxr/);
  });
});

describe('startPreview — stale/alive PID handling', () => {
  it('deletes a stale PID file (dead process) and proceeds', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));
    ensurePlaygroundDir(dir);
    writePidFile(dir, {
      pid: 2_147_483_646,
      port: 9400,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const fake = makeFakeChild({ pid: 99999 });

    const result = await startPreview({
      outputDir: dir,
      _spawn: (() => fake as any) as any,
      _probeFn: async () => true,
      _noStudio: true,
    } as any);

    expect(result.status).toBe('ready');
    expect(result.pid).toBe(99999);
  });

  it('leaves a foreign PID alone (EPERM) and clears the stale PID file', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));
    ensurePlaygroundDir(dir);
    writePidFile(dir, {
      pid: process.pid,
      port: 9401,
      startedAt: new Date().toISOString(),
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig: string) => {
      // Simulate a foreign process we can't signal.
      if (sig === 'SIGTERM') {
        const err: NodeJS.ErrnoException = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return true;
    }) as any);
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeChild({ pid: 88888 });

    const result = await startPreview({
      outputDir: dir,
      _spawn: (() => fake as any) as any,
      _probeFn: async () => true,
      _noStudio: true,
    } as any);

    expect(result.status).toBe('ready');
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/EPERM/);
    killSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('kills an owned prior process (UUID matches) before restarting', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));
    ensurePlaygroundDir(dir);
    writePidFile(dir, {
      pid: process.pid,
      port: 9402,
      startedAt: new Date().toISOString(),
    });

    const killed: Array<[number, string]> = [];
    const killMock = vi
      .spyOn(process, 'kill')
      .mockImplementation(((pid: number, sig: string) => {
        if (sig === 'SIGTERM' || sig === 'SIGKILL') {
          killed.push([pid, sig]);
        }
        return true;
      }) as any);

    const fake = makeFakeChild({ pid: 77777 });

    let aliveCallCount = 0;
    await startPreview({
      outputDir: dir,
      _spawn: (() => fake as any) as any,
      _probeFn: async () => true,
      _noStudio: true,
      _isPidAlive: (pid: number) => {
        // First call (reconcile): alive. After SIGTERM: dead.
        if (pid === process.pid) {
          aliveCallCount++;
          return aliveCallCount === 1;
        }
        return false;
      },
    } as any);

    expect(killed.some((k) => k[1] === 'SIGTERM')).toBe(true);
    killMock.mockRestore();
  });

  it('warns and kills a >24h old PID file on start', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));
    ensurePlaygroundDir(dir);
    writePidFile(dir, {
      pid: process.pid,
      port: 9403,
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const killMock = vi.spyOn(process, 'kill').mockReturnValue(true as any);
    const fake = makeFakeChild({ pid: 66666 });

    let aliveCallCount = 0;
    await startPreview({
      outputDir: dir,
      _spawn: (() => fake as any) as any,
      _probeFn: async () => true,
      _noStudio: true,
      _isPidAlive: (pid: number) => {
        if (pid === process.pid) {
          aliveCallCount++;
          return aliveCallCount === 1;
        }
        return true;
      },
    } as any);

    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/stale/i);
    warnSpy.mockRestore();
    killMock.mockRestore();
  });
});

describe('stopPreview', () => {
  it('returns not-running when no PID file exists', async () => {
    const { stopPreview } = await import('./playground-server.js');
    const dir = mkDir();
    const r = await stopPreview({ outputDir: dir });
    expect(r.status).toBe('not-running');
  });

  it('returns not-running when PID file is already gone (race)', async () => {
    const { stopPreview } = await import('./playground-server.js');
    const dir = mkDir();
    ensurePlaygroundDir(dir);
    writePidFile(dir, { pid: 2_147_483_646, port: 9400, startedAt: new Date().toISOString() });
    deletePidFile(dir);
    const r = await stopPreview({ outputDir: dir });
    expect(r.status).toBe('not-running');
  });

  it('kills the recorded PID and deletes the PID file on success', async () => {
    const { stopPreview } = await import('./playground-server.js');
    const dir = mkDir();
    ensurePlaygroundDir(dir);
    writePidFile(dir, { pid: process.pid, port: 9400, startedAt: new Date().toISOString() });

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
    let aliveCalls = 0;
    const r = await stopPreview({
      outputDir: dir,
      _isPidAlive: () => (aliveCalls++ === 0 ? true : false),
    } as any);

    expect(r.status).toBe('stopped');
    expect(killSpy).toHaveBeenCalled();
    expect(existsSync(pidFilePath(dir))).toBe(false);
    killSpy.mockRestore();
  });
});

describe('warnings tail', () => {
  it('includes ERROR/WARN/Fatal lines from preview.log in the result', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const fake = makeFakeChild({ pid: 55555 });
    // Simulate Playground writing to preview.log during its run. startPreview
    // opens the log with 'w' (truncating) before calling spawnFn, so our spawn
    // stub writes afterward via append.
    const fakeSpawn = () => {
      writeFileSync(
        logFilePath(dir),
        [
          'info: starting',
          'ERROR: failed to import attachment 12',
          'WARN: slow XML parse',
          'info: done',
          'Fatal: stack overflow',
        ].join('\n'),
        { flag: 'a' },
      );
      return fake as any;
    };

    const r = await startPreview({
      outputDir: dir,
      _spawn: fakeSpawn as any,
      _probeFn: async () => true,
      _noStudio: true,
    } as any);

    expect(r.status).toBe('ready');
    expect(r.warnings).toEqual([
      'ERROR: failed to import attachment 12',
      'WARN: slow XML parse',
      'Fatal: stack overflow',
    ]);
  });
});

describe('startPreview — concurrency', () => {
  it('serializes N concurrent calls so only one subprocess survives', async () => {
    const { startPreview } = await import('./playground-server.js');
    const dir = mkDir();
    writeFileSync(join(dir, 'output.wxr'), '<rss></rss>');
    mkdirSync(join(dir, 'media'));

    const spawns: any[] = [];
    const fakeSpawn = ((..._args: any[]) => {
      const fake = makeFakeChild({ pid: 10_000 + spawns.length });
      spawns.push(fake);
      return fake;
    }) as any;

    const calls = Array.from({ length: 5 }, () =>
      startPreview({
        outputDir: dir,
        _spawn: fakeSpawn,
        _probeFn: async () => true,
        _noStudio: true,
      } as any),
    );
    const results = await Promise.all(calls);

    expect(results.every((r) => r.status === 'ready')).toBe(true);
    const pid = readPidFile(dir);
    expect(pid).not.toBeNull();
  });
});
