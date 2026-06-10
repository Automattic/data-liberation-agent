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
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const dir = mkdtempSync(join(FIXTURE_TMP, 'assets-jsorder-'));
    // zeta.js linked BEFORE alpha.js — document order must beat alphabetical.
    writeFileSync(join(dir, 'index.html'), '<html><body><p>x</p><script src="zeta.js"></script><script src="alpha.js"></script></body></html>');
    writeFileSync(join(dir, 'zeta.js'), "document.documentElement.classList.add('js');");
    writeFileSync(join(dir, 'alpha.js'), "console.log('second');");
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.jsFiles).toEqual(['zeta.js', 'alpha.js']);
      expect(assets.js).toContain("classList.add('js')");
      expect(assets.js.indexOf("classList.add('js')")).toBeLessThan(assets.js.indexOf("console.log('second')"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves linked css document order over alphabetical (cascade winner)', () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const dir = mkdtempSync(join(FIXTURE_TMP, 'assets-cssorder-'));
    // theme.css linked BEFORE overrides.css — alphabetical reads would invert
    // the cascade and make theme.css the winner.
    writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="overrides.css"></head><body><p>x</p></body></html>');
    writeFileSync(join(dir, 'theme.css'), 'body{color:blue}');
    writeFileSync(join(dir, 'overrides.css'), 'body{color:red}');
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.cssFiles).toEqual(['theme.css', 'overrides.css']);
      expect(assets.css.indexOf('color:blue')).toBeLessThan(assets.css.indexOf('color:red')); // exact tokens: compat comments legitimately contain prose like 'rendered'
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers linked assets in subdirectories', () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const dir = mkdtempSync(join(FIXTURE_TMP, 'assets-subdir-'));
    mkdirSync(join(dir, 'css'), { recursive: true });
    mkdirSync(join(dir, 'js'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="css/site.css"></head><body><p>x</p><script src="js/app.js"></script></body></html>');
    writeFileSync(join(dir, 'css', 'site.css'), '.hero{color:teal}');
    writeFileSync(join(dir, 'js', 'app.js'), "console.log('app');");
    try {
      const assets = collectSourceAssets(dir, [{ relPath: 'index.html', html: '' }]);
      expect(assets.cssFiles).toEqual(['css/site.css']);
      expect(assets.jsFiles).toEqual(['js/app.js']);
      expect(assets.css).toContain('.hero{color:teal}');
      expect(assets.js).toContain("console.log('app')");
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
