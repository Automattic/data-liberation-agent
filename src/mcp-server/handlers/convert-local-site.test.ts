// src/mcp-server/handlers/convert-local-site.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext, ToolResult } from '../handler-types.js';

// Mock BOTH exec seams before importing the handler:
// - node:child_process execFile → studio wp activation/option/meta commands
// - post-install installPost → page creation (it shells out internally)
// Per-test failure injection: a test sets execFailFor / installFailFor;
// beforeEach resets both so tests stay independent.

// Heavy design-capture + compare seams — mocked at the module level so the
// handler never invokes Playwright or the pixel-matcher in unit tests.
// capturedRuns tracks calls so tests can assert on source + replica invocations.
const capturedRuns: Array<{ urls: string[]; outputDir: string }> = [];
vi.mock('../../lib/screenshot/screenshotter.js', () => ({
  captureScreenshots: vi.fn(async (opts: { urls: string[]; outputDir: string }) => {
    capturedRuns.push({ urls: opts.urls, outputDir: opts.outputDir });
    // Fabricate aggregate files the handler reads after source capture.
    const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
    const { join: j } = await import('node:path');
    md(j(opts.outputDir, 'screenshots'), { recursive: true });
    wf(j(opts.outputDir, 'palette.json'), JSON.stringify({ version: 1, sampledUrls: 1, colors: [{ hex: '#0e2a30', count: 10, urls: 1 }, { hex: '#f7f2e9', count: 9, urls: 1 }, { hex: '#e2573b', count: 5, urls: 1 }] }));
    wf(j(opts.outputDir, 'typography.json'), JSON.stringify({ version: 1, sampledUrls: 1, bySelector: { body: [{ fontFamily: 'X', fontSize: '16px', fontWeight: '400', lineHeight: '24px', urls: 1 }] } }));
    wf(j(opts.outputDir, 'breakpoints.json'), JSON.stringify({ version: 1, sampledUrls: 1, minWidth: [], maxWidth: [] }));
    wf(j(opts.outputDir, 'screenshots', 'manifest.json'), JSON.stringify({ version: 1, entries: {} }));
    return { captured: opts.urls.length, failed: 0, skipped: 0, browserRestarts: 0, durationMs: 0, manifestPath: j(opts.outputDir, 'screenshots', 'manifest.json') };
  }),
}));
vi.mock('../../lib/screenshot/compare.js', () => ({
  compareScreenshotDirs: vi.fn(async () => ({
    version: 1,
    comparedAt: 'TEST',
    results: [
      { pathname: '/', originUrl: 'o', replicaUrl: 'r', desktop: { status: 'ok', score: 0.91 }, mobile: { status: 'ok', score: 0.88 } },
      { pathname: '/about/', originUrl: 'o', replicaUrl: 'r', desktop: { status: 'ok', score: 0.95 }, mobile: { status: 'ok', score: 0.9 } },
    ],
  })),
}));
vi.mock('../../lib/replicate/local-theme/google-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfHostGoogleFonts: vi.fn(async () => ({ faces: [], errors: [] })),
}));

const execCalls: string[][] = [];
let execFailFor: string | null = null;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      execCalls.push([cmd, ...args]);
      if (execFailFor && [cmd, ...args].join(' ').includes(execFailFor)) {
        cb(new Error(`synthetic exec failure: ${execFailFor}`), { stdout: '', stderr: '' });
        return;
      }
      cb(null, { stdout: '', stderr: '' });
    }),
  };
});
const installedPosts: Array<{ slug: string; sourceUrl: string }> = [];
let installFailFor: string | null = null;
vi.mock('../../lib/streaming/post-install.js', () => ({
  installPost: vi.fn(async ({ item }: { item: { slug: string; sourceUrl: string } }) => {
    if (installFailFor && item.slug === installFailFor) {
      throw new Error(`synthetic install failure: ${item.slug}`);
    }
    installedPosts.push({ slug: item.slug, sourceUrl: item.sourceUrl });
    return { sourceUrl: item.sourceUrl, postId: installedPosts.length, action: 'inserted' as const };
  }),
}));

import { convertLocalSiteHandler } from './convert-local-site.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

const ctx = {
  textResult: (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  errorResult: (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true }),
} as unknown as HandlerContext;

function makeSite(): string {
  mkdirSync(FIXTURE_TMP, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_TMP, 'cls-site-'));
  writeFileSync(
    join(dir, 'index.html'),
    // Footer anchor sits INSIDE the <p> — bare-<a> direct children hit emitChild's
    // catch-all downgrade (href dropped; known limitation, tracked separately) and
    // would mask the permalink-rewrite wiring this fixture exists to prove.
    '<html><head><title>Home</title></head><body><header><nav><a href="about.html">About</a></nav></header><main><section id="hero"><h1>Hi</h1></section></main><footer><p>foot <a href="about.html">About</a></p></footer></body></html>',
  );
  writeFileSync(
    join(dir, 'about.html'),
    '<html><head><title>About</title></head><body><main><section id="who"><h2>Who</h2><p>Us</p></section></main></body></html>',
  );
  return dir;
}

