import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestLocalSiteHandler } from './ingest-local-site.js';
import type { HandlerContext, ToolResult } from '../handler-types.js';

// Per-page isolation: composePage has no externally-triggerable failure path
// via html input today (it only throws on roundtrip failure / compose misfit),
// so the failure leg is simulated — the mock throws for the sentinel slug
// "boom" and delegates to the real implementation for every other page.
vi.mock('../../lib/replicate/normalize/compose-page.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/replicate/normalize/compose-page.js')>();
  return {
    ...actual,
    composePage: (page: Parameters<typeof actual.composePage>[0]) => {
      if (page.slug === 'boom') throw new Error('synthetic compose failure');
      return actual.composePage(page);
    },
  };
});

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

const ctx = {
  textResult: (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  errorResult: (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true }),
} as unknown as HandlerContext;

describe('ingestLocalSiteHandler', () => {
  it('composes pages and writes artifacts', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="hero"><h1>Hi</h1></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { pages: number };
      expect(summary.pages).toBe(1);
      expect(existsSync(join(outDir, 'composed', 'home.blocks.html'))).toBe(true);
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as { entries: unknown[] };
      expect(report.entries.length).toBe(1);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('returns an error result for a dir with no html', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'empty-'));
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: siteDir }, ctx);
      expect(res.isError).toBe(true);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
    }
  });

  it('summary and report include failure/empty fields on happy path', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site2-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out2-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="s1"><h1>Page One</h1></section></main></body>');
    writeFileSync(join(siteDir, 'about.html'), '<body><main><section id="s2"><h2>About</h2></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        pages: number; failedPageCount: number; failedPagesList: unknown[]; emptyPages: unknown[];
      };
      expect(summary.pages).toBe(2);
      expect(summary.failedPageCount).toBe(0);
      expect(summary.failedPagesList).toEqual([]);
      expect(summary.emptyPages).toEqual([]);
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as {
        failedPages: unknown[]; emptyPages: unknown[];
      };
      expect(report.failedPages).toEqual([]);
      expect(report.emptyPages).toEqual([]);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('isolates a per-page compose failure: other pages still compose', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site3-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out3-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="ok"><h1>Fine</h1></section></main></body>');
    writeFileSync(join(siteDir, 'boom.html'), '<body><main><section id="x"><h1>Kaboom</h1></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        pages: number; failedPageCount: number; failedPagesList: Array<{ slug: string; error: string }>;
      };
      expect(summary.pages).toBe(2);
      expect(summary.failedPageCount).toBe(1);
      expect(summary.failedPagesList).toEqual([{ slug: 'boom', error: 'synthetic compose failure' }]);
      expect(existsSync(join(outDir, 'composed', 'home.blocks.html'))).toBe(true);
      expect(existsSync(join(outDir, 'composed', 'boom.blocks.html'))).toBe(false);
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as {
        failedPages: Array<{ slug: string; error: string }>;
      };
      expect(report.failedPages).toEqual([{ slug: 'boom', error: 'synthetic compose failure' }]);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('rejects an outputDir containing .. traversal', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site4-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="hero"><h1>Hi</h1></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: '../escape' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/traversal/);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
    }
  });

  it('reports pages that compose to nothing in emptyPages and still writes their sidecar', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site5-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out5-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="hero"><h1>Hi</h1></section></main></body>');
    writeFileSync(join(siteDir, 'bare.html'), '<body><header><p>chrome only</p></header><main></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { pages: number; emptyPages: string[] };
      expect(summary.pages).toBe(2);
      expect(summary.emptyPages).toEqual(['bare']);
      expect(existsSync(join(outDir, 'composed', 'bare.blocks.html'))).toBe(true);
      expect(readFileSync(join(outDir, 'composed', 'bare.blocks.html'), 'utf8')).toBe('');
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as { emptyPages: string[] };
      expect(report.emptyPages).toEqual(['bare']);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
