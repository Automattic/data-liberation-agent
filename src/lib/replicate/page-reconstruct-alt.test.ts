import { describe, it, expect } from 'vitest';
import { reconstructPageAlt } from './page-reconstruct-alt.js';

describe('reconstructPageAlt', () => {
  it('produces a scoped main island + scoped page CSS for a page', () => {
    const r = reconstructPageAlt({
      slug: 'home',
      isHome: true,
      bodyHtml:
        '<header class="h">H</header><main><div class="hero">Hi</div></main><footer class="f">F</footer>',
      css: '.hero{color:red} .nope{color:blue}',
      specs: [],
      mediaUrlMap: new Map(),
    });
    expect(r.mainIsland).toContain('<!-- wp:html -->');
    expect(r.mainIsland).toContain('class="hero"');
    expect(r.pageCss).toContain('body.lib-alt-site.lib-alt-page-home .hero');
    expect(r.pageCss).not.toContain('.nope'); // dropped: matches nothing in carried DOM
    expect(r.headerIsland).toContain('class="h"');
    expect(r.footerIsland).toContain('class="f"');
  });

  it('keeps @media blocks that contain a matched selector', () => {
    const r = reconstructPageAlt({
      slug: 'about',
      bodyHtml: '<div class="hero">Hello</div>',
      css: '@media(max-width:1px){.hero{color:green}} @media(max-width:1px){.gone{color:red}}',
      specs: [],
      mediaUrlMap: new Map(),
    });
    // The @media rule containing .hero should survive treeshaking
    expect(r.pageCss).toContain('.hero');
  });

  it('returns empty islands when header/footer are absent', () => {
    const r = reconstructPageAlt({
      slug: 'inner',
      bodyHtml: '<div class="content">Text</div>',
      css: '.content{font-size:16px}',
      specs: [],
      mediaUrlMap: new Map(),
    });
    expect(r.headerIsland).toBe('');
    expect(r.footerIsland).toBe('');
    expect(r.mainIsland).toContain('<!-- wp:html -->');
    expect(r.mainIsland).toContain('class="content"');
  });

  it('rewrites media URLs in carried HTML', () => {
    const mediaUrlMap = new Map([['https://cdn.example.com/img.jpg', '/wp-content/uploads/img.jpg']]);
    const r = reconstructPageAlt({
      slug: 'media-test',
      bodyHtml: '<img src="https://cdn.example.com/img.jpg" />',
      css: '',
      specs: [],
      mediaUrlMap,
    });
    expect(r.mainIsland).toContain('/wp-content/uploads/img.jpg');
    expect(r.mainIsland).not.toContain('cdn.example.com');
  });
});
