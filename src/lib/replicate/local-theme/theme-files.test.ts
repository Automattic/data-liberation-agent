// src/lib/replicate/local-theme/theme-files.test.ts
import { describe, it, expect } from 'vitest';
import { assembleLocalTheme } from './theme-files.js';

const HEADER = '<!-- wp:site-title {"level":0} /-->';
const FOOTER = '<!-- wp:paragraph -->\n<p>foot</p>\n<!-- /wp:paragraph -->';

describe('assembleLocalTheme', () => {
  const files = assembleLocalTheme({ siteTitle: 'Acme Co', themeSlug: 'acme-local', headerPart: HEADER, footerPart: FOOTER });

  it('keeps the scaffold base files (style.css, theme.json, functions.php)', () => {
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('style.css');
    expect(paths).toContain('theme.json');
    expect(paths).toContain('functions.php');
  });

  it('replaces the chrome parts with the local ones', () => {
    expect(files.find((f) => f.relativePath === 'parts/header.html')?.content).toBe(HEADER);
    expect(files.find((f) => f.relativePath === 'parts/footer.html')?.content).toBe(FOOTER);
  });

  it('adds no-title page-local and front-page templates (post-content, no post-title)', () => {
    for (const t of ['templates/page-local.html', 'templates/front-page.html']) {
      const content = files.find((f) => f.relativePath === t)?.content ?? '';
      expect(content).toContain('wp:template-part {"slug":"header"');
      expect(content).toContain('<!-- wp:post-content');
      expect(content).not.toContain('wp:post-title');
      expect(content).toContain('wp:template-part {"slug":"footer"');
    }
  });

  it('registers page-local in theme.json customTemplates', () => {
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')?.content ?? '{}') as {
      customTemplates?: Array<{ name: string }>;
    };
    expect(themeJson.customTemplates?.some((t) => t.name === 'page-local')).toBe(true);
  });

  it('produces unique relativePaths (no duplicates from the swap)', () => {
    const paths = files.map((f) => f.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
