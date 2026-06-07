import { describe, it, expect } from 'vitest';
import { splitRegionsDeep } from './split-regions-deep.js';

// Synthetic builder-style body: chrome buried inside a deep wrapper scaffold,
// with the content sections as children of an inner container.
const BODY =
  '<div id="SITE_CONTAINER"><div id="masterPage">' +
  '<header id="SITE_HEADER"><nav>menu</nav></header>' +
  '<div id="content"><div id="container">' +
  '<section id="s1">one</section>' +
  '<section id="s2">two</section>' +
  '<section id="s3">three</section>' +
  '</div></div>' +
  '<footer id="SITE_FOOTER"><p>foot</p></footer>' +
  '</div></div>';

describe('splitRegionsDeep', () => {
  const r = splitRegionsDeep(BODY);

  it('finds chrome nested deep in the wrapper scaffold', () => {
    expect(r.found).toBe(true);
    expect(r.headerHtml).toBe('<header id="SITE_HEADER"><nav>menu</nav></header>');
    expect(r.footerHtml).toBe('<footer id="SITE_FOOTER"><p>foot</p></footer>');
  });

  it('peels the content sections out of the middle', () => {
    expect(r.sectionsHtml).toHaveLength(3);
    expect(r.sectionsHtml[0]).toContain('<section id="s1">one</section>');
    expect(r.sectionsHtml[2]).toContain('<section id="s3">three</section>');
  });

  it('keeps the inner content wrappers in midBefore / midAfter', () => {
    expect(r.midBefore).toContain('<div id="content"><div id="container">');
    expect(r.midAfter).toContain('</div></div>');
  });

  it('is byte-lossless — concatenation reproduces the body exactly', () => {
    const recon =
      r.openWrap + r.headerHtml + r.midBefore + r.sectionsHtml.join('') + r.midAfter + r.footerHtml + r.closeWrap;
    expect(recon).toBe(BODY);
  });

  it('puts the opening/closing scaffold in openWrap / closeWrap', () => {
    expect(r.openWrap).toBe('<div id="SITE_CONTAINER"><div id="masterPage">');
    expect(r.closeWrap).toBe('</div></div>');
  });

  it('returns found=false when there is no semantic chrome', () => {
    const r2 = splitRegionsDeep('<div><section>x</section><section>y</section></div>');
    expect(r2.found).toBe(false);
  });

  it('matches a semantic <header>/<footer> without the Wix ids', () => {
    const r3 = splitRegionsDeep('<div><header>h</header><main><section>a</section></main><footer>f</footer></div>');
    expect(r3.found).toBe(true);
    expect(r3.headerHtml).toBe('<header>h</header>');
    expect(r3.footerHtml).toBe('<footer>f</footer>');
    expect(r3.sectionsHtml).toHaveLength(1);
  });
});
