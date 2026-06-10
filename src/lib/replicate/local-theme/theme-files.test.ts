// src/lib/replicate/local-theme/theme-files.test.ts
import { describe, it, expect } from 'vitest';
import { assembleLocalTheme } from './theme-files.js';
import { lintThemeJson } from '../theme-json-lint.js';

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

  it('registers page-local in theme.json customTemplates and stays lint-clean', () => {
    const tj = files.find((f) => f.relativePath === 'theme.json');
    const themeJson = JSON.parse(tj?.content ?? '{}') as {
      customTemplates?: Array<{ name: string }>;
    };
    expect(themeJson.customTemplates?.some((t) => t.name === 'page-local')).toBe(true);
    // Lint lock: the customTemplates rewrite must not break the activation-gate
    // invariants (version 3, $schema, spacingScale traps).
    expect(lintThemeJson(JSON.parse(tj?.content ?? '{}')).ok).toBe(true);
  });

  it('produces unique relativePaths (no duplicates from the swap)', () => {
    const paths = files.map((f) => f.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('front-page.html is byte-identical to page-local.html (single no-title shape)', () => {
    expect(files.find((f) => f.relativePath === 'templates/front-page.html')?.content).toBe(
      files.find((f) => f.relativePath === 'templates/page-local.html')?.content,
    );
  });

  it('passes a provided foundation + fonts to the scaffold', () => {
    const files = assembleLocalTheme({
      siteTitle: 'Acme Co',
      themeSlug: 'acme-local',
      headerPart: HEADER,
      footerPart: FOOTER,
      foundation: {
        color: {
          surface: { base: { value: '#f7f2e9' }, inverse: { value: '#0e2a30' } },
          text: { default: { value: '#0e2a30' }, inverse: { value: '#f7f2e9' } },
          accent: { primary: { value: '#e2573b' } },
        },
        typography: { families: { body: { value: '"Work Sans", sans-serif' }, display: { value: 'Fraunces, serif' } } },
        components: { button: { background: '#e2573b', text: '#f7f2e9', radius: '999px' } },
      },
      capturedFonts: [
        { family: 'Fraunces', src: 'https://x/f.woff2', format: 'woff2', weight: '900', style: 'normal', localPath: 'assets/fonts/Fraunces-900.woff2' },
      ],
    });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')?.content ?? '{}') as {
      settings?: { color?: { palette?: Array<{ slug: string; color: string }> }; typography?: { fontFamilies?: Array<{ slug: string }> } };
      styles?: { blocks?: Record<string, unknown> };
    };
    const palette = themeJson.settings?.color?.palette ?? [];
    expect(palette.find((p) => p.slug === 'accent-primary')?.color).toBe('#e2573b');
    expect(palette.find((p) => p.slug === 'surface-base')?.color).toBe('#f7f2e9');
    const styleCss = files.find((f) => f.relativePath === 'style.css')?.content ?? '';
    expect(styleCss).toContain('@font-face');
    expect(styleCss).toContain('Fraunces-900.woff2');
  });

  it('still defaults to the minimal foundation when none provided', () => {
    const files = assembleLocalTheme({ siteTitle: 'Acme Co', themeSlug: 'acme-local', headerPart: HEADER, footerPart: FOOTER });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')?.content ?? '{}') as {
      settings?: { color?: { palette?: Array<{ slug: string; color: string }> } };
    };
    // Default-foundation accent must flow through — locks the fallback path live.
    expect(themeJson.settings?.color?.palette?.find((p) => p.slug === 'accent-primary')?.color).toBe('#0066cc');
  });

  it('carry mode adds source assets, strips theme.json styles, and enqueues last', () => {
    const carryFiles = assembleLocalTheme({
      siteTitle: 'Acme Co',
      themeSlug: 'acme-local',
      headerPart: HEADER,
      footerPart: FOOTER,
      carrySourceAssets: { css: '/* compat */ body{background:#fff}', js: "console.log('x')" },
    });
    const paths = carryFiles.map((f) => f.relativePath);
    expect(paths).toContain('assets/css/source.css');
    expect(paths).toContain('assets/js/source.js');
    expect(carryFiles.find((f) => f.relativePath === 'assets/css/source.css')?.content).toContain('background:#fff');
    const themeJson = JSON.parse(carryFiles.find((f) => f.relativePath === 'theme.json')?.content ?? '{}') as {
      styles?: unknown;
      settings?: unknown;
    };
    expect(themeJson.styles).toBeUndefined(); // interference stripped
    expect(themeJson.settings).toBeDefined(); // editor UX kept
    // Lint lock: stripped theme.json must still pass activation-gate invariants.
    expect(lintThemeJson(JSON.parse(carryFiles.find((f) => f.relativePath === 'theme.json')?.content ?? '{}')).ok).toBe(true);
    const fns = carryFiles.find((f) => f.relativePath === 'functions.php')?.content ?? '';
    expect(fns).toContain('assets/css/source.css');
    expect(fns).toContain('assets/js/source.js');
    expect(fns).toContain("documentElement.classList.add('js')"); // html.js gate snippet
    // Carry enqueue must appear AFTER the theme style (priority 20, dependency on theme handle).
    expect(fns.indexOf('source.css')).toBeGreaterThan(fns.indexOf('get_stylesheet_uri'));
    // Dependency array must reference the correct theme style handle.
    expect(fns).toContain("array( 'acme-local-style' )");
  });

  it('without carry mode, no source assets and styles kept (existing behavior)', () => {
    const noCarryFiles = assembleLocalTheme({
      siteTitle: 'Acme Co',
      themeSlug: 'acme-local',
      headerPart: HEADER,
      footerPart: FOOTER,
    });
    expect(noCarryFiles.some((f) => f.relativePath === 'assets/css/source.css')).toBe(false);
    const themeJson = JSON.parse(
      noCarryFiles.find((f) => f.relativePath === 'theme.json')?.content ?? '{}',
    ) as { styles?: unknown };
    expect(themeJson.styles).toBeDefined();
  });

  it('js-only carry: adds source.js, does not add source.css, does not strip theme.json styles', () => {
    // css: '' → css is empty → skip css file, keep theme.json styles intact
    const jsOnlyFiles = assembleLocalTheme({
      siteTitle: 'Acme Co',
      themeSlug: 'acme-local',
      headerPart: HEADER,
      footerPart: FOOTER,
      carrySourceAssets: { css: '', js: "console.log('x')" },
    });
    expect(jsOnlyFiles.some((f) => f.relativePath === 'assets/css/source.css')).toBe(false);
    expect(jsOnlyFiles.some((f) => f.relativePath === 'assets/js/source.js')).toBe(true);
    const themeJson = JSON.parse(
      jsOnlyFiles.find((f) => f.relativePath === 'theme.json')?.content ?? '{}',
    ) as { styles?: unknown };
    expect(themeJson.styles).toBeDefined(); // styles kept — no css carry
    // Symmetric lock: JS IS carried here, so the html.js gate must be present.
    const fns = jsOnlyFiles.find((f) => f.relativePath === 'functions.php')?.content ?? '';
    expect(fns).toContain("classList.add('js')");
  });

  it('css-only carry: no js file and NO html.js gate (gated CSS must not hide content)', () => {
    // js: '' → no source script ships, so nothing would ever reveal sections
    // that reveal-gated source CSS hides behind html.js. Emitting the gate
    // anyway would permanently blank above-fold content.
    const cssOnlyFiles = assembleLocalTheme({
      siteTitle: 'Acme Co',
      themeSlug: 'acme-local',
      headerPart: HEADER,
      footerPart: FOOTER,
      carrySourceAssets: { css: '.html.js .s{opacity:0}', js: '' },
    });
    expect(cssOnlyFiles.some((f) => f.relativePath === 'assets/js/source.js')).toBe(false);
    expect(cssOnlyFiles.some((f) => f.relativePath === 'assets/css/source.css')).toBe(true);
    const fns = cssOnlyFiles.find((f) => f.relativePath === 'functions.php')?.content ?? '';
    expect(fns).not.toContain("classList.add('js')");
    // The CSS enqueue itself still lands.
    expect(fns).toContain('assets/css/source.css');
  });
});
