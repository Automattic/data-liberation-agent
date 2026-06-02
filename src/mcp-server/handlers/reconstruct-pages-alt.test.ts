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
    expect(byPath('assets/css/site.css')).toContain('body.lib-alt-site .h');
    expect(byPath('assets/css/page-home.css')).toContain('body.lib-alt-site.lib-alt-page-home .hero');
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('<!-- wp:html -->');
    expect(home.postContent).toContain('class="hero"');
  });
});
