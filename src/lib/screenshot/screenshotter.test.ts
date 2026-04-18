import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Use a cwd-local tmp dir so validateOutputDir (which rejects paths outside
// cwd) accepts the test output directory.
const LOCAL_TMP = join(process.cwd(), '.tmp-test');
mkdirSync(LOCAL_TMP, { recursive: true });
const tmpdir = () => LOCAL_TMP;

// Mock the shared helper so tests don't require real Chromium.
vi.mock('../../adapters/shared.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    connectBrowser: vi.fn(),
    slugify: (url: string) => new URL(url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage',
  };
});

import { captureScreenshots } from './screenshotter.js';
import * as shared from '../../adapters/shared.js';

interface MockContext { newPage: () => Promise<unknown>; close: () => Promise<void> }
interface MockBrowser { newContext: (opts?: unknown) => Promise<MockContext>; close: () => Promise<void> }

function makeGoodPage(gotoStatus = 200) {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => gotoStatus }),
    content: vi.fn().mockResolvedValue('<html><body>hello</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fakepng')),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({
      palette: [], typography: {},
      metadata: { title: '', metaDescription: '', openGraph: {}, jsonLdTypes: [], htmlBytes: 0 },
    }),
  };
}

function makeMockBrowser(pageFactory = () => makeGoodPage()): MockBrowser {
  return {
    newContext: vi.fn().mockImplementation(() => Promise.resolve({
      newPage: vi.fn().mockResolvedValue(pageFactory()),
      close: vi.fn().mockResolvedValue(undefined),
    } as MockContext)),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('captureScreenshots', () => {
  it('captures two viewports and one HTML per URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser());
      const result = await captureScreenshots({
        urls: ['https://example.com/a', 'https://example.com/b'],
        outputDir: dir,
        concurrency: 2,
        settleMs: 0,
      });
      expect(result.captured).toBe(2);
      expect(result.failed).toBe(0);
      expect(existsSync(join(dir, 'screenshots', 'desktop', 'a.png'))).toBe(true);
      expect(existsSync(join(dir, 'screenshots', 'mobile', 'a.png'))).toBe(true);
      expect(existsSync(join(dir, 'screenshots', 'desktop', 'a.scrolled.png'))).toBe(true);
      expect(existsSync(join(dir, 'html', 'a.html'))).toBe(true);
      expect(existsSync(join(dir, 'screenshots', 'manifest.json'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(dir, 'screenshots', 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe(1);
      expect(Object.keys(manifest.entries)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips existing files when force=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser());
      await captureScreenshots({ urls: ['https://example.com/a'], outputDir: dir, concurrency: 1, settleMs: 0 });
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser());
      const result = await captureScreenshots({ urls: ['https://example.com/a'], outputDir: dir, concurrency: 1, settleMs: 0 });
      expect(result.captured).toBe(0);
      expect(result.skipped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects mixed-origin URL lists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      await expect(
        captureScreenshots({
          urls: ['https://a.com/x', 'https://b.com/y'],
          outputDir: dir,
        }),
      ).rejects.toThrow(/same-origin|violation/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects outputDir path traversal', async () => {
    await expect(
      captureScreenshots({
        urls: ['https://a.com/x'],
        outputDir: '/tmp/../etc/evil',
      }),
    ).rejects.toThrow(/traversal|outside/i);
  });

  it('restarts the browser every N URLs at batch boundaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      let connects = 0;
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        connects++;
        return makeMockBrowser();
      });
      const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}`);
      const result = await captureScreenshots({
        urls,
        outputDir: dir,
        concurrency: 2,
        browserRestartEvery: 3,
        settleMs: 0,
      });
      expect(result.captured).toBe(6);
      expect(result.browserRestarts).toBeGreaterThan(0);
      expect(connects).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a failure entry when goto returns 4xx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser(() => makeGoodPage(404)));
      const result = await captureScreenshots({
        urls: ['https://example.com/a'],
        outputDir: dir,
        concurrency: 1,
        settleMs: 0,
      });
      expect(result.failed).toBeGreaterThan(0);
      const failures = JSON.parse(readFileSync(join(dir, 'screenshots', 'failures.json'), 'utf8'));
      expect(failures.some((f: { stage: string }) => f.stage === 'goto')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
