import { describe, it, expect } from 'vitest';
import { reconstructPageAlt } from './page-reconstruct-alt.js';

describe('reconstructPageAlt', () => {
  it('produces a scoped main island + split chrome/main CSS', () => {
    const r = reconstructPageAlt({
      slug: 'home',
      isHome: true,
      bodyHtml:
        '<header class="h">H</header><main><div class="hero">Hi</div></main><footer class="f">F</footer>',
      css: '.hero{color:red} .h{color:green} .nope{color:blue}',
      specs: [],
      mediaUrlMap: new Map(),
    });
    expect(r.mainIsland).toContain('<!-- wp:html -->');
    expect(r.mainIsland).toContain('class="hero"');
    // main sheet: page-scoped (zero-specificity :where), has .hero, drops chrome-only/unmatched
    expect(r.mainCss).toContain(':where(body.lib-alt-site.lib-alt-page-home) .hero');
    expect(r.mainCss).not.toContain('.nope');
    expect(r.mainCss).not.toContain('.h{'); // .h is chrome, not in main DOM -> dropped from main sheet
    // chrome sheet: site-wide scoped, has .h, drops main-only rules
    expect(r.chromeCss).toContain(':where(body.lib-alt-site) .h');
    expect(r.chromeCss).not.toContain('.hero'); // .hero not in chrome DOM
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
    // The @media rule containing .hero should survive treeshaking in the main sheet
    expect(r.mainCss).toContain('.hero');
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
    expect(r.chromeCss).toBe('');
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