/** Like makeSite but WITHOUT index.html — no 'home' slug, so no front page. */
function makeSiteNoHome(): string {
  mkdirSync(FIXTURE_TMP, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_TMP, 'cls-nohome-'));
  writeFileSync(
    join(dir, 'about.html'),
    '<html><head><title>About</title></head><body><main><section id="who"><h2>Who</h2><p>Us</p></section></main></body></html>',
  );
  return dir;
}

function makeStudioSite(): string {
  const sitePath = mkdtempSync(join(FIXTURE_TMP, 'cls-studio-'));
  mkdirSync(join(sitePath, 'wp-content'), { recursive: true });
  return sitePath;
}

beforeEach(() => {
  execCalls.length = 0;
  installedPosts.length = 0;
  capturedRuns.length = 0;
  execFailFor = null;
  installFailFor = null;
});

describe('convertLocalSiteHandler', () => {
  it('runs the full pipeline: sidecars → theme files on disk → pages installed → front page set', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-out-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        pages: number; installed: number; themeSlug: string; frontPageSet: boolean; emptySidecars: string[];
        ingest: { lowConfidence: number; failedPageCount: number; failedPagesList: Array<{ slug: string; error: string }> };
      };
      expect(summary.pages).toBe(2);
      expect(summary.installed).toBe(2);
      expect(summary.themeSlug).toBe('acme-local');
      expect(summary.frontPageSet).toBe(true);
      expect(summary.emptySidecars).toEqual([]);
      // stage-1a quality signals forwarded into the summary
      expect(summary.ingest.lowConfidence).toBe(0);
      // theme written into the studio site
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'theme.json'))).toBe(true);
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'templates', 'page-local.html'))).toBe(true);
      // footer hrefs rewritten to WP permalinks (source-relative about.html 404s on WP)
      const footerHtml = readFileSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'parts', 'footer.html'), 'utf8');
      expect(footerHtml).toContain('href="/about/"');
      expect(footerHtml).not.toContain('about.html');
      // pages installed via installPost with synthetic source urls
      expect(installedPosts.map((p) => p.slug).sort()).toEqual(['about', 'home']);
      expect(installedPosts[0].sourceUrl.startsWith('local-site:')).toBe(true);
      // studio wp called for: theme activate, cache flush, blogname, front page options, template meta
      const flat = execCalls.map((c) => c.join(' '));
      expect(flat.some((c) => c.includes('theme activate acme-local'))).toBe(true);
      expect(flat.some((c) => c.includes('cache flush'))).toBe(true);
      // core/site-title in the header renders the blogname option — it must be
      // set to the ingested title or the site shows the Studio default name.
      expect(flat.some((c) => c.includes('option update blogname Acme'))).toBe(true);
      expect(flat.some((c) => c.includes('option update show_on_front page'))).toBe(true);
      expect(flat.some((c) => c.includes('option update page_on_front'))).toBe(true);
      expect(flat.some((c) => c.includes('_wp_page_template page-local'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('continues with a warning (not isError) when theme activate fails', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-out-'));
    execFailFor = 'theme activate';
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { installed: number; warnings: string[] };
      expect(summary.warnings.length).toBeGreaterThan(0);
      expect(summary.warnings.some((w) => w.includes('theme activate failed'))).toBe(true);
      expect(summary.installed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('isolates a per-page installPost failure into failedInstalls', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-out-'));
    installFailFor = 'about';
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        installed: number; failedInstalls: Array<{ slug: string; error: string }>;
      };
      expect(summary.installed).toBe(1);
      expect(summary.failedInstalls.map((f) => f.slug)).toEqual(['about']);
      expect(installedPosts.map((p) => p.slug)).toEqual(['home']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('skips front-page set when the site has no home page', async () => {
    const dir = makeSiteNoHome();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-out-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { installed: number; frontPageSet: boolean };
      expect(summary.installed).toBe(1);
      expect(summary.frontPageSet).toBe(false);
      const flat = execCalls.map((c) => c.join(' '));
      expect(flat.some((c) => c.includes('page_on_front'))).toBe(false);
      expect(flat.some((c) => c.includes('show_on_front'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('errors when studioSitePath has no wp-content', async () => {
    const dir = makeSite();
    const bogus = mkdtempSync(join(FIXTURE_TMP, 'cls-nowp-'));
    try {
      const res = await convertLocalSiteHandler({ dir, studioSitePath: bogus, outputDir: dir }, ctx);
      expect(res.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  it('errors when dir is missing', async () => {
    const res = await convertLocalSiteHandler({ studioSitePath: '/x' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('runs design capture + compare and reports parity', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-design-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: { avgDesktop: number; avgMobile: number; pages: unknown[] };
        designCaptured?: boolean;
      };
      expect(summary.designCaptured).toBe(true);
      expect(summary.parity?.avgDesktop).toBeCloseTo(0.93, 2);
      expect(summary.parity?.pages).toHaveLength(2);
      expect(capturedRuns).toHaveLength(2);                       // source + replica
      expect(capturedRuns[0].urls.some((u) => u.endsWith('/about/'))).toBe(true); // clean URLs
      expect(existsSync(join(outDir, 'parity-report.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('skipDesign skips capture/compare and uses the default foundation', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-skip-'));
    try {
      const before = capturedRuns.length;
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { designCaptured?: boolean; parity?: unknown };
      expect(summary.designCaptured).toBe(false);
      expect(summary.parity).toBeUndefined();
      expect(capturedRuns.length).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
