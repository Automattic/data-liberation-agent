import { describe, it, expect } from 'vitest';
import { assembleAltTheme } from './reconstruct-pages-alt.js';

describe('assembleAltTheme', () => {
  it('builds theme files + per-page WXR content, with chrome CSS site-wide and main CSS per-page', () => {
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
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
    expect(byPath('assets/css/site.css')).toContain(':where(body.lib-alt-site) .h');
    expect(byPath('assets/css/page-home.css')).toContain(':where(body.lib-alt-site.lib-alt-page-home) .hero');
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('<!-- wp:html -->');
    expect(home.postContent).toContain('class="hero"');
  });

  it('threads a page mobile-DOM into a dual-viewport island', () => {
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml: '<main><div class="c">desktop</div></main>',
          css: '',
          mobile: { docUrl: '/wp-content/uploads/_alt-mobile/home.html', height: 4000 },
        },
      ],
      mediaUrlMap: new Map(),
    });
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('class="lib-alt-vp-desktop"');
    expect(home.postContent).toContain('class="lib-alt-vp-mobile"');
    expect(home.postContent).toContain('src="/wp-content/uploads/_alt-mobile/home.html"');
    expect(home.postContent).toContain('height="4000"');
  });

  it('keeps the active-nav highlight on a single-page header, strips it on a shared one', () => {
    const header = (active: 'home' | 'about') =>
      '<header class="h"><nav data-hook="menu-root" class="wixui-horizontal-menu">' +
      `<a ${active === 'home' ? 'data-selected="true" aria-current="page" ' : ''}data-part="x">HOME</a>` +
      `<a ${active === 'about' ? 'data-selected="true" aria-current="page" ' : ''}data-part="x">ABOUT</a>` +
      '</nav></header><main><div class="c">c</div></main>';
    const findHeader = (out: ReturnType<typeof assembleAltTheme>) =>
      out.themeFiles.find((f) => f.path === 'parts/header.html')?.content ?? '';

    // One page using the header → keeps its own "current" highlight.
    const solo = assembleAltTheme({
      themeName: 'A',
      pages: [{ slug: 'home', title: 'H', isHome: true, bodyHtml: header('home'), css: '' }],
      mediaUrlMap: new Map(),
    });
    expect(findHeader(solo)).toContain('aria-current="page"');

    // Two pages sharing one header (differ only by which item is current) → dedupe
    // to one variant, emitted active-stripped so it doesn't pin one page's highlight.
    const shared = assembleAltTheme({
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
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
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
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
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
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
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
});
