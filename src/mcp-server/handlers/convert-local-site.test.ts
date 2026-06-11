// src/mcp-server/handlers/convert-local-site.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { HandlerContext, ToolResult } from '../handler-types.js';

// Mock BOTH exec seams before importing the handler:
// - node:child_process execFile → studio wp activation/option/meta commands
// - post-install installPost → page creation (it shells out internally)
// Per-test failure injection: a test sets execFailFor / installFailFor;
// beforeEach resets both so tests stay independent.

// Heavy design-capture + compare seams — mocked at the module level so the
// handler never invokes Playwright or the pixel-matcher in unit tests.
// capturedRuns tracks calls so tests can assert on source + replica invocations.
// force is tracked so repair-loop tests can assert re-capture uses force:true.
const capturedRuns: Array<{ urls: string[]; outputDir: string; force?: boolean }> = [];

// Repair-loop fixture seam: set per-test; cleared in beforeEach.
// When repairReplicaManifestEntries is non-empty, the captureScreenshots mock
// writes a proper manifest (pathname→slug) + red-pixel diff PNGs for the replica
// capture, so the repair loop can read them without real Playwright/pixelmatch.
let repairReplicaManifestEntries: Record<string, { slug: string }> = {};
let repairDiffPng: Buffer | null = null;

