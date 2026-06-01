import { describe, it, expect } from 'vitest';
import { carryHtml } from './html-carry.js';

describe('carryHtml', () => {
  it('keeps classes/structure but strips scripts and event handlers', () => {
    const { html } = carryHtml('<div class="hero" onclick="x()"><script>bad()</script><p>Hi</p></div>', {});
    expect(html).toContain('class="hero"');
    expect(html).toContain('<p>Hi</p>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
  });

  it('extracts inline <style> into styleText and removes it from html', () => {
    const { html, styleText } = carryHtml('<style>.a{color:red}</style><div class="a">x</div>', {});
    expect(styleText).toContain('.a{color:red}');
    expect(html).not.toContain('<style');
  });

  it('keeps allowlisted iframes and drops others', () => {
    const yt = carryHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>', {}).html;
    expect(yt).toContain('youtube.com/embed');
    const evil = carryHtml('<iframe src="https://evil.example/x"></iframe>', {}).html;
    expect(evil).not.toContain('iframe');
  });

  it('rewrites media URLs and internal links via the provided maps', () => {
    const { html } = carryHtml('<a href="/about"><img src="https://cdn/x.png"></a>', {
      mediaUrlMap: new Map([['https://cdn/x.png', '/wp/up/x.png']]),
      linkMap: new Map([['/about', '/about-2']]) as any,
    });
    expect(html).toContain('/wp/up/x.png');
    expect(html).toContain('/about-2');
  });
});
