import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installMediaForUrl } from './media-install.js';
import { MediaStubStore } from '../extraction/media-stubs.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');
mkdirSync(FIXTURE_TMP, { recursive: true });

interface SetupOpts {
  /** Stubs to seed; key is sourceUrl, value defines status + localPath relative to outputDir/media. */
  stubs: Array<{ url: string; filename: string; bytes?: Buffer; alreadyInstalled?: number; status?: 'success' | 'error' | 'awaiting' }>;
}

function setup(opts: SetupOpts) {
  const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-'));
  const wpRoot = join(outputDir, 'site', 'wordpress');
  mkdirSync(wpRoot, { recursive: true });
  mkdirSync(join(outputDir, 'media'), { recursive: true });

  const store = MediaStubStore.load(outputDir);
  for (const s of opts.stubs) {
    const status = s.status ?? 'success';
    const filePath = join(outputDir, 'media', s.filename);
    if (status === 'success') {
      writeFileSync(filePath, s.bytes ?? Buffer.from('fake'));
      store.markSuccess(s.url, filePath);
      if (s.alreadyInstalled !== undefined) {
        store.recordWpPostId(s.url, s.alreadyInstalled);
      }
    } else if (status === 'error') {
      store.markFailure(s.url, 'test-error');
    }
    // 'awaiting' is the default-no-mutation state
  }
  store.flush();
  return { outputDir, wpRoot };
}

const SUCCESS_RESPONSE = (entries: Array<{ sourceUrl: string; filename: string; postId: number; localUrl: string; reused?: boolean }>) =>
  `Some other PHP output...\nDLA_INSTALL_MEDIA_JSON_BEGIN\n${JSON.stringify({
    results: entries.map((e) => ({ ...e, reused: e.reused ?? false })),
    errors: [],
  })}\nDLA_INSTALL_MEDIA_JSON_END\nMore noise after\n`;

