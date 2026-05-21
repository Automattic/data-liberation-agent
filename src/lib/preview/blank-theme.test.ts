import { describe, it, expect } from 'vitest';
import { buildBlankTheme } from './blank-theme.js';

describe('buildBlankTheme', () => {
  it('emits a valid theme enqueuing site.css; site.js + CSP only when scripts present', () => {
    const noJs = buildBlankTheme({ themeSlug: 'dla-replica', hasJs: false, headLinks: ['https://fonts.googleapis.com/css?f=X'] });
    const paths = noJs.map((f) => f.relativePath);
    expect(paths).toContain('style.css');
    expect(paths).toContain('functions.php');
    expect(paths).toContain('index.php');
    const fns = noJs.find((f) => f.relativePath === 'functions.php')!.content;
    expect(fns).toContain('wp_enqueue_style');
    expect(fns).toContain('site.css');
    expect(fns).toContain('add_editor_style');
    expect(fns).toContain('fonts.googleapis.com');
    expect(fns).not.toContain('site.js');
    expect(fns).not.toContain('Content-Security-Policy');
    // wpautop / wptexturize must be removed so carried raw HTML is not mangled
    expect(fns).toContain("remove_filter('the_content', 'wpautop')");
    expect(fns).toContain("remove_filter('the_content', 'wptexturize')");

    const withJs = buildBlankTheme({ themeSlug: 'dla-replica', hasJs: true, headLinks: [] }).find((f) => f.relativePath === 'functions.php')!.content;
    expect(withJs).toContain('site.js');
    expect(withJs).toContain('Content-Security-Policy');
    expect(withJs).toContain("script-src 'self'");
    expect(withJs).toContain('cdn.jsdelivr.net');
  });

  it('index.php renders the_content with no header/footer chrome', () => {
    const idx = buildBlankTheme({ themeSlug: 'dla-replica', hasJs: false, headLinks: [] }).find((f) => f.relativePath === 'index.php')!.content;
    expect(idx).toContain('the_content()');
    expect(idx).not.toMatch(/get_header|get_footer|get_sidebar/);
  });

  it('style.css has a valid theme header', () => {
    const style = buildBlankTheme({ themeSlug: 'dla-replica', hasJs: false, headLinks: [] }).find((f) => f.relativePath === 'style.css')!.content;
    expect(style).toMatch(/Theme Name:/);
  });
});
