import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestLocalSiteHandler } from './ingest-local-site.js';
import type { HandlerContext, ToolResult } from '../handler-types.js';

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

  it('summary and report include failedPages shape on happy path', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site2-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out2-'));
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="s1"><h1>Page One</h1></section></main></body>');
    writeFileSync(join(siteDir, 'about.html'), '<body><main><section id="s2"><h2>About</h2></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as { pages: number; failedPages: number; failedPagesList: unknown[] };
      expect(summary.pages).toBe(2);
      expect(summary.failedPages).toBe(0);
      expect(Array.isArray(summary.failedPagesList)).toBe(true);
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as { failedPages: unknown[] };
      expect(Array.isArray(report.failedPages)).toBe(true);
      expect(report.failedPages.length).toBe(0);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