describe('installMediaForUrl', () => {
  it('copies media into wpRoot uploads, runs PHP, and records wpPostId', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          { sourceUrl: 'https://cdn/a.jpg', filename: 'a.jpg', postId: 42, localUrl: 'http://wp/uploads/2024/01/a.jpg' },
        ]),
        stderr: '',
      });

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(result.errors).toEqual([]);
      expect(result.installed).toHaveLength(1);
      expect(result.installed[0]).toMatchObject({ sourceUrl: 'https://cdn/a.jpg', postId: 42 });

      // File was copied into the wpRoot under the year/month derived from mtime.
      // The exact year/month varies with the run, but we know the file should
      // exist under wp-content/uploads somewhere.
      const uploadsDir = join(wpRoot, 'wp-content', 'uploads');
      expect(existsSync(uploadsDir)).toBe(true);

      // Stub store now records the post ID.
      const store = MediaStubStore.load(outputDir);
      expect(store.get('https://cdn/a.jpg')?.wpPostId).toBe(42);

      // The PHP script + payload were staged to the parent of wpRoot (the site path).
      const sitePath = join(outputDir, 'site');
      expect(existsSync(join(sitePath, '.dla-scripts', 'install-media.php'))).toBe(true);

      // exec was called with studio + wp + eval-file + script + payload.
      expect(exec).toHaveBeenCalledTimes(1);
      const [bin, args] = exec.mock.calls[0];
      expect(bin).toBe('studio');
      expect(args).toContain('wp');
      expect(args).toContain('eval-file');
      expect(args).toContain('--path');
      expect(args[args.indexOf('--path') + 1]).toBe(sitePath);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('uses wpRoot itself as the Studio site path for flat Studio installs', async () => {
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-flat-studio-'));
    const wpRoot = join(outputDir, 'flat-site');
    mkdirSync(join(wpRoot, 'wp-content'), { recursive: true });
    mkdirSync(join(outputDir, 'media'), { recursive: true });

    const filePath = join(outputDir, 'media', 'a.jpg');
    writeFileSync(filePath, Buffer.from('fake'));
    const store = MediaStubStore.load(outputDir);
    store.markSuccess('https://cdn/a.jpg', filePath);
    store.flush();

    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          { sourceUrl: 'https://cdn/a.jpg', filename: 'a.jpg', postId: 42, localUrl: 'http://wp/uploads/2024/01/a.jpg' },
        ]),
        stderr: '',
      });

      await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      const [, args] = exec.mock.calls[0];
      expect(args[args.indexOf('--path') + 1]).toBe(wpRoot);
      expect(existsSync(join(wpRoot, '.dla-scripts', 'install-media.php'))).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('skips entries already installed without persisted localUrl (legacy stub)', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg', alreadyInstalled: 99 }],
    });
    try {
      const exec = vi.fn();

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      // Nothing pending → no exec call.
      expect(exec).not.toHaveBeenCalled();
      expect(result.installed).toHaveLength(0);
      expect(result.skipped.some((s) => s.reason === 'already-installed')).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('returns already-installed stubs in result.installed when localUrl is persisted', async () => {
    // Regression for the streaming-mode bug where mediaUrlMap stayed empty
    // on resume runs: with localUrl persisted to MediaStub, idempotent
    // re-calls surface the mapping so flushPendingImports can rebuild
    // its rewrite map without re-running the PHP installer.
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-resume-'));
    const wpRoot = join(outputDir, 'site', 'wordpress');
    mkdirSync(wpRoot, { recursive: true });
    mkdirSync(join(outputDir, 'media'), { recursive: true });
    const filePath = join(outputDir, 'media', 'a.jpg');
    writeFileSync(filePath, Buffer.from('fake'));

    const store = MediaStubStore.load(outputDir);
    store.markSuccess('https://cdn/a.jpg', filePath);
    store.recordWpPostId('https://cdn/a.jpg', 42);
    store.recordLocalUrl('https://cdn/a.jpg', 'http://localhost:8882/wp-content/uploads/2024/01/a.jpg');
    store.flush();

    try {
      const exec = vi.fn();
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(exec).not.toHaveBeenCalled();
      expect(result.skipped).toHaveLength(0);
      expect(result.installed).toEqual([
        {
          sourceUrl: 'https://cdn/a.jpg',
          postId: 42,
          localUrl: 'http://localhost:8882/wp-content/uploads/2024/01/a.jpg',
          localPath: filePath,
        },
      ]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('persists localUrl to the stub on fresh install (so resume runs can rebuild the map)', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/b.jpg', filename: 'b.jpg' }],
    });
    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          { sourceUrl: 'https://cdn/b.jpg', filename: 'b.jpg', postId: 7, localUrl: 'http://localhost:8882/wp-content/uploads/2024/01/b.jpg' },
        ]),
        stderr: '',
      });

      await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      const store = MediaStubStore.load(outputDir);
      expect(store.get('https://cdn/b.jpg')?.localUrl).toBe('http://localhost:8882/wp-content/uploads/2024/01/b.jpg');
      expect(store.get('https://cdn/b.jpg')?.wpPostId).toBe(7);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('skips stubs whose local file is missing', async () => {
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'mi-missing-'));
    const wpRoot = join(outputDir, 'site', 'wordpress');
    mkdirSync(wpRoot, { recursive: true });
    mkdirSync(join(outputDir, 'media'), { recursive: true });

    // Stub recorded as success but the file isn't actually on disk.
    const store = MediaStubStore.load(outputDir);
    store.markSuccess('https://cdn/ghost.jpg', join(outputDir, 'media', 'ghost.jpg'));
    store.flush();

    try {
      const exec = vi.fn();
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });
      expect(exec).not.toHaveBeenCalled();
      expect(result.skipped).toEqual([{ sourceUrl: 'https://cdn/ghost.jpg', reason: 'no-local-file' }]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('returns errors when the studio exec fails', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      const exec = vi.fn().mockRejectedValue(new Error('studio not found'));

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(result.installed).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/studio not found/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('includes stderr/stdout details when the studio exec fails', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      const err = Object.assign(new Error('Command failed: studio wp eval-file'), {
        stderr: 'Fatal error: database is locked',
        stdout: 'wp-cli bootstrap output',
      });
      const exec = vi.fn().mockRejectedValue(err);

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Fatal error: database is locked');
      expect(result.errors[0].error).toContain('wp-cli bootstrap output');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('returns errors when the PHP response has no parseable JSON', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: 'unrelated wp-cli output without sentinels', stderr: '' });

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toMatch(/no parseable JSON/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reads the response from the sidecar result file (bypasses Studio 64KB stdout cap)', async () => {
    // The script writes its full JSON to `<payload>.result.json` and emits only
    // a tiny `{resultFile}` pointer to stdout. Simulate that: the mock locates
    // the staged payload, writes the sidecar, and returns the pointer block.
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/big.jpg', filename: 'big.jpg' }],
    });
    try {
      const sitePath = join(outputDir, 'site');
      const payloadsDir = join(sitePath, '.dla-scripts', 'payloads');
      const exec = vi.fn().mockImplementation(async () => {
        // Find the payload the real code just staged.
        const { readdirSync } = await import('node:fs');
        const payloadFile = readdirSync(payloadsDir).find((f) => f.endsWith('.json') && !f.endsWith('.result.json'));
        const payloadHostPath = join(payloadsDir, payloadFile!);
        const fullResponse = JSON.stringify({
          results: [{ sourceUrl: 'https://cdn/big.jpg', filename: 'big.jpg', postId: 99, reused: false, localUrl: 'http://wp/uploads/2026/05/big.jpg' }],
          errors: [],
        });
        writeFileSync(`${payloadHostPath}.result.json`, fullResponse);
        // stdout carries ONLY the small pointer between the sentinels.
        return {
          stdout: `noise\nDLA_INSTALL_MEDIA_JSON_BEGIN\n${JSON.stringify({ resultFile: `/wordpress/.dla-scripts/payloads/${payloadFile}.result.json` })}\nDLA_INSTALL_MEDIA_JSON_END\nmore noise\n`,
          stderr: '',
        };
      });

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });

      expect(result.errors).toEqual([]);
      expect(result.installed).toHaveLength(1);
      expect(result.installed[0]).toMatchObject({ sourceUrl: 'https://cdn/big.jpg', postId: 99 });
      const store = MediaStubStore.load(outputDir);
      expect(store.get('https://cdn/big.jpg')?.wpPostId).toBe(99);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('returns errors when the sidecar result file is missing/unreadable', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      // Pointer references a sidecar that was never written.
      const exec = vi.fn().mockResolvedValue({
        stdout: `DLA_INSTALL_MEDIA_JSON_BEGIN\n${JSON.stringify({ resultFile: '/wordpress/.dla-scripts/payloads/nonexistent.json.result.json' })}\nDLA_INSTALL_MEDIA_JSON_END\n`,
        stderr: '',
      });
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toMatch(/no parseable JSON/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('registers attachments through wp-playground-cli run-blueprint when Studio is unavailable', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [{ url: 'https://cdn/a.jpg', filename: 'a.jpg' }],
    });
    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: SUCCESS_RESPONSE([
          { sourceUrl: 'https://cdn/a.jpg', filename: 'a.jpg', postId: 55, localUrl: 'http://127.0.0.1:9400/wp-content/uploads/2026/04/a.jpg' },
        ]),
        stderr: '',
      });
      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: false,
        playgroundSiteUrl: 'http://127.0.0.1:9400',
        _execFile: exec,
      });
      expect(result.errors).toEqual([]);
      expect(result.installed[0]).toMatchObject({
        sourceUrl: 'https://cdn/a.jpg',
        postId: 55,
        localUrl: 'http://127.0.0.1:9400/wp-content/uploads/2026/04/a.jpg',
      });

      const [bin, args] = exec.mock.calls[0];
      expect(bin).toBe('npx');
      expect(args).toContain('wp-playground-cli');
      expect(args).toContain('run-blueprint');
      expect(args).toContain('--site-url=http://127.0.0.1:9400');
      expect(args.some((arg: string) => arg.startsWith('--mount-before-install=') && arg.endsWith(':/wordpress/wp-content'))).toBe(true);

      const store = MediaStubStore.load(outputDir);
      expect(store.get('https://cdn/a.jpg')?.wpPostId).toBe(55);
      expect(store.get('https://cdn/a.jpg')?.localUrl).toBe('http://127.0.0.1:9400/wp-content/uploads/2026/04/a.jpg');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reports per-stub errors that came back from PHP', async () => {
    const { outputDir, wpRoot } = setup({
      stubs: [
        { url: 'https://cdn/a.jpg', filename: 'a.jpg' },
        { url: 'https://cdn/b.jpg', filename: 'b.jpg' },
      ],
    });
    try {
      const exec = vi.fn().mockResolvedValue({
        stdout: 'noise\nDLA_INSTALL_MEDIA_JSON_BEGIN\n' + JSON.stringify({
          results: [{ sourceUrl: 'https://cdn/a.jpg', filename: 'a.jpg', postId: 1, reused: false, localUrl: 'http://l/a.jpg' }],
          errors: [{ sourceUrl: 'https://cdn/b.jpg', filename: 'b.jpg', error: 'wp_insert_attachment returned 0' }],
        }) + '\nDLA_INSTALL_MEDIA_JSON_END\n',
        stderr: '',
      });

      const result = await installMediaForUrl({
        outputDir,
        url: 'https://example.com/page',
        wpRoot,
        useStudioCli: true,
        _execFile: exec,
      });
      expect(result.installed).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].sourceUrl).toBe('https://cdn/b.jpg');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
