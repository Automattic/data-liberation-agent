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
