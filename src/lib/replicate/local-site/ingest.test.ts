import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ingestLocalSite } from './ingest.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

function makeSite(files: Record<string, string>): string {
  mkdirSync(FIXTURE_TMP, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_TMP, 'ingest-'));
  for (const [rel, html] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, html);
  }
  return dir;
}

describe('ingestLocalSite', () => {
  it('enumerates html pages, derives slugs, extracts titles', () => {
    const dir = makeSite({
      'index.html': '<html><head><title>Home</title></head><body><main><h1>Hi</h1></main></body></html>',
      'about.html': '<html><head><title>About Us</title></head><body><main><h1>About</h1></main></body></html>',
    });
    try {
      const site = ingestLocalSite(dir);
      const slugs = site.pages.map((p) => p.slug).sort();
      expect(slugs).toEqual(['about', 'home']);
      const home = site.pages.find((p) => p.slug === 'home');
      expect(home?.title).toBe('Home');
      expect(home?.relPath).toBe('index.html');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a directory with no html', () => {
    const dir = makeSite({ 'styles.css': 'body{}' });
    try {
      expect(() => ingestLocalSite(dir)).toThrow(/no html pages/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
