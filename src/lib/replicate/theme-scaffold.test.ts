import { describe, it, expect } from 'vitest';
import { buildThemeScaffold } from './theme-scaffold.js';

const FOUNDATION_FIXTURE = {
  version: 1,
  color: {
    surface: {
      base: { value: '#ffffff' },
      raised: { value: '#f6f6f6' },
      inverse: { value: '#2f394e' },
    },
    text: {
      default: { value: '#000000' },
      muted: { value: '#545a71' },
      subtle: { value: '#141414' },
      inverse: { value: '#ffffff' },
    },
    accent: {
      primary: { value: '#6cd7bd' },
      primaryAlt: { value: '#00b4b4' },
      warning: { value: null },
      warm: { value: '#fdfaf7' },
      highlight: { value: '#9ee4d3' },
    },
    border: {
      default: { value: '#e5e6ff' },
      subtle: { value: '#f0f0f0' },
    },
  },
  typography: {
    families: {
      body: { value: 'quasimoda, sans-serif' },
      display: { value: 'Larsseit, sans-serif' },
      mono: { value: 'monospace' },
    },
  },
  breakpoints: { md: '641px', lg: '901px' },
  radius: { sm: '4px', base: '8px', lg: '16px' },
  spacing: { sections: { padX: '40px', padY: '80px', contentMaxWidth: '1200px' } },
  components: {
    button: { background: 'color.accent.primary', text: 'color.text.inverse', radius: 'radius.lg', padding: '12px 24px', fontWeight: 500 },
  },
};

