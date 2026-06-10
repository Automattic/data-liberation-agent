// src/mcp-server/handlers/convert-local-site.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext, ToolResult } from '../handler-types.js';

// Mock BOTH exec seams before importing the handler:
// - node:child_process execFile → studio wp activation/option/meta commands
// - post-install installPost → page creation (it shells out internally)
const execCalls: string[][] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      execCalls.push([cmd, ...args]);
      cb(null, { stdout: '', stderr: '' });
    }),
  };
});
const installedPosts: Array<{ slug: string; sourceUrl: string }> = [];
vi.mock('../../lib/streaming/post-install.js', () => ({
  installPost: vi.fn(async ({ item }: { item: { slug: string; sourceUrl: string } }) => {
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
    '<html><head><title>Home</title></head><body><header><nav><a href="about.html">About</a></nav></header><main><section id="hero"><h1>Hi</h1></section></main><footer><p>foot</p></footer></body></html>',
  );
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
});

describe('convertLocalSiteHandler', () => {
  it('runs the full pipeline: sidecars → theme files on disk → pages installed → front page set', async () => {
    const dir = makeSite();
    const sitePath = makeStudioSite();
    const outDir = mkdtempSync(join(FIXTURE_TMP, 'cls-out-'));
    try {
      const res = await convertLocalSiteHandler(
        { dir, studioSitePath: sitePath, outputDir: outDir, themeSlug: 'acme-local', siteTitle: 'Acme' },
        ctx,
      );
      expect(res.isError).toBeFalsy();
      const summary = JSON.parse(res.content[0].text) as {
        pages: number; installed: number; themeSlug: string; frontPageSet: boolean; emptySidecars: string[];
      };
      expect(summary.pages).toBe(2);
      expect(summary.installed).toBe(2);
      expect(summary.themeSlug).toBe('acme-local');
      expect(summary.emptySidecars).toEqual([]);
      // theme written into the studio site
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'theme.json'))).toBe(true);
      expect(existsSync(join(sitePath, 'wp-content', 'themes', 'acme-local', 'templates', 'page-local.html'))).toBe(true);
      // pages installed via installPost with synthetic source urls
      expect(installedPosts.map((p) => p.slug).sort()).toEqual(['about', 'home']);
      expect(installedPosts[0].sourceUrl.startsWith('local-site:')).toBe(true);
      // studio wp called for: theme activate, front page options, template meta
      const flat = execCalls.map((c) => c.join(' '));
      expect(flat.some((c) => c.includes('theme activate acme-local'))).toBe(true);
      expect(flat.some((c) => c.includes('option update show_on_front page'))).toBe(true);
      expect(flat.some((c) => c.includes('option update page_on_front'))).toBe(true);
      expect(flat.some((c) => c.includes('_wp_page_template page-local'))).toBe(true);
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
});
