import { describe, it, expect } from 'vitest';
import { assembleAltTheme } from './reconstruct-pages-alt.js';

describe('assembleAltTheme', () => {
  it('builds theme files + per-page WXR content from page inputs', () => {
    const out = assembleAltTheme({
      themeName: 'Acme Alt',
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          bodyHtml:
            '<header class="h">H</header><main><div class="hero">Hi</div></main><footer class="f">F</footer>',
          css: '.hero{color:red}',
        },
      ],
      mediaUrlMap: new Map(),
    });
    expect(out.themeFiles.some((f) => f.path === 'parts/header.html')).toBe(true);
    expect(out.themeFiles.some((f) => f.path === 'assets/css/page-home.css')).toBe(true);
    const home = out.wxrPages.find((p) => p.slug === 'home')!;
    expect(home.postContent).toContain('<!-- wp:html -->');
    expect(home.postContent).toContain('class="hero"');
  });
});
