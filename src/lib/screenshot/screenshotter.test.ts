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

interface MockContext { newPage: () => Promise<unknown>; addInitScript: (script: unknown) => Promise<void>; close: () => Promise<void> }
interface MockBrowser { newContext: (opts?: unknown) => Promise<MockContext>; close: () => Promise<void> }

function makeGoodPage(gotoStatus = 200) {
  let currentUrl = '';
  return {
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      return { status: () => gotoStatus };
    }),
    content: vi.fn().mockResolvedValue('<html><body>hello</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fakepng')),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async (fn: unknown) => {
      const s = String(fn);
      // extractFull's section-spec closure — return an empty raw-section array so
      // the desktop pass writes sections/<slug>.json (no real DOM in the mock).
      // Checked FIRST: this closure also references `scrollHeight`, so it would be
      // mis-caught by the scroll branch below. Match a code identifier (comments
      // are stripped by the transpiler).
      if (s.includes('motionAnimatedElements')) return { rows: [], landmarks: [] };
      if (s.includes('scrollHeight')) return 3000;
      if (s.includes('scrollTo')) return undefined;
      const isHomepage = new URL(currentUrl).pathname === '/';
      return {
        palette: [{ hex: isHomepage ? '#111111' : '#222222', count: 10 }],
        typography: {},
        metadata: { title: '', metaDescription: '', openGraph: {}, jsonLdTypes: [], htmlBytes: 0 },
        breakpoints: { minWidth: [], maxWidth: [] },
      };
    }),
  };
}

function makeMockBrowser(pageFactory = () => makeGoodPage()): MockBrowser {
  return {
    newContext: vi.fn().mockImplementation(() => Promise.resolve({
      newPage: vi.fn().mockResolvedValue(pageFactory()),
      addInitScript: vi.fn().mockResolvedValue(undefined),
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

  it('writes palette.json, typography.json, and breakpoints.json from one representative URL', async () => {
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
      expect(existsSync(join(dir, 'palette.json'))).toBe(true);
      expect(existsSync(join(dir, 'typography.json'))).toBe(true);
      expect(existsSync(join(dir, 'breakpoints.json'))).toBe(true);
      const palette = JSON.parse(readFileSync(join(dir, 'palette.json'), 'utf8'));
      const typo = JSON.parse(readFileSync(join(dir, 'typography.json'), 'utf8'));
      const bp = JSON.parse(readFileSync(join(dir, 'breakpoints.json'), 'utf8'));
      expect(palette.version).toBe(1);
      expect(palette.sampledUrls).toBe(1);
      expect(typo.version).toBe(1);
      expect(typo.sampledUrls).toBe(1);
      expect(bp.version).toBe(1);
      expect(bp.sampledUrls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the homepage as the single representative analysis URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser());
      await captureScreenshots({
        urls: ['https://example.com/about', 'https://example.com'],
        outputDir: dir,
        concurrency: 2,
        settleMs: 0,
      });
      const palette = JSON.parse(readFileSync(join(dir, 'palette.json'), 'utf8'));
      expect(palette.sampledUrls).toBe(1);
      expect(palette.colors.map((c: { hex: string }) => c.hex)).toEqual(['#111111']);
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

  it('skips scrolled capture on pages too short for the scroll offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'));
    try {
      // Mock: scrollHeight is 500 (less than desktop viewport 900 * 1.5 = 1350, plus 900 for the clip)
      const shortPage = () => {
        const p = makeGoodPage();
        p.evaluate = vi.fn().mockImplementation(async (fn: unknown) => {
          const s = String(fn);
          if (s.includes('scrollHeight')) return 500;
          // site-analysis evaluate
          return { palette: [], typography: {}, metadata: { title: '', metaDescription: '', openGraph: {}, jsonLdTypes: [], htmlBytes: 0 }, breakpoints: { minWidth: [], maxWidth: [] } };
        });
        return p;
      };
      (shared.connectBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockBrowser(shortPage));
      const result = await captureScreenshots({
        urls: ['https://example.com/short'],
        outputDir: dir,
        concurrency: 1,
        settleMs: 0,
      });
      // Capture should succeed overall — fullpage captured, scrolled skipped silently.
      expect(result.captured).toBe(1);
      expect(result.failed).toBe(0);
      expect(existsSync(join(dir, 'screenshots', 'desktop', 'short.png'))).toBe(true);
      // Scrolled file should NOT exist
      expect(existsSync(join(dir, 'screenshots', 'desktop', 'short.scrolled.png'))).toBe(false);
      // Manifest entry should have desktop but not desktopScrolled
      const manifest = JSON.parse(readFileSync(join(dir, 'screenshots', 'manifest.json'), 'utf8'));
      expect(manifest.entries['https://example.com/short'].desktop).toBeDefined();
      expect(manifest.entries['https://example.com/short'].desktopScrolled).toBeUndefined();
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
