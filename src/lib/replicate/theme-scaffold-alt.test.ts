import { describe, it, expect } from 'vitest';
import { buildAltThemeFiles, type AltThemeInput, type AltPage } from './theme-scaffold-alt.js';

/** A single-variant chrome ('c0') so page-level tests stay terse. */
function oneVariant(headerIsland = '', footerIsland = ''): AltThemeInput['chromeVariants'] {
  return [{ key: 'c0', headerIsland, footerIsland }];
}
/** Default a page onto the single 'c0' variant. */
function page(p: Omit<AltPage, 'chromeKey'> & { chromeKey?: string }): AltPage {
  return { chromeKey: 'c0', ...p };
}

describe('buildAltThemeFiles', () => {
  const files = buildAltThemeFiles({
    themeName: 'Acme Alt',
    chromeVariants: oneVariant(
      '<!-- wp:html -->\n<header>H</header>\n<!-- /wp:html -->',
      '<!-- wp:html -->\n<footer>F</footer>\n<!-- /wp:html -->',
    ),
    siteCss: 'body.lib-alt-site{margin:0}',
    pages: [page({ slug: 'home', isHome: true, pageCss: 'body.lib-alt-page-home .x{a:b}' })],
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

  it('replicates sanitized source body classes onto the WP body (e.g. responsive)', () => {
    const fn = buildAltThemeFiles({
      themeName: 'A', chromeVariants: oneVariant(), siteCss: '',
      bodyClasses: ['responsive', 'device-mobile', 'bad class!', '', '123nope'],
      pages: [page({ slug: 'home', isHome: true, pageCss: '' })],
    }).find((f) => f.path === 'functions.php')!.content;
    expect(fn).toContain("$classes[] = 'responsive';");
    expect(fn).toContain("$classes[] = 'device-mobile';");
    // unsafe tokens are dropped
    expect(fn).not.toContain('bad class!');
    expect(fn).not.toContain("'123nope'");
  });

  it('emits templates/index.html as a required WP block theme fallback template', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toContain('templates/index.html');
    const tpl = byPath('templates/index.html');
    expect(tpl).toContain('wp:template-part {"slug":"header"');
    expect(tpl).toContain('wp:template-part {"slug":"footer"');
  });

  it('style.css contains Theme Name header', () => {
    expect(byPath('style.css')).toContain('Theme Name: Acme Alt');
  });

  it('style.css has a Theme Name header and NO Template field (not a child theme)', () => {
    const s = byPath('style.css');
    expect(s).toContain('Theme Name:');
    expect(s).not.toMatch(/^\s*Template:/m);
  });

  it('site.css carries the reset before the carried CSS', () => {
    const css = byPath('assets/css/site.css');
    expect(css).toContain('all:revert');
    expect(css.indexOf('all:revert')).toBeLessThan(css.indexOf('body.lib-alt-site{margin:0}'));
  });

  it('theme.json is valid JSON at version 3', () => {
    expect(JSON.parse(byPath('theme.json')).version).toBe(3);
  });

  it('a non-home page emits templates/page-<slug>.html and is_page() enqueue/body-class', () => {
    const f = buildAltThemeFiles({
      themeName: 'Acme Alt', chromeVariants: oneVariant(), siteCss: '',
      pages: [page({ slug: 'about', isHome: false, pageCss: '' })],
    });
    expect(f.map((x) => x.path)).toContain('templates/page-about.html');
    expect(f.find((x) => x.path === 'functions.php')!.content).toContain("is_page( 'about' )");
  });

  it('a post scopes via is_single() and its CSS file, not is_page()', () => {
    const f = buildAltThemeFiles({
      themeName: 'Acme Alt', chromeVariants: oneVariant(), siteCss: '',
      pages: [page({ slug: 'my-article', isHome: false, postType: 'post', pageCss: 'body.lib-alt-page-my-article{}' })],
    });
    const fn = f.find((x) => x.path === 'functions.php')!.content;
    expect(fn).toContain("is_single( 'my-article' )");
    expect(fn).not.toContain("is_page( 'my-article' )");
    expect(f.map((x) => x.path)).toContain('assets/css/page-my-article.css');
    expect(fn).toContain('lib-alt-page-my-article');
  });

  it('posts share ONE single.html and emit no per-post page template', () => {
    const f = buildAltThemeFiles({
      themeName: 'Acme Alt', chromeVariants: oneVariant(), siteCss: '',
      pages: [
        page({ slug: 'post-a', isHome: false, postType: 'post', pageCss: '' }),
        page({ slug: 'post-b', isHome: false, postType: 'post', pageCss: '' }),
      ],
    });
    const paths = f.map((x) => x.path);
    expect(paths.filter((p) => p === 'templates/single.html')).toHaveLength(1);
    expect(paths).not.toContain('templates/page-post-a.html');
    expect(paths).not.toContain('templates/page-post-b.html');
  });

  describe('per-page chrome variants (dedupe by content)', () => {
    // Home uses variant c0 (transparent overlay); two interior pages share c1 (solid).
    const f = buildAltThemeFiles({
      themeName: 'Acme Alt',
      chromeVariants: [
        { key: 'c0', headerIsland: '<!-- wp:html --><header id="home-hdr">home</header><!-- /wp:html -->', footerIsland: '<!-- wp:html --><footer id="f0">f0</footer><!-- /wp:html -->' },
        { key: 'c1', headerIsland: '<!-- wp:html --><header id="int-hdr">interior</header><!-- /wp:html -->', footerIsland: '<!-- wp:html --><footer id="f1">f1</footer><!-- /wp:html -->' },
      ],
      siteCss: 'body.lib-alt-site #home-hdr{a:b}\nbody.lib-alt-site #int-hdr{c:d}',
      pages: [
        page({ slug: 'home', isHome: true, chromeKey: 'c0', pageCss: '' }),
        page({ slug: 'about', isHome: false, chromeKey: 'c1', pageCss: '' }),
        page({ slug: 'contact', isHome: false, chromeKey: 'c1', pageCss: '' }),
      ],
    });
    const get = (p: string) => f.find((x) => x.path === p)?.content ?? '';
    const paths = f.map((x) => x.path);

    it('emits one part pair per DISTINCT variant (c0 → header, c1 → header-2)', () => {
      expect(paths).toContain('parts/header.html');
      expect(paths).toContain('parts/footer.html');
      expect(paths).toContain('parts/header-2.html');
      expect(paths).toContain('parts/footer-2.html');
      // not one-per-page: no header-3 for the second c1 page
      expect(paths).not.toContain('parts/header-3.html');
      expect(get('parts/header.html')).toContain('home-hdr');
      expect(get('parts/header-2.html')).toContain('int-hdr');
    });

    it('home template references the home header, interior templates reference header-2', () => {
      expect(get('templates/front-page.html')).toContain('"slug":"header"');
      expect(get('templates/front-page.html')).not.toContain('"slug":"header-2"');
      expect(get('templates/page-about.html')).toContain('"slug":"header-2"');
      expect(get('templates/page-contact.html')).toContain('"slug":"header-2"');
    });

    it('declares every variant\'s parts in theme.json', () => {
      const names = (JSON.parse(get('theme.json')).templateParts ?? []).map((p: { name: string }) => p.name);
      expect(names).toEqual(expect.arrayContaining(['header', 'footer', 'header-2', 'footer-2']));
    });

    it('site.css carries BOTH variants\' chrome CSS', () => {
      const css = get('assets/css/site.css');
      expect(css).toContain('#home-hdr');
      expect(css).toContain('#int-hdr');
    });
  });

  describe('scaffolded chrome architecture', () => {
    const scaffold = { openWrap: '<div id="C"><div id="root">', midBefore: '<div id="inner">', midAfter: '</div>', closeWrap: '</div></div>' };
    const f = buildAltThemeFiles({
      themeName: 'Acme Alt',
      chromeVariants: oneVariant(
        '<!-- wp:html --><header id="H">nav</header><!-- /wp:html -->',
        '<!-- wp:html --><footer id="F">foot</footer><!-- /wp:html -->',
      ),
      siteCss: 'body.lib-alt-site #H{a:b}',
      pages: [page({ slug: 'about', isHome: false, scaffold, pageCss: '' })],
    });
    const get = (p: string) => f.find((x) => x.path === p)?.content ?? '';

    it('puts the wrapper scaffold + chrome parts + post-content in the template', () => {
      const tpl = get('templates/page-about.html');
      expect(tpl).toContain('<div id="C"><div id="root">');
      expect(tpl).toContain('<div id="inner">');
      expect(tpl).toContain('wp:template-part {"slug":"header","tagName":"div"}');
      expect(tpl).toContain('wp:post-content');
      expect(tpl).toContain('wp:template-part {"slug":"footer","tagName":"div"}');
      expect(tpl.indexOf('"header"')).toBeLessThan(tpl.indexOf('wp:post-content'));
      expect(tpl.indexOf('wp:post-content')).toBeLessThan(tpl.indexOf('"footer"'));
    });

    it('adds the display:contents wrapper rescue to site.css when scaffolded', () => {
      expect(get('assets/css/site.css')).toContain('.wp-block-template-part{display:contents}');
    });

    it('adds a mobile-gated pro-gallery reflow override to site.css', () => {
      const css = get('assets/css/site.css');
      expect(css).toContain('@media screen and (max-width:750px)');
      expect(css).toContain('pro-gallery');
      expect(css).toContain('flex-direction:column!important');
    });

    it('declares header/footer template-part areas in theme.json', () => {
      const areas = (JSON.parse(get('theme.json')).templateParts ?? []).map((p: { area: string }) => p.area);
      expect(areas).toContain('header');
      expect(areas).toContain('footer');
    });

    it('omits the display:contents rescue when no page has a scaffold', () => {
      const plain = buildAltThemeFiles({
        themeName: 'Acme Alt', chromeVariants: oneVariant(), siteCss: '',
        pages: [page({ slug: 'about', isHome: false, pageCss: '' })],
      });
      expect(plain.find((x) => x.path === 'assets/css/site.css')?.content).not.toContain('display:contents');
    });
  });
});
