// src/lib/replicate/local-theme/source-assets.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectSourceAssets, WP_COMPAT_CSS } from './source-assets.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

function makeSite(): string {
  mkdirSync(FIXTURE_TMP, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_TMP, 'assets-'));
  writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="styles.css"><style>.inline-rule{color:red}</style></head><body><main><section><h1>x</h1></section></main><script src="site.js"></script></body></html>');
  writeFileSync(join(dir, 'styles.css'), `@import url('https://fonts.googleapis.com/css2?family=Fraunces&display=swap');\nbody{background:#f7f2e9}\n.hero h1{font-size:4rem}`);
  writeFileSync(join(dir, 'site.js'), "document.documentElement.classList.add('js');\nconsole.log('hi');");
  return dir;
}

describe('collectSourceAssets', () => {
  it('concatenates css (linked + inline) with google imports stripped and compat layer prepended', () => {
    const dir = makeSite();
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.css.startsWith(WP_COMPAT_CSS)).toBe(true);
      expect(assets.css).toContain('body{background:#f7f2e9}');
      expect(assets.css).toContain('.hero h1{font-size:4rem}');
      expect(assets.css).toContain('.inline-rule{color:red}');
      expect(assets.css).not.toContain('fonts.googleapis.com'); // self-hosted already
      expect(assets.cssFiles).toEqual(['styles.css']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concatenates js files in document order', () => {
    const dir = makeSite();
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.js).toContain("classList.add('js')");
      expect(assets.jsFiles).toEqual(['site.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty strings for a site with no css/js', () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const dir = mkdtempSync(join(FIXTURE_TMP, 'assets-empty-'));
    writeFileSync(join(dir, 'index.html'), '<html><body><main><p>x</p></main></body></html>');
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.css).toBe(WP_COMPAT_CSS); // compat layer always present
      expect(assets.js).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
