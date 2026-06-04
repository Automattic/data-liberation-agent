import { describe, it, expect } from 'vitest';
import { assembleCarryTheme } from './reconstruct-pages-carry.js';

describe('assembleCarryTheme', () => {
  it('builds theme files + per-page WXR content, with chrome CSS site-wide and main CSS per-page', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml:
            '<header class="h">H</header><main><div class="hero">Hi</div></main><footer class="f">F</footer>',
          css: '.hero{color:red} .h{color:green}',
        },
      ],
      mediaUrlMap: new Map(),
    });
    const byPath = (p: string) => out.themeFiles.find((f) => f.path === p)?.content ?? '';
    // chrome rule is in the globally-enqueued site.css (after the reset), main rule in page sheet
    expect(byPath('assets/css/site.css')).toContain(':where(body.lib-carry-site) .h');
    expect(byPath('assets/css/page-home.css')).toContain(':where(body.lib-carry-site.lib-carry-page-home) .hero');
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('<!-- wp:html -->');
    expect(home.postContent).toContain('class="hero"');
  });

  it('threads a page mobile-DOM into a dual-viewport island', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml: '<main><div class="c">desktop</div></main>',
          css: '',
          mobile: { docUrl: '/wp-content/uploads/_carry-mobile/home.html', height: 4000 },
        },
      ],
      mediaUrlMap: new Map(),
    });
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('class="lib-carry-vp-desktop"');
    expect(home.postContent).toContain('class="lib-carry-vp-mobile"');
    expect(home.postContent).toContain('src="/wp-content/uploads/_carry-mobile/home.html"');
    expect(home.postContent).toContain('height="4000"');
  });

  it('skips a page that throws in reconstructPageCarry instead of crashing the whole build', () => {
    // `<xmp>` is rawtext: cheerio keeps the `<script>` as text, so carryHtml's
    // injection gate throws. ONE such page must not take down the whole reconstruct.
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      mediaUrlMap: new Map(),
      pages: [
        { slug: 'good', title: 'G', isHome: true, bodyHtml: '<main><div class="c">ok</div></main>', css: '' },
        { slug: 'bad', title: 'B', bodyHtml: '<xmp><script>x()</script></xmp>', css: '' },
      ],
    });
    expect(out.wxrPages.find((p) => p.slug === 'good')).toBeTruthy();
    expect(out.wxrPages.find((p) => p.slug === 'bad')).toBeFalsy();
    expect(out.skipped).toContain('bad');
  });

  it('keeps the active-nav highlight on a single-page header, strips it on a shared one', () => {
    const header = (active: 'home' | 'about') =>
      '<header class="h"><nav data-hook="menu-root" class="wixui-horizontal-menu">' +
      `<a ${active === 'home' ? 'data-selected="true" aria-current="page" ' : ''}data-part="x">HOME</a>` +
      `<a ${active === 'about' ? 'data-selected="true" aria-current="page" ' : ''}data-part="x">ABOUT</a>` +
      '</nav></header><main><div class="c">c</div></main>';
    const findHeader = (out: ReturnType<typeof assembleCarryTheme>) =>
      out.themeFiles.find((f) => f.path === 'parts/header.html')?.content ?? '';

    // One page using the header → keeps its own "current" highlight.
    const solo = assembleCarryTheme({
      themeName: 'A',
      pages: [{ slug: 'home', title: 'H', isHome: true, bodyHtml: header('home'), css: '' }],
      mediaUrlMap: new Map(),
    });
    expect(findHeader(solo)).toContain('aria-current="page"');

    // Two pages sharing one header (differ only by which item is current) → dedupe
    // to one variant, emitted active-stripped so it doesn't pin one page's highlight.
    const shared = assembleCarryTheme({
      themeName: 'A',
      pages: [
        { slug: 'home', title: 'H', isHome: true, bodyHtml: header('home'), css: '' },
        { slug: 'about', title: 'A', bodyHtml: header('about'), css: '' },
      ],
      mediaUrlMap: new Map(),
    });
    // single shared header part (no header-2), and it's stripped
    expect(shared.themeFiles.some((f) => f.path === 'parts/header-2.html')).toBe(false);
    expect(findHeader(shared)).not.toContain('aria-current="page"');
  });

  it('rewrites carried hrefs through the linkMap', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml: '<main><a href="https://acme.test/about">About</a></main>',
          css: '',
        },
      ],
      mediaUrlMap: new Map(),
      linkMap: new Map([['acme.test/about', '/about/']]),
    });
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('href="/about/"');
    expect(home.postContent).not.toContain('acme.test/about');
  });

  it('rewrites carried image srcs through the mediaUrlMap', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml: '<main><img src="https://cdn.test/a.jpg"></main>',
          css: '',
        },
      ],
      mediaUrlMap: new Map([['https://cdn.test/a.jpg', 'http://localhost/wp-content/uploads/a.jpg']]),
    });
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('/wp-content/uploads/a.jpg');
    expect(home.postContent).not.toContain('cdn.test');
  });

  it('threads postType through to the WXR page records', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      pages: [
        { slug: 'a-post', title: 'A Post', postType: 'post', bodyHtml: '<main>x</main>', css: '' },
      ],
      mediaUrlMap: new Map(),
    });
    expect(out.wxrPages.find((p) => p.slug === 'a-post')!.postType).toBe('post');
    // and the theme scopes it via is_single
    const fn = out.themeFiles.find((f) => f.path === 'functions.php')!.content;
    expect(fn).toContain("is_single( 'a-post' )");
  });

  it('emits WooCommerce store templates + a header-store part when hasProducts and a header is found', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      hasProducts: true,
      pages: [
        {
          slug: 'home',
          title: 'H',
          isHome: true,
          bodyHtml: '<header class="h"><a href="/">Logo</a></header><main><div class="c">c</div></main>',
          css: '',
        },
      ],
      mediaUrlMap: new Map(),
    });
    expect(out.warnings).toHaveLength(0);
    expect(out.themeFiles.some((f) => f.path === 'parts/header-store.html')).toBe(true);
    const sp = out.themeFiles.find((f) => f.path === 'templates/single-product.html')?.content ?? '';
    expect(sp).toContain('"slug":"header-store"');
    // Modern product blocks + full-width post-content (marketing), not legacy-template.
    expect(sp).toContain('wp:woocommerce/add-to-cart-form');
    expect(sp).toContain('wp:post-content');
    expect(sp).not.toContain('legacy-template');
    expect(out.themeFiles.some((f) => f.path === 'templates/archive-product.html')).toBe(true);
  });

  it('WARNS and emits no store templates when hasProducts but no header can be isolated', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      hasProducts: true,
      pages: [{ slug: 'home', title: 'H', isHome: true, bodyHtml: '<main><div class="c">no header here</div></main>', css: '' }],
      mediaUrlMap: new Map(),
    });
    expect(out.warnings.join(' ')).toMatch(/without site chrome/i);
    expect(out.themeFiles.some((f) => f.path === 'templates/single-product.html')).toBe(false);
    expect(out.themeFiles.some((f) => f.path === 'parts/header-store.html')).toBe(false);
  });

  it('emits no store templates (and no warning) when the run has no products', () => {
    const out = assembleCarryTheme({
      themeName: 'Acme Carry',
      hasProducts: false,
      pages: [{ slug: 'home', title: 'H', isHome: true, bodyHtml: '<header class="h">H</header><main>x</main>', css: '' }],
      mediaUrlMap: new Map(),
    });
    expect(out.warnings).toHaveLength(0);
    expect(out.themeFiles.some((f) => f.path === 'templates/single-product.html')).toBe(false);
  });
});