vi.mock('../../lib/screenshot/screenshotter.js', () => ({
  captureScreenshots: vi.fn(async (opts: { urls: string[]; outputDir: string; force?: boolean }) => {
    capturedRuns.push({ urls: opts.urls, outputDir: opts.outputDir, force: opts.force });
    // Fabricate aggregate files the handler reads after source capture.
    const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
    const { join: j } = await import('node:path');
    md(j(opts.outputDir, 'screenshots'), { recursive: true });
    wf(j(opts.outputDir, 'palette.json'), JSON.stringify({ version: 1, sampledUrls: 1, colors: [{ hex: '#0e2a30', count: 10, urls: 1 }, { hex: '#f7f2e9', count: 9, urls: 1 }, { hex: '#e2573b', count: 5, urls: 1 }] }));
    wf(j(opts.outputDir, 'typography.json'), JSON.stringify({ version: 1, sampledUrls: 1, bySelector: { body: [{ fontFamily: 'X', fontSize: '16px', fontWeight: '400', lineHeight: '24px', urls: 1 }] } }));
    wf(j(opts.outputDir, 'breakpoints.json'), JSON.stringify({ version: 1, sampledUrls: 1, minWidth: [], maxWidth: [] }));
    // Replica captures: write a proper manifest + diff PNGs when the repair seam is active.
    const hasRepairEntries = Object.keys(repairReplicaManifestEntries).length > 0;
    if (hasRepairEntries && opts.outputDir.endsWith('/replica')) {
      wf(j(opts.outputDir, 'screenshots', 'manifest.json'), JSON.stringify({ version: 1, entries: repairReplicaManifestEntries }));
      if (repairDiffPng) {
        md(j(opts.outputDir, 'screenshots', 'diff'), { recursive: true });
        for (const entry of Object.values(repairReplicaManifestEntries)) {
          for (const vp of ['desktop', 'mobile']) {
            wf(j(opts.outputDir, 'screenshots', 'diff', `${entry.slug}.${vp}.diff.png`), repairDiffPng);
          }
        }
      }
    } else {
      wf(j(opts.outputDir, 'screenshots', 'manifest.json'), JSON.stringify({ version: 1, entries: {} }));
    }
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

// Repair-loop seam: mock probePair (heavy Playwright + CSS snapshot) while keeping
// FREEZE_MOTION_CSS real so the handler's freezeMotion helper stays functional.
vi.mock('../../lib/replicate/parity/parity-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/replicate/parity/parity-probe.js')>();
  return { ...actual, probePair: vi.fn(async () => []) };
});

// Repair-loop seam: stub chromium.launch so the loop never opens a real browser.
// probePair is mocked so the browser stub only needs close() in the finally block.
vi.mock('playwright', async (importOriginal) => {
  const actual = await importOriginal<typeof import('playwright')>();
  return {
    ...actual,
    chromium: { ...actual.chromium, launch: vi.fn(async () => ({ close: vi.fn(async () => {}) })) },
  };
});

const execCalls: string[][] = [];
let execFailFor: string | null = null;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      execCalls.push([cmd, ...args]);
      const joined = [cmd, ...args].join(' ');
      if (execFailFor && joined.includes(execFailFor)) {
        cb(new Error(`synthetic exec failure: ${execFailFor}`), { stdout: '', stderr: '' });
        return;
      }
      // Studio assigns random ports — the handler resolves the replica base URL
      // via `wp option get siteurl`; a distinctive port here lets tests assert
      // the RESOLVED url (not a hardcoded default) drives replica capture.
      cb(null, { stdout: joined.includes('option get siteurl') ? 'http://localhost:7777\n' : '', stderr: '' });
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

// Site-finalize seam (mirrors the installPost mock): the handler consolidates
// blogname + _wp_page_template assigns + the front-page pair into ONE
// finalizeSite eval-file call (Studio IPC flakes on bursts of argv commands).
// finalizeCalls captures payloads for assertions; finalizeResultOverride lets
// a test inject per-item errors or a whole-call rejection.
interface FinalizePayloadLike {
  options: Record<string, string>;
  templateAssigns: Array<{ postId: number; slug: string; template: string }>;
  frontPageId?: number;
}
interface FinalizeResultLike {
  ok: boolean;
  applied: { options: string[]; templates: number[]; frontPage: boolean };
  errors: Array<{ item: string; error: string }>;
}
const finalizeCalls: Array<{ payload: FinalizePayloadLike; studioSitePath: string }> = [];
let finalizeResultOverride: ((payload: FinalizePayloadLike) => Promise<FinalizeResultLike>) | null = null;
vi.mock('../../lib/streaming/site-finalize.js', () => ({
  finalizeSite: vi.fn(async ({ payload, studioSitePath }: { payload: FinalizePayloadLike; studioSitePath: string }) => {
    finalizeCalls.push({ payload, studioSitePath });
    if (finalizeResultOverride) return finalizeResultOverride(payload);
    // Default: everything in the payload applied successfully.
    return {
      ok: true,
      applied: {
        options: Object.keys(payload.options),
        templates: payload.templateAssigns.map((t) => t.postId),
        frontPage: payload.frontPageId !== undefined,
      },
      errors: [],
    };
  }),
}));

import { convertLocalSiteHandler } from './convert-local-site.js';
// Resolves to the vi.mock above — imported so tests can inject one-shot failures.
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
// Resolved vi.mocked instances for per-test once-value injection.
import { compareScreenshotDirs } from '../../lib/screenshot/compare.js';
import { probePair } from '../../lib/replicate/parity/parity-probe.js';

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
    // Stage 1d: includes <link> + <script> so collectSourceAssets has linked assets to carry.
    '<html><head><title>Home</title><link rel="stylesheet" href="styles.css"></head><body><header><nav><a href="about.html">About</a></nav></header><main><section id="hero"><h1>Hi</h1></section></main><footer><p>foot <a href="about.html">About</a></p></footer><script src="site.js"></script></body></html>',
  );
  writeFileSync(
    join(dir, 'about.html'),
    '<html><head><title>About</title></head><body><main><section id="who"><h2>Who</h2><p>Us</p></section></main></body></html>',
  );
  // Stage 1d carry: linked CSS + JS the collector picks up from the index.html document order.
  writeFileSync(join(dir, 'styles.css'), 'body { background: #f7f2e9; }\n.hero h1 { font-size: 4rem; }');
  writeFileSync(join(dir, 'site.js'), "document.documentElement.classList.add('js');");
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

// Base compareScreenshotDirs result — re-established each test so once-values
// from repair tests don't leak (repair tests chain mockResolvedValueOnce on top).
const BASE_COMPARE_RESULT = {
  version: 1,
  comparedAt: 'TEST',
  results: [
    { pathname: '/', originUrl: 'o', replicaUrl: 'r', desktop: { status: 'ok', score: 0.91 }, mobile: { status: 'ok', score: 0.88 } },
    { pathname: '/about/', originUrl: 'o', replicaUrl: 'r', desktop: { status: 'ok', score: 0.95 }, mobile: { status: 'ok', score: 0.9 } },
  ],
};

beforeEach(() => {
  execCalls.length = 0;
  installedPosts.length = 0;
  capturedRuns.length = 0;
  finalizeCalls.length = 0;
  execFailFor = null;
  installFailFor = null;
  finalizeResultOverride = null;
  // Repair seam: reset per-test; repair tests set these before calling handler.
  repairReplicaManifestEntries = {};
  repairDiffPng = null;
  // Reset + re-establish base for compare and probePair so unconsumed once-values
  // from a failing repair test can't bleed into subsequent tests.
  vi.mocked(compareScreenshotDirs).mockReset().mockResolvedValue(BASE_COMPARE_RESULT as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>);
  vi.mocked(probePair).mockReset().mockResolvedValue([]);
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
      // studio wp argv calls remain ONLY for activate + cache flush (constant-arg
      // commands); blogname/template/front-page ride the finalize eval-file call.
      const flat = execCalls.map((c) => c.join(' '));
      expect(flat.some((c) => c.includes('theme activate acme-local'))).toBe(true);
      expect(flat.some((c) => c.includes('cache flush'))).toBe(true);
      expect(flat.some((c) => c.includes('option update blogname'))).toBe(false);
      expect(flat.some((c) => c.includes('_wp_page_template'))).toBe(false);
      expect(flat.some((c) => c.includes('show_on_front'))).toBe(false);
      expect(flat.some((c) => c.includes('page_on_front'))).toBe(false);
      // ONE consolidated finalize call carries blogname + template assigns +
      // front page (core/site-title renders blogname — wrong value = wrong brand).
      expect(finalizeCalls).toHaveLength(1);
      const { payload } = finalizeCalls[0];
      expect(payload.options).toEqual({ blogname: 'Acme' });
      const assigns = [...payload.templateAssigns].sort((a, b) => a.slug.localeCompare(b.slug));
      expect(assigns.map((a) => ({ slug: a.slug, template: a.template }))).toEqual([
        { slug: 'about', template: 'page-local' },
        { slug: 'home', template: 'page-local' },
      ]);
      // frontPageId is the HOME page's postId.
      const homeAssign = payload.templateAssigns.find((a) => a.slug === 'home');
      expect(payload.frontPageId).toBe(homeAssign?.postId);
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
      // No home page → the finalize payload carries NO frontPageId (and the
      // mock's applied.frontPage=false flows into frontPageSet above).
      expect(finalizeCalls).toHaveLength(1);
      expect(finalizeCalls[0].payload.frontPageId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('maps per-item finalize errors to the per-command warning prefixes', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-finerr-'));
    // Per-item granularity: blogname + the about template fail, front page
    // succeeds — frontPageSet must still come from applied.frontPage.
    finalizeResultOverride = async (payload) => ({
      ok: false,
      applied: {
        options: [],
        templates: payload.templateAssigns.filter((t) => t.slug !== 'about').map((t) => t.postId),
        frontPage: true,
      },
      errors: [
        { item: 'option:blogname', error: 'option verify failed after update_option' },
        { item: 'template:about', error: 'meta verify failed after update_post_meta' },
      ],
    });
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { frontPageSet: boolean; warnings: string[] };
      // Same prefixes the old per-command path emitted (log greps keep working).
      expect(summary.warnings).toContain('blogname set failed: option verify failed after update_option');
      expect(summary.warnings).toContain('template assign failed for about: meta verify failed after update_post_meta');
      expect(summary.frontPageSet).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('degrades a whole-call finalize failure to one warning and frontPageSet=false', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-finfail-'));
    // Transport-level failure (IPC timeout / garbage stdout) → finalizeSite rejects.
    finalizeResultOverride = async () => {
      throw new Error('Timeout waiting for response to message wp-cli-command: No activity for 120s');
    };
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { frontPageSet: boolean; warnings: string[]; installed: number };
      expect(summary.frontPageSet).toBe(false);
      expect(summary.installed).toBe(2); // pages still installed — finalize failure never aborts
      const finalizeWarnings = summary.warnings.filter((w) => w.startsWith('site finalize failed'));
      expect(finalizeWarnings).toHaveLength(1);
      // The single warning lists everything that was attempted.
      expect(finalizeWarnings[0]).toContain('option blogname');
      expect(finalizeWarnings[0]).toContain('template home');
      expect(finalizeWarnings[0]).toContain('template about');
      expect(finalizeWarnings[0]).toContain('front page');
      expect(finalizeWarnings[0]).toContain('No activity for 120s');
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

  it('carries source css/js into the installed theme by default', async () => {
    const dir = makeSite(); // includes styles.css + site.js
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-carry-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', skipDesign: true },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { carried: { css: boolean; js: boolean } };
      expect(summary.carried).toEqual({ css: true, js: true });
      const themeDir = join(sitePath, 'wp-content', 'themes', 'acme-local');
      expect(existsSync(join(themeDir, 'assets', 'css', 'source.css'))).toBe(true);
      expect(existsSync(join(themeDir, 'assets', 'js', 'source.js'))).toBe(true);
      // carry mode strips theme.json styles — source CSS is the design authority
      const themeJson = JSON.parse(readFileSync(join(themeDir, 'theme.json'), 'utf8')) as { styles?: unknown };
      expect(themeJson.styles).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('carryCss false skips the carry (tokens-only theme)', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-nocarry-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', skipDesign: true, carryCss: false },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { carried: { css: boolean; js: boolean } };
      expect(summary.carried.css).toBe(false);
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'assets', 'css', 'source.css'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('runs design capture + compare and reports parity', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-design-'));
    try {
      const res = await convertLocalSiteHandler(
        // repair:false: keeps capturedRuns at 2 (source+replica); this test does
        // not exercise the repair loop — see the dedicated repair-loop tests below.
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', repair: false },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: {
          floor: number;
          allPass: boolean;
          avgDesktop: number;
          avgMobile: number;
          pages: Array<{ pathname: string; desktop: number | null; mobile: number | null; passes: boolean }>;
        };
        designCaptured?: boolean;
      };
      expect(summary.designCaptured).toBe(true);
      expect(summary.parity?.avgDesktop).toBeCloseTo(0.93, 2);
      expect(summary.parity?.pages).toHaveLength(2);
      expect(capturedRuns).toHaveLength(2);                       // source + replica
      expect(capturedRuns[0].urls.some((u) => u.endsWith('/about/'))).toBe(true); // clean URLs
      // replica capture targets the studio-resolved siteurl (mock returns :7777),
      // NOT a hardcoded default port — wrong port = capture of the wrong site.
      expect(capturedRuns[1].urls.length).toBeGreaterThan(0);
      expect(capturedRuns[1].urls.every((u) => u.startsWith('http://localhost:7777'))).toBe(true);
      // foundation → assemble → install end-to-end: the mock aggregates' accent
      // color lands in the INSTALLED theme.json palette.
      const themeJson = JSON.parse(
        readFileSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'theme.json'), 'utf8'),
      ) as { settings?: { color?: { palette?: Array<{ slug: string; color: string }> } } };
      expect((themeJson.settings?.color?.palette ?? []).some((p) => p.color === '#e2573b')).toBe(true);
      expect(existsSync(join(outDir, 'parity-report.json'))).toBe(true);
      // Parity floor verdict (stage 1d): mock scores 0.91/0.88/0.95/0.9 are all below
      // the 0.99 floor — every page reports passes:false and allPass is false.
      expect(summary.parity?.floor).toBe(0.99);
      expect(summary.parity?.allPass).toBe(false);
      expect(summary.parity?.pages.every((p) => typeof p.passes === 'boolean')).toBe(true);
      expect(summary.parity?.pages.every((p) => p.passes === false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('degrades to a warning (not isError) when design capture fails', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-capfail-'));
    vi.mocked(captureScreenshots).mockRejectedValueOnce(new Error('boom'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        designCaptured?: boolean; parity?: unknown; warnings: string[]; installed: number;
      };
      expect(summary.designCaptured).toBe(false);
      expect(summary.warnings.some((w) => w.includes('design capture failed'))).toBe(true);
      expect(summary.parity).toBeUndefined();
      // theme still written (default foundation) and pages still installed
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'theme.json'))).toBe(true);
      expect(summary.installed).toBe(2);
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

  // ---------------------------------------------------------------------------
  // Repair loop tests (Task 4)
  // ---------------------------------------------------------------------------

  /** Tiny red-pixel diff PNG: 10×100, row 20 fully red — gives 1 DiffRegion. */
  function makeRedDiffPng(): Buffer {
    const png = new PNG({ width: 10, height: 100 });
    png.data.fill(255); // white, alpha 255
    for (let x = 0; x < 10; x++) {
      const i = (20 * 10 + x) * 4;
      png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  const FAIL_COMPARE = {
    version: 1 as const, comparedAt: 'TEST',
    results: [{ pathname: '/', originUrl: 'o', replicaUrl: 'http://localhost:7777/', desktop: { status: 'ok', score: 0.85 }, mobile: { status: 'ok', score: 0.8 } }],
  };
  const PASS_COMPARE = {
    version: 1 as const, comparedAt: 'TEST',
    results: [{ pathname: '/', originUrl: 'o', replicaUrl: 'http://localhost:7777/', desktop: { status: 'ok', score: 1.0 }, mobile: { status: 'ok', score: 1.0 } }],
  };
  const MARGIN_DIV = {
    match: 'section.hero[0]', viewport: 'desktop' as const, kind: 'prop' as const,
    prop: 'marginBottom', source: '88px', replica: '0px', replicaOnlyClasses: ['wp-block-group'],
  };

  it('repair loop patches, re-compares, and converges', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-repair-'));
    try {
      // Arm the replica fixture seam: the captureScreenshots mock writes a proper
      // manifest (pathname→slug) + red-pixel diff PNGs for both viewports.
      repairReplicaManifestEntries = { 'http://localhost:7777/': { slug: 'home' } };
      repairDiffPng = makeRedDiffPng();
      // round 0: failing compare → triggers repair; round 1: passing → converged.
      vi.mocked(compareScreenshotDirs)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>)
        .mockResolvedValueOnce(PASS_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>);
      // probePair: desktop → 1 marginBottom divergence; mobile falls back to [] (base).
      vi.mocked(probePair).mockResolvedValueOnce([MARGIN_DIV]);

      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: {
          repair?: { rounds: number; overrides: number; unresolved: unknown[]; converged: boolean };
          allPass: boolean;
        };
        warnings: string[];
      };
      // Repair completed in 1 round with 1 override (marginBottom) and converged.
      expect(summary.parity?.repair?.rounds).toBe(1);
      expect(summary.parity?.repair?.overrides).toBe(1);
      expect(summary.parity?.repair?.converged).toBe(true);
      expect(summary.parity?.repair?.unresolved).toHaveLength(0);
      expect(summary.parity?.allPass).toBe(true);
      // parity-patch.css written into the live theme with the source-measured value.
      const themePatchPath = join(sitePath, 'wp-content', 'themes', 'acme-local', 'assets', 'css', 'parity-patch.css');
      expect(existsSync(themePatchPath)).toBe(true);
      expect(readFileSync(themePatchPath, 'utf8')).toContain('margin-bottom: 88px');
      // parity-patch.css also copied to outputDir (atomic rename convention).
      const outPatchPath = join(outDir, 'parity-patch.css');
      expect(existsSync(outPatchPath)).toBe(true);
      expect(readFileSync(outPatchPath, 'utf8')).toContain('margin-bottom: 88px');
      // captureScreenshots: source (0) + replica round-0 (1) + repair re-capture (2).
      expect(capturedRuns).toHaveLength(3);
      // Re-capture must use force:true so pngs regenerate over the stale round-0 files.
      expect(capturedRuns[2].force).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('repair loop stops on unchanged fingerprint and reports unresolved (stuck)', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-stuck-'));
    try {
      repairReplicaManifestEntries = { 'http://localhost:7777/': { slug: 'home' } };
      repairDiffPng = makeRedDiffPng();
      // Compare always failing — repair loop never reaches allPass.
      vi.mocked(compareScreenshotDirs)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>);
      // probePair always returns the same divergence — fingerprint is stable →
      // loop detects it has stopped making progress and breaks.
      vi.mocked(probePair)
        .mockResolvedValueOnce([MARGIN_DIV])   // round 0 desktop
        .mockResolvedValueOnce([])             // round 0 mobile
        .mockResolvedValueOnce([MARGIN_DIV])   // round 1 desktop (fingerprint check)
        .mockResolvedValueOnce([]);            // round 1 mobile

      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: { repair?: { rounds: number; converged: boolean; unresolved: unknown[] }; allPass: boolean };
        warnings: string[];
      };
      // Loop ran 1 complete round (wrote patch + re-compared), then detected the
      // same fingerprint on round 2's probe and broke before writing a second patch.
      expect(summary.parity?.repair?.rounds).toBe(1);
      expect(summary.parity?.repair?.converged).toBe(false);
      expect(summary.parity?.allPass).toBe(false);
      // captureScreenshots: source + replica + 1 repair re-capture (no 2nd one — broke
      // before the re-capture on round 2).
      expect(capturedRuns).toHaveLength(3);
      // No infinite loop: exactly 4 probePair calls across 2 probe rounds.
      expect(vi.mocked(probePair).mock.calls).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('repair loop retains earlier-round overrides in the patch (union across rounds)', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-union-'));
    try {
      repairReplicaManifestEntries = { 'http://localhost:7777/': { slug: 'home' } };
      repairDiffPng = makeRedDiffPng();
      // 3 compares: round-0 initial FAIL → after round-0 patch FAIL → after round-1 patch PASS.
      vi.mocked(compareScreenshotDirs)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>)
        .mockResolvedValueOnce(PASS_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>);
      // Round 0 yields overrides A (margin-bottom) + B (font-size); round 1 yields
      // C (different selector|prop key). Different divergence sets → different
      // fingerprints, so the loop continues rather than breaking as stuck.
      const DIV_B = {
        match: 'p.lede[0]', viewport: 'desktop' as const, kind: 'prop' as const,
        prop: 'fontSize', source: '17px', replica: '14px', replicaOnlyClasses: [],
      };
      const DIV_C = {
        match: 'div.cards[0]', viewport: 'desktop' as const, kind: 'prop' as const,
        prop: 'paddingTop', source: '24px', replica: '0px', replicaOnlyClasses: ['wp-block-columns'],
      };
      vi.mocked(probePair)
        .mockResolvedValueOnce([MARGIN_DIV, DIV_B])  // round 0 desktop → A + B
        .mockResolvedValueOnce([])                   // round 0 mobile
        .mockResolvedValueOnce([DIV_C]);             // round 1 desktop → C (mobile falls to base [])

      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', maxRepairRounds: 2 },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: {
          repair?: { rounds: number; overrides: number; converged: boolean };
          allPass: boolean; avgDesktop: number; avgMobile: number;
        };
      };
      expect(summary.parity?.repair?.rounds).toBe(2);
      expect(summary.parity?.repair?.overrides).toBe(3);
      expect(summary.parity?.repair?.converged).toBe(true);
      // The round-2 patch (final write into the live theme) must contain the UNION:
      // A and B retained from round 1, C added — not replaced by C alone.
      const patch = readFileSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'assets', 'css', 'parity-patch.css'), 'utf8');
      expect(patch).toContain('margin-bottom: 88px');  // A retained
      expect(patch).toContain('font-size: 17px');      // B retained
      expect(patch).toContain('padding-top: 24px');    // C added
      // Averages reflect the FINAL round's compare (PASS_COMPARE = 1.0), not round 0.
      expect(summary.parity?.avgDesktop).toBe(1.0);
      expect(summary.parity?.avgMobile).toBe(1.0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('repair loop keeps per-viewport source values distinct in the union (no value collapse)', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-vpvalues-'));
    try {
      repairReplicaManifestEntries = { 'http://localhost:7777/': { slug: 'home' } };
      repairDiffPng = makeRedDiffPng();
      vi.mocked(compareScreenshotDirs)
        .mockResolvedValueOnce(FAIL_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>)
        .mockResolvedValueOnce(PASS_COMPARE as unknown as Awaited<ReturnType<typeof compareScreenshotDirs>>);
      // SAME selector|occurrence|prop diverging to DIFFERENT source values per
      // viewport (responsive hero type scale). classify keys on the source value
      // too, yielding TWO overrides; the cross-round union must NOT collapse them
      // into one bare rule that forces the desktop value onto mobile.
      const FONT_DESK = {
        match: 'section.hero[0]', viewport: 'desktop' as const, kind: 'prop' as const,
        prop: 'fontSize', source: '64px', replica: '40px', replicaOnlyClasses: [],
      };
      const FONT_MOB = {
        match: 'section.hero[0]', viewport: 'mobile' as const, kind: 'prop' as const,
        prop: 'fontSize', source: '32px', replica: '40px', replicaOnlyClasses: [],
      };
      vi.mocked(probePair)
        .mockResolvedValueOnce([FONT_DESK])  // round 0 desktop
        .mockResolvedValueOnce([FONT_MOB]);  // round 0 mobile

      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: { repair?: { rounds: number; overrides: number; converged: boolean } };
      };
      expect(summary.parity?.repair?.overrides).toBe(2);
      expect(summary.parity?.repair?.converged).toBe(true);
      const patch = readFileSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'assets', 'css', 'parity-patch.css'), 'utf8');
      // Each viewport keeps ITS source value inside its media block…
      expect(patch).toContain('@media (min-width: 768px) {\n  section.hero { font-size: 64px; }\n}');
      expect(patch).toContain('@media (max-width: 767px) {\n  section.hero { font-size: 32px; }\n}');
      // …and no bare (viewport-unscoped) rule leaks the desktop value to mobile.
      expect(patch).not.toMatch(/^section\.hero/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('repair:false skips the loop entirely', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-norepair-'));
    try {
      // compare returns failing scores (base mock) but repair is off.
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', repair: false },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: { repair?: unknown; allPass: boolean };
        warnings: string[];
      };
      // Repair field is absent — loop was never entered.
      expect(summary.parity?.repair).toBeUndefined();
      expect(summary.parity?.allPass).toBe(false); // base compare has scores < 0.99
      // probePair must never be called when repair:false.
      expect(vi.mocked(probePair).mock.calls).toHaveLength(0);
      // captureScreenshots: source + replica only (no re-capture).
      expect(capturedRuns).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('repair skips with a warning when source css is not carried (patch would never load)', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-skipcarry-'));
    try {
      // Failing compare (base mock) + repair default ON, but carryCss:false means
      // functions.php never enqueues parity-patch.css — looping would burn every
      // round with zero on-page effect, so the handler must skip with a warning.
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme', carryCss: false },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        parity?: { repair?: unknown };
        warnings: string[];
      };
      expect(summary.warnings).toContain('repair skipped: requires carried source css (carryCss)');
      expect(summary.parity?.repair).toBeUndefined();
      // The loop never ran: no probes, no re-capture.
      expect(vi.mocked(probePair).mock.calls).toHaveLength(0);
      expect(capturedRuns).toHaveLength(2); // source + replica only
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sitePath, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
