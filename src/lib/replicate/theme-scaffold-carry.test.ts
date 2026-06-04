import { describe, it, expect } from 'vitest';
import { buildCarryThemeFiles, type CarryThemeInput, type CarryPage } from './theme-scaffold-carry.js';

/** A single-variant chrome ('c0') so page-level tests stay terse. */
function oneVariant(headerIsland = '', footerIsland = ''): CarryThemeInput['chromeVariants'] {
  return [{ key: 'c0', headerIsland, footerIsland }];
}
/** Default a page onto the single 'c0' variant. */
function page(p: Omit<CarryPage, 'chromeKey'> & { chromeKey?: string }): CarryPage {
  return { chromeKey: 'c0', ...p };
}

describe('buildCarryThemeFiles', () => {
  const files = buildCarryThemeFiles({
    themeName: 'Acme Carry',
    chromeVariants: oneVariant(
      '<!-- wp:html -->\n<header>H</header>\n<!-- /wp:html -->',
      '<!-- wp:html -->\n<footer>F</footer>\n<!-- /wp:html -->',
    ),
    siteCss: 'body.lib-carry-site{margin:0}',
    pages: [page({ slug: 'home', isHome: true, pageCss: 'body.lib-carry-page-home .x{a:b}' })],
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
    expect(fn).toContain('lib-carry-site');
    expect(fn).toContain('lib-carry-page-home');
    expect(fn).toContain('wp_enqueue_style');
  });

  it('replicates sanitized source body classes onto the WP body (e.g. responsive)', () => {
    const fn = buildCarryThemeFiles({
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
    expect(byPath('style.css')).toContain('Theme Name: Acme Carry');
  });

  it('style.css has a Theme Name header and NO Template field (not a child theme)', () => {
    const s = byPath('style.css');
    expect(s).toContain('Theme Name:');
    expect(s).not.toMatch(/^\s*Template:/m);
  });

  it('site.css carries the reset before the carried CSS', () => {
    const css = byPath('assets/css/site.css');
    expect(css).toContain('all:revert');
    expect(css.indexOf('all:revert')).toBeLessThan(css.indexOf('body.lib-carry-site{margin:0}'));
  });

  it('site.css makes decorative Wix background layers non-interactive (they must not swallow clicks)', () => {
    // Wix bgLayers/colorUnderlay are absolute; inset:0 overlays; without containment a carried
    // one can blanket the page and intercept every click on the links beneath it. They are purely
    // decorative, so the carry forces them pointer-events:none. Unconditional (this fixture has no
    // scaffold), and must win the cascade (!important) over the carried source CSS.
    const css = byPath('assets/css/site.css');
    expect(css).toContain('[data-hook="bgLayers"]');
    expect(css).toContain('[data-testid="colorUnderlay"]');
    expect(css).toMatch(/\[data-testid="colorUnderlay"\][^}]*pointer-events:none!important/);
  });

  it('theme.json is valid JSON at version 3', () => {
    expect(JSON.parse(byPath('theme.json')).version).toBe(3);
  });

  it('a non-home page emits templates/page-<slug>.html and is_page() enqueue/body-class', () => {
    const f = buildCarryThemeFiles({
      themeName: 'Acme Carry', chromeVariants: oneVariant(), siteCss: '',
      pages: [page({ slug: 'about', isHome: false, pageCss: '' })],
    });
    expect(f.map((x) => x.path)).toContain('templates/page-about.html');
    expect(f.find((x) => x.path === 'functions.php')!.content).toContain("is_page( 'about' )");
  });

  it('a post scopes via is_single() and its CSS file, not is_page()', () => {
    const f = buildCarryThemeFiles({
      themeName: 'Acme Carry', chromeVariants: oneVariant(), siteCss: '',
      pages: [page({ slug: 'my-article', isHome: false, postType: 'post', pageCss: 'body.lib-carry-page-my-article{}' })],
    });
    const fn = f.find((x) => x.path === 'functions.php')!.content;
    expect(fn).toContain("is_single( 'my-article' )");
    expect(fn).not.toContain("is_page( 'my-article' )");
    expect(f.map((x) => x.path)).toContain('assets/css/page-my-article.css');
    expect(fn).toContain('lib-carry-page-my-article');
  });

  it('posts share ONE single.html and emit no per-post page template', () => {
    const f = buildCarryThemeFiles({
      themeName: 'Acme Carry', chromeVariants: oneVariant(), siteCss: '',
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
    const f = buildCarryThemeFiles({
      themeName: 'Acme Carry',
      chromeVariants: [
        { key: 'c0', headerIsland: '<!-- wp:html --><header id="home-hdr">home</header><!-- /wp:html -->', footerIsland: '<!-- wp:html --><footer id="f0">f0</footer><!-- /wp:html -->' },
        { key: 'c1', headerIsland: '<!-- wp:html --><header id="int-hdr">interior</header><!-- /wp:html -->', footerIsland: '<!-- wp:html --><footer id="f1">f1</footer><!-- /wp:html -->' },
      ],
      siteCss: 'body.lib-carry-site #home-hdr{a:b}\nbody.lib-carry-site #int-hdr{c:d}',
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
    const f = buildCarryThemeFiles({
      themeName: 'Acme Carry',
      chromeVariants: oneVariant(
        '<!-- wp:html --><header id="H">nav</header><!-- /wp:html -->',
        '<!-- wp:html --><footer id="F">foot</footer><!-- /wp:html -->',
      ),
      siteCss: 'body.lib-carry-site #H{a:b}',
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

    it('adds the mobile-gated pro-gallery grid toggle to site.css', () => {
      const css = get('assets/css/site.css');
      expect(css).toContain('@media screen and (max-width:750px)');
      expect(css).toContain('div.pro-gallery:has(+ .lib-carry-gallery-mobile){display:none!important}');
      expect(css).toContain('.lib-carry-gallery-mobile{display:grid!important');
    });

    it('adds the dual-viewport mobile-DOM iframe toggle to site.css', () => {
      const css = get('assets/css/site.css');
      // base: mobile island hidden, desktop wrapper transparent (no layout impact)
      expect(css).toContain('.lib-carry-vp-mobile{display:none}');
      expect(css).toContain('.lib-carry-vp-desktop{display:contents}');
      // below 750px: hide desktop island, show the iframe, neutralize the desktop scaffold
      expect(css).toContain('.lib-carry-vp-desktop{display:none!important}');
      expect(css).toContain('.lib-carry-vp-mobile{display:block!important}');
      expect(css).toContain('[id^="pageBackground"]');
    });

    it('functions.php allows the mobile-island <iframe> through KSES', () => {
      const fn = get('functions.php');
      expect(fn).toContain('wp_kses_allowed_html');
      expect(fn).toContain("'iframe'");
    });

    it('declares header/footer template-part areas in theme.json', () => {
      const areas = (JSON.parse(get('theme.json')).templateParts ?? []).map((p: { area: string }) => p.area);
      expect(areas).toContain('header');
      expect(areas).toContain('footer');
    });

    it('omits the chrome-rescue display:contents rule when no page has a scaffold', () => {
      const plain = buildCarryThemeFiles({
        themeName: 'Acme Carry', chromeVariants: oneVariant(), siteCss: '',
        pages: [page({ slug: 'about', isHome: false, pageCss: '' })],
      });
      // The CHROME_RESCUE rule specifically — NOT the unconditional vp-toggle's
      // display:contents (which legitimately appears for the mobile-DOM iframe).
      expect(plain.find((x) => x.path === 'assets/css/site.css')?.content).not.toContain(
        '.wp-block-template-part{display:contents}',
      );
    });
  });
});

describe('buildCarryThemeFiles — WooCommerce store templates', () => {
  const STORE_HEADER =
    '<!-- wp:html -->\n<div class="lib-carry-vp-desktop">\n<header class="section-header">NAV</header>\n</div>\n<!-- /wp:html -->';
  const base: Omit<CarryThemeInput, 'hasProducts' | 'storeHeaderIsland'> = {
    themeName: 'Acme Carry',
    chromeVariants: oneVariant(
      '<!-- wp:html -->\n<header>H</header>\n<!-- /wp:html -->',
      '<!-- wp:html -->\n<footer>F</footer>\n<!-- /wp:html -->',
    ),
    siteCss: 'body.lib-carry-site{margin:0}',
    pages: [page({ slug: 'home', isHome: true, pageCss: '' })],
  };
  const find = (files: ReturnType<typeof buildCarryThemeFiles>, p: string) =>
    files.find((f) => f.path === p)?.content;

  it('emits header-store part + single/archive-product templates when hasProducts + storeHeaderIsland', () => {
    const files = buildCarryThemeFiles({ ...base, hasProducts: true, storeHeaderIsland: STORE_HEADER });
    expect(find(files, 'parts/header-store.html')).toContain('section-header');
    const sp = find(files, 'templates/single-product.html');
    expect(sp).toContain('"slug":"header-store"');
    // Modern product blocks (not legacy-template) so we control buy-box → marketing order.
    expect(sp).toContain('wp:woocommerce/product-image-gallery');
    expect(sp).toContain('wp:woocommerce/add-to-cart-form');
    expect(sp).toContain('wp:post-content'); // rich marketing rendered full-width below the buy box
    expect(sp).not.toContain('legacy-template');
    expect(sp).toContain('"slug":"footer"'); // canonical footer still used
    // The shop/category archive keeps the robust classic WC archive grid.
    expect(find(files, 'templates/archive-product.html')).toContain(
      'wp:woocommerce/legacy-template {"template":"archive-product"}',
    );
  });

  it('registers captured palette + font tokens in theme.json when provided', () => {
    const files = buildCarryThemeFiles({
      ...base,
      hasProducts: true,
      storeHeaderIsland: STORE_HEADER,
      themeJsonPalette: [{ slug: 'c1', name: 'Replica 1', color: '#abcdef' }],
      themeJsonFontFamilies: [{ slug: 'brandsans', name: 'BrandSans', fontFamily: 'BrandSans, sans-serif' }],
    });
    const tj = JSON.parse(find(files, 'theme.json')!);
    expect(tj.settings.color.palette).toEqual([{ slug: 'c1', name: 'Replica 1', color: '#abcdef' }]);
    expect(tj.settings.typography.fontFamilies[0].slug).toBe('brandsans');
  });

  it('declares header-store as a header template part in theme.json', () => {
    const files = buildCarryThemeFiles({ ...base, hasProducts: true, storeHeaderIsland: STORE_HEADER });
    const tj = JSON.parse(find(files, 'theme.json')!);
    expect(tj.templateParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'header-store', area: 'header' })]),
    );
  });

  it('does NOT emit store templates when hasProducts is false', () => {
    const files = buildCarryThemeFiles({ ...base, hasProducts: false, storeHeaderIsland: STORE_HEADER });
    expect(find(files, 'templates/single-product.html')).toBeUndefined();
    expect(find(files, 'parts/header-store.html')).toBeUndefined();
  });

  it('does NOT emit store templates when no header could be isolated (empty storeHeaderIsland)', () => {
    const files = buildCarryThemeFiles({ ...base, hasProducts: true, storeHeaderIsland: '' });
    expect(find(files, 'templates/single-product.html')).toBeUndefined();
    expect(find(files, 'templates/archive-product.html')).toBeUndefined();
  });
});
