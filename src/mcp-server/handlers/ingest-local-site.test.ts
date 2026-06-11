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
    // Forward ALL args — the wrapper must not drop the ComposePageOpts second
    // param (reveal tagging would silently vanish in these tests otherwise).
    composePage: (...cpArgs: Parameters<typeof actual.composePage>) => {
      if (cpArgs[0].slug === 'boom') throw new Error('synthetic compose failure');
      return actual.composePage(...cpArgs);
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
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as { entries: unknown[]; contractIssues: unknown[] };
      expect(report.entries.length).toBe(1);
      // Block-contract issues ride the report as a warning-level array
      // (empty on clean output) + a count in the summary.
      expect(report.contractIssues).toEqual([]);
      expect((JSON.parse(res.content[0].text) as { contractIssues: number }).contractIssues).toBe(0);
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

  it('nativeBehaviors: detects reveal from source assets and tags sidecar sections', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-nb-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-nb-'));
    writeFileSync(
      join(siteDir, 'index.html'),
      '<html><head><link rel="stylesheet" href="styles.css"></head><body><main><section id="hero"><h1>Hi</h1></section></main><script src="site.js"></script></body></html>',
    );
    writeFileSync(
      join(siteDir, 'styles.css'),
      'html.js section { opacity: 0; transform: translateY(18px); transition: opacity 600ms ease, transform 600ms ease; }',
    );
    writeFileSync(
      join(siteDir, 'site.js'),
      "const obs = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('is-visible')), { threshold: 0.12 });\n" +
        "document.querySelectorAll('section').forEach((s) => obs.observe(s));\n",
    );
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir, nativeBehaviors: true }, ctx);
      expect(res.isError).toBeFalsy();
      const sidecar = readFileSync(join(outDir, 'composed', 'home.blocks.html'), 'utf8');
      expect(sidecar).toContain('wp:dla/reveal');
      expect(sidecar).toContain('data-wp-interactive="dla/reveal"');
      expect(sidecar).not.toContain('wp:group');
      const report = JSON.parse(readFileSync(join(outDir, 'normalize-report.json'), 'utf8')) as {
        entries: Array<{ blockType: string }>;
      };
      expect(report.entries.every((e) => e.blockType === 'dla/reveal')).toBe(true);
      // Standalone observability: the summary surfaces what detection found
      // (no artifact write — behavior-gaps.json stays the convert stage's).
      const summary = JSON.parse(res.content[0].text) as { behaviors?: { reveal: boolean; gaps: number } };
      expect(summary.behaviors).toEqual({ reveal: true, tabs: 0, slider: 0, modal: 0, gaps: 0 });
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('nativeBehaviors: per-section detection tags tabs sidecars and counts ride the summary', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-nbtabs-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-nbtabs-'));
    writeFileSync(
      join(siteDir, 'index.html'),
      '<html><head><link rel="stylesheet" href="styles.css"></head><body><main>' +
        '<section id="hero"><h1>Hi</h1></section>' +
        '<section id="plans"><div role="tablist">' +
        '<button role="tab" aria-selected="true" aria-controls="p-a" class="tab is-active">A</button>' +
        '<button role="tab" aria-selected="false" aria-controls="p-b" class="tab">B</button></div>' +
        '<div role="tabpanel" id="p-a"><p>Alpha</p></div>' +
        '<div role="tabpanel" id="p-b" hidden><p>Beta</p></div></section>' +
        '</main><script src="site.js"></script></body></html>',
    );
    writeFileSync(
      join(siteDir, 'styles.css'),
      'html.js section { opacity: 0; transform: translateY(18px); transition: opacity 600ms ease, transform 600ms ease; }',
    );
    writeFileSync(
      join(siteDir, 'site.js'),
      "const obs = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('is-visible')), { threshold: 0.12 });\n" +
        "document.querySelectorAll('section').forEach((s) => obs.observe(s));\n" +
        "document.querySelectorAll('[role=\"tab\"]').forEach((t) => t.addEventListener('click', () => {\n" +
        "  t.classList.add('is-active');\n" +
        '}));\n',
    );
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir, nativeBehaviors: true }, ctx);
      expect(res.isError).toBeFalsy();
      const sidecar = readFileSync(join(outDir, 'composed', 'home.blocks.html'), 'utf8');
      expect(sidecar).toContain('data-wp-interactive="dla/tabs"'); // specific section
      expect(sidecar).toContain('data-wp-interactive="dla/reveal"'); // uniform fallback
      expect(sidecar).toContain('role="tab"'); // verbatim inner
      // Counts from the compose reports; the tabs driver js is CLAIMED once
      // its section fired, so it does not inflate gaps.
      const summary = JSON.parse(res.content[0].text) as { behaviors?: Record<string, unknown> };
      expect(summary.behaviors).toEqual({ reveal: true, tabs: 1, slider: 0, modal: 0, gaps: 0 });
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('nativeBehaviors with no catalog match leaves sections as group', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-nbnone-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-nbnone-'));
    // No reveal css gate, no observer js — detection finds nothing to map.
    writeFileSync(join(siteDir, 'index.html'), '<body><main><section id="hero"><h1>Hi</h1></section></main></body>');
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir, nativeBehaviors: true }, ctx);
      expect(res.isError).toBeFalsy();
      const sidecar = readFileSync(join(outDir, 'composed', 'home.blocks.html'), 'utf8');
      expect(sidecar).toContain('wp:group');
      expect(sidecar).not.toContain('dla/reveal');
      // No-match shape: key present (flag on), nothing found.
      const summary = JSON.parse(res.content[0].text) as { behaviors?: { reveal: boolean; gaps: number } };
      expect(summary.behaviors).toEqual({ reveal: false, tabs: 0, slider: 0, modal: 0, gaps: 0 });
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('default ingest (no flag) never tags (regression)', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-nboff-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-nboff-'));
    // Source HAS the reveal patterns, but the flag is off — no detection runs.
    writeFileSync(
      join(siteDir, 'index.html'),
      '<html><head><link rel="stylesheet" href="styles.css"></head><body><main><section id="hero"><h1>Hi</h1></section></main><script src="site.js"></script></body></html>',
    );
    writeFileSync(join(siteDir, 'styles.css'), 'html.js section { opacity: 0; }');
    writeFileSync(
      join(siteDir, 'site.js'),
      "const obs = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.add('is-visible')));\ndocument.querySelectorAll('section').forEach((s) => obs.observe(s));\n",
    );
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const sidecar = readFileSync(join(outDir, 'composed', 'home.blocks.html'), 'utf8');
      expect(sidecar).toContain('wp:group');
      expect(sidecar).not.toContain('dla/reveal');
      // Flag off → key absent (default summary byte-stable).
      const summary = JSON.parse(res.content[0].text) as { behaviors?: unknown };
      expect(summary.behaviors).toBeUndefined();
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('carry ingest (no flag): interactive scaffolding survives VERBATIM in a group wrapper', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const siteDir = mkdtempSync(join(FIXTURE_TMP, 'site-carrytabs-'));
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'out-carrytabs-'));
    // Tabs DOM pattern + its JS driver, flag OFF: the carry path must keep the
    // scaffolding byte-true (emitChild's catch-all destroyed it — carry E2E
    // unresolved missing tab/panel structural divergences) inside a plain
    // group wrapper with no plugin dependency.
    writeFileSync(
      join(siteDir, 'index.html'),
      '<html><head></head><body><main>' +
        '<section id="plans"><div role="tablist">' +
        '<button role="tab" aria-selected="true" aria-controls="p-a" class="tab is-active">A</button>' +
        '<button role="tab" aria-selected="false" aria-controls="p-b" class="tab">B</button></div>' +
        '<div role="tabpanel" id="p-a"><p>Alpha</p></div>' +
        '<div role="tabpanel" id="p-b" hidden><p>Beta</p></div></section>' +
        '</main><script src="site.js"></script></body></html>',
    );
    writeFileSync(
      join(siteDir, 'site.js'),
      'document.querySelectorAll(\'[role="tab"]\').forEach((t) => t.addEventListener(\'click\', () => {\n' +
        "  t.classList.add('is-active');\n" +
        '}));\n',
    );
    try {
      const res = await ingestLocalSiteHandler({ dir: siteDir, outputDir: outDir }, ctx);
      expect(res.isError).toBeFalsy();
      const sidecar = readFileSync(join(outDir, 'composed', 'home.blocks.html'), 'utf8');
      expect(sidecar).toContain('role="tab"');
      expect(sidecar).toContain('aria-controls="p-a"');
      expect(sidecar).toContain('wp:group');
      expect(sidecar).not.toContain('dla/');
      expect(sidecar).not.toContain('data-wp-interactive');
      // Summary stays flag-gated.
      const summary = JSON.parse(res.content[0].text) as { behaviors?: unknown };
      expect(summary.behaviors).toBeUndefined();
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
