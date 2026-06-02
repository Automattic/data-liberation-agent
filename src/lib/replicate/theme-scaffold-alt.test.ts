import { describe, it, expect } from 'vitest';
import { buildAltThemeFiles } from './theme-scaffold-alt.js';

describe('buildAltThemeFiles', () => {
  const files = buildAltThemeFiles({
    themeName: 'Acme Alt',
    headerIsland: '<!-- wp:html -->\n<header>H</header>\n<!-- /wp:html -->',
    footerIsland: '<!-- wp:html -->\n<footer>F</footer>\n<!-- /wp:html -->',
    siteCss: 'body.lib-alt-site{margin:0}',
    pages: [{ slug: 'home', isHome: true, pageCss: 'body.lib-alt-page-home .x{a:b}' }],
  });
  const byPath = (p: string) => files.find((f) => f.path === p)?.content ?? '';

  it('emits required theme files', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toContain('style.css');
    expect(paths).toContain('theme.json');
    expect(paths).toContain('functions.php');
    expect(paths).toContain('parts/header.html');
    expect(paths).toContain('parts/footer.html');
    expect(paths).toContain('assets/css/site.css');
    expect(paths).toContain('assets/css/page-home.css');
  });

  it('home page maps to templates/front-page.html and references header+footer parts', () => {
    const tpl = byPath('templates/front-page.html');
    expect(tpl).toContain('wp:template-part {"slug":"header"');
    expect(tpl).toContain('wp:template-part {"slug":"footer"');
  });

  it('functions.php adds body classes and conditionally enqueues page css', () => {
    const fn = byPath('functions.php');
    expect(fn).toContain('lib-alt-site');
    expect(fn).toContain('lib-alt-page-home');
    expect(fn).toContain('wp_enqueue_style');
  });

  it('emits templates/index.html as a required WP block theme fallback template', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toContain('templates/index.html');
    const tpl = byPath('templates/index.html');
    expect(tpl).toContain('wp:template-part {"slug":"header"');
    expect(tpl).toContain('wp:template-part {"slug":"footer"');
  });

  it('style.css contains Theme Name header', () => {
    const css = byPath('style.css');
    expect(css).toContain('Theme Name: Acme Alt');
  });
});