describe('buildThemeScaffold', () => {
  it('emits the canonical 6-file bundle', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const paths = files.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      'functions.php',
      'parts/footer.html',
      'parts/header.html',
      'style.css',
      'templates/index.html',
      'theme.json',
    ]);
  });

  it('style.css carries a valid theme header', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const styleCss = files.find((f) => f.relativePath === 'style.css')!.content;
    expect(styleCss).toContain('Theme Name: getsnooz-com-replica');
    expect(styleCss).toContain('Version:');
    expect(styleCss).toContain('Text Domain: getsnooz-com-replica');
  });

  it('theme.json is valid JSON with version 3 and the expected palette slugs', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const themeJsonRaw = files.find((f) => f.relativePath === 'theme.json')!.content;
    const themeJson = JSON.parse(themeJsonRaw);
    expect(themeJson.version).toBe(3);
    expect(themeJson.$schema).toContain('schemas.wp.org');
    const slugs = (themeJson.settings.color.palette as Array<{ slug: string }>).map((p) => p.slug).sort();
    expect(slugs).toContain('surface-base');
    expect(slugs).toContain('surface-inverse');
    expect(slugs).toContain('accent-primary');
    expect(slugs).toContain('accent-primary-alt');
    expect(slugs).toContain('accent-highlight');
    expect(slugs).toContain('text-inverse');
    expect(slugs).toContain('border-default');
  });

  it('omits null accent values from the palette', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    const slugs = (themeJson.settings.color.palette as Array<{ slug: string }>).map((p) => p.slug);
    // accent-warning has value: null in the fixture → must NOT appear in output.
    expect(slugs).not.toContain('accent-warning');
  });

  it('emits both display and body fontFamilies when both are set', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    const slugs = (themeJson.settings.typography.fontFamilies as Array<{ slug: string }>).map((f) => f.slug);
    expect(slugs).toContain('body');
    expect(slugs).toContain('display');
    // mono is "monospace" (CSS generic) → skipped.
    expect(slugs).not.toContain('mono');
  });

  it('omits display when the foundation lacks one (no hallucination)', () => {
    const noDisplay = JSON.parse(JSON.stringify(FOUNDATION_FIXTURE));
    noDisplay.typography.families.display = { value: null };
    const files = buildThemeScaffold({ foundation: noDisplay, themeSlug: 'site-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    const slugs = (themeJson.settings.typography.fontFamilies as Array<{ slug: string }>).map((f) => f.slug);
    expect(slugs).toContain('body');
    expect(slugs).not.toContain('display');
  });

  it('falls back to system sans-serif when body family is missing', () => {
    const noBody = JSON.parse(JSON.stringify(FOUNDATION_FIXTURE));
    noBody.typography.families.body = { value: null };
    const files = buildThemeScaffold({ foundation: noBody, themeSlug: 'site-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    const body = (themeJson.settings.typography.fontFamilies as Array<{ slug: string; fontFamily: string }>).find((f) => f.slug === 'body')!;
    expect(body.fontFamily).toMatch(/system-ui|sans-serif/);
  });

  it('layout.contentSize / wideSize map from breakpoints + sections.contentMaxWidth', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'site-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    expect(themeJson.settings.layout.contentSize).toBe('901px');
    expect(themeJson.settings.layout.wideSize).toBe('1200px'); // from spacing.sections.contentMaxWidth
  });

  it('button block override resolves radius via foundation token reference', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'site-replica' });
    const themeJson = JSON.parse(files.find((f) => f.relativePath === 'theme.json')!.content);
    const button = themeJson.styles.blocks['core/button'];
    expect(button.color.background).toBe('var(--wp--preset--color--accent-primary)');
    expect(button.color.text).toBe('var(--wp--preset--color--text-inverse)');
    // radius.lg in the fixture is "16px"
    expect(button.border.radius).toBe('16px');
  });

  it('functions.php registers blocks via glob and gates on block.json existence', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'getsnooz-com-replica' });
    const fnPhp = files.find((f) => f.relativePath === 'functions.php')!.content;
    expect(fnPhp).toContain('register_block_type');
    expect(fnPhp).toContain("glob(get_theme_file_path('blocks/*/build')");
    expect(fnPhp).toContain('after_setup_theme');
  });

  it('templates/index.html is a thin shell wrapping post-content with header+footer parts', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'site-replica' });
    const idx = files.find((f) => f.relativePath === 'templates/index.html')!.content;
    expect(idx).toContain('wp:template-part {"slug":"header"');
    expect(idx).toContain('wp:template-part {"slug":"footer"');
    expect(idx).toContain('wp:post-content');
  });

  it('parts/header.html contains site-title (linked) + navigation with page-list', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'site-replica' });
    const header = files.find((f) => f.relativePath === 'parts/header.html')!.content;
    expect(header).toContain('wp:site-title');
    expect(header).toContain('"isLink":true');
    expect(header).toContain('wp:navigation');
    expect(header).toContain('wp:page-list');
  });

  it('parts/header.html uses source chrome when provided', () => {
    const files = buildThemeScaffold({
      foundation: FOUNDATION_FIXTURE,
      themeSlug: 'site-replica',
      sourceChrome: {
        header: {
          logoUrl: 'http://localhost:8881/wp-content/uploads/2026/04/logo.png',
          logoAlt: 'Swift logo',
          links: [
            { label: 'HOME', href: '/', external: false },
            { label: 'PRODUCTS', href: '/about-us-1', external: false },
            { label: 'JOB OPPORTUNITIES', href: 'https://jobs.example.com', external: true },
          ],
        },
      },
    });
    const header = files.find((f) => f.relativePath === 'parts/header.html')!.content;
    expect(header).toContain('http://localhost:8881/wp-content/uploads/2026/04/logo.png');
    expect(header).toContain('"label":"PRODUCTS"');
    expect(header).toContain('"opensInNewTab":true');
    expect(header).not.toContain('wp:page-list');
  });

  it('parts/footer.html uses source footer text and links when provided', () => {
    const files = buildThemeScaffold({
      foundation: FOUNDATION_FIXTURE,
      themeSlug: 'site-replica',
      sourceChrome: {
        footer: {
          text: ['Swift Lumber', '1450 Swift Mill Rd, Atmore, AL', '251-446-4123'],
          links: [{ label: 'Privacy Policy', href: '/privacy-policy', external: false }],
        },
      },
    });
    const footer = files.find((f) => f.relativePath === 'parts/footer.html')!.content;
    expect(footer).toContain('Swift Lumber');
    expect(footer).toContain('1450 Swift Mill Rd, Atmore, AL');
    expect(footer).toContain('wp:navigation');
    expect(footer).toContain('"label":"Privacy Policy"');
    expect(footer).toContain('"url":"/privacy-policy"');
    expect(footer).not.toContain('wp:list');
  });

  it('parts/footer.html escapes site title HTML when rendering copyright', () => {
    const files = buildThemeScaffold({ foundation: FOUNDATION_FIXTURE, themeSlug: 'site-replica', siteTitle: 'A & B <Co>' });
    const footer = files.find((f) => f.relativePath === 'parts/footer.html')!.content;
    expect(footer).toContain('A &amp; B &lt;Co&gt;');
    expect(footer).not.toContain('<Co>');
  });
});
