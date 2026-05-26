import { describe, it, expect } from 'vitest';
import {
  reconstructPagePattern,
  stripChrome,
  escapeHtml,
  normalizeCopy,
  sanitizePatternHeaderField,
  sanitizeSvgAsset,
} from './page-reconstruct.js';
import { scanForInjection } from './validate-artifacts.js';
import type { SectionSpec } from './section-extract.js';

const WP = 'http://localhost:8883/wp-content/uploads/2026/05/';

function section(partial: Partial<SectionSpec>): SectionSpec {
  return {
    sectionIndex: 0,
    interactionModel: 'static',
    top: 0,
    height: 400,
    headings: [],
    bodyText: [],
    buttonLabels: [],
    images: [],
    icons: [],
    backgroundBrightness: 255,
    backgroundColor: 'rgb(255, 255, 255)',
    gradient: null,
    gradientSource: null,
    motionProfile: { motionClass: 'none', signals: [], animatedElements: 0 },
    dividerAbove: null,
    dividerBelow: null,
    layout: { containerWidth: 1200, padding: '0', childLayout: 'stack', columnCount: 1, gap: '0' },
    ...partial,
  } as SectionSpec;
}

function img(url: string, alt = '') {
  return { url, sourceUrl: url, alt, kind: 'img' as const, width: 800, height: 800 };
}

describe('escapeHtml', () => {
  it('escapes injection-relevant characters', () => {
    expect(escapeHtml('a & b <c> "d" \'e\'')).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &#039;e&#039;');
  });
});

describe('normalizeCopy', () => {
  it('collapses whitespace and strips zero-width/soft-hyphen noise', () => {
    expect(normalizeCopy('  foo­​   bar\n baz ')).toBe('foo bar baz');
  });
});

describe('stripChrome', () => {
  it('drops trailing footer (Shop/Support/Company) and newsletter sections', () => {
    const out = stripChrome([
      section({ sectionIndex: 0, headings: ['Hello'] }),
      section({ sectionIndex: 1, interactionModel: 'columns', headings: ['Shop', 'Support', 'Company'] }),
      section({ sectionIndex: 2, bodyText: ['Get some good SNOOZ.'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].headings).toEqual(['Hello']);
  });

  it('drops explicit footer/nav models from the ends only', () => {
    const out = stripChrome([
      section({ sectionIndex: 0, interactionModel: 'nav' }),
      section({ sectionIndex: 1, headings: ['Body'] }),
      section({ sectionIndex: 2, interactionModel: 'footer', headings: ['Shop', 'Support', 'Company'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].headings).toEqual(['Body']);
  });

  it('drops a trailing footer detected by a generic copyright/attribution line', () => {
    // swiftlumber's footer: nav labels + contact + "© 2026 Website by …". Not the
    // getsnooz Shop/Support/Company shape, so it needs the generic copyright signal
    // — otherwise the page shows two footers (this section + the theme footer part).
    const out = stripChrome([
      section({ sectionIndex: 0, interactionModel: 'animated-cover', headings: ['Hero'] }),
      section({ sectionIndex: 1, headings: ['Body'] }),
      section({
        sectionIndex: 2,
        interactionModel: 'columns',
        bodyText: ['PRODUCTS', 'GALLERY', 'CALL US', '© 2026 Website by Tokuda Technology'],
      }),
    ]);
    expect(out.map((s) => s.sectionIndex)).toEqual([0, 1]);
  });

  it('preserves a mid-page dark content band that is not the footer', () => {
    const out = stripChrome([
      section({ sectionIndex: 0, headings: ['Top'] }),
      section({
        sectionIndex: 1,
        backgroundColor: 'rgb(47, 56, 78)',
        headings: ['100 Night Happiness Guarantee'],
      }),
      section({ sectionIndex: 2, interactionModel: 'footer', headings: ['Shop', 'Support', 'Company'] }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].headings).toEqual(['100 Night Happiness Guarantee']);
  });
});

describe('reconstructPagePattern', () => {
  const opts = { patternSlug: 'demo-replica/page-x', title: 'Page — X' };

  it('emits a PHP doc-comment header with the slug and title', () => {
    const r = reconstructPagePattern([section({ headings: ['Hello world'] })], opts);
    expect(r.php).toContain('Title: Page — X');
    expect(r.php).toContain('Slug: demo-replica/page-x');
    expect(r.php).toContain('Inserter: false');
  });

  it('emits verbatim headings as wp:heading and tracks them as expectedText', () => {
    const r = reconstructPagePattern([section({ headings: ['Shop All', 'Simple products'] })], opts);
    expect(r.php).toContain('>Shop All</h1>');
    expect(r.php).toContain('>Simple products</h2>');
    expect(r.expectedText).toContain('Shop All');
    expect(r.expectedText).toContain('Simple products');
  });

  it('emits body prose verbatim and tracks it as bodyText', () => {
    const r = reconstructPagePattern(
      [section({ headings: ['H'], bodyText: ['A good night of sleep matters.'] })],
      opts,
    );
    expect(r.php).toContain('A good night of sleep matters.');
    expect(r.bodyText).toContain('A good night of sleep matters.');
  });

  it('references WP-library image URLs and lists them as expectedAssets', () => {
    const url = `${WP}hero.jpg`;
    const r = reconstructPagePattern(
      [section({ interactionModel: 'media-text', headings: ['H'], bodyText: ['B'], images: [img(url, 'Hero')] })],
      opts,
    );
    expect(r.php).toContain(`src="${url}"`);
    expect(r.php).toContain('alt="Hero"');
    expect(r.expectedAssets).toContain(url);
  });

  it('emits a missing-media placeholder and flag for a non-WP (CDN) image', () => {
    const cdn = 'https://cdn.shopify.com/s/files/x.jpg';
    const r = reconstructPagePattern(
      [section({ interactionModel: 'media-text', headings: ['H'], images: [img(cdn)] })],
      opts,
    );
    expect(r.php).toContain('image unavailable');
    expect(r.php).not.toContain('cdn.shopify.com');
    expect(r.provenanceFlags.join(' ')).toContain('not in WP library');
  });

  it('renders verbatim reviews with stars/quote/author and never synthesizes', () => {
    const r = reconstructPagePattern(
      [
        section({
          interactionModel: 'review-grid',
          headings: ['Loved by Thousands'],
          reviews: [
            { category: null, stars: 5, quote: '"It just works."', author: '- AVA S.' },
          ],
        }),
      ],
      opts,
    );
    expect(r.php).toContain('It just works.');
    expect(r.php).toContain('- AVA S.');
    expect(r.php).toContain('★★★★★');
    expect(r.bodyText).toContain('"It just works."');
  });

  it('renders a dark-background review band on the inverse surface with light text', () => {
    const r = reconstructPagePattern(
      [
        section({
          interactionModel: 'review-grid',
          headings: ['Loved by Thousands'],
          backgroundColor: 'rgb(47, 57, 78)',
          backgroundBrightness: 56,
          reviews: [{ category: null, stars: 5, quote: '"It just works."', author: '- AVA S.' }],
        }),
      ],
      opts,
    );
    expect(r.php).toContain('has-surface-inverse-background-color');
    // Quote text is light (inverse), not dark — readable on navy.
    expect(r.php).toContain('has-text-inverse-color');
    expect(r.php).not.toContain('has-text-default-color');
    // Content still verbatim.
    expect(r.php).toContain('It just works.');
    expect(r.php).toContain('★★★★★');
  });

  it('flags an empty review band with no captured copy as a placeholder, never invents', () => {
    const r = reconstructPagePattern(
      [section({ interactionModel: 'review-grid', headings: ['Reviews'], reviews: [], bodyText: [] })],
      opts,
    );
    expect(r.php).toContain('[reviews not captured]');
    expect(r.provenanceFlags.join(' ')).toContain('no verbatim reviews captured');
  });

  it('renders captured bodyText verbatim when a review band lacks structured reviews[]', () => {
    const quote = 'I did not realize how soothing white noise could be at any volume.';
    const r = reconstructPagePattern(
      [
        section({
          interactionModel: 'review-grid',
          headings: ['Loved by Thousands'],
          reviews: [],
          bodyText: ['4.8/5 rating - 5,209 reviews', quote, 'Vicki E.'],
        }),
      ],
      opts,
    );
    expect(r.php).toContain(quote);
    expect(r.php).toContain('Vicki E.');
    expect(r.php).not.toContain('[reviews not captured]');
    // No fabrication flag when real copy was present.
    expect(r.provenanceFlags.join(' ')).not.toContain('no verbatim reviews captured');
    expect(r.bodyText).toContain(quote);
  });

  it('renders product-card rows with title + desc + button per card', () => {
    const r = reconstructPagePattern(
      [
        section({
          interactionModel: 'product-card-row',
          headings: ['SNOOZ Original', 'SNOOZ Go 2'],
          bodyText: ['Best Seller', 'Travel ready'],
          buttonLabels: ['Shop Now', 'Shop Now'],
          images: [img(`${WP}a.jpg`), img(`${WP}b.jpg`)],
        }),
      ],
      opts,
    );
    expect(r.php).toContain('>SNOOZ Original</h3>');
    expect(r.php).toContain('>SNOOZ Go 2</h3>');
    expect(r.php.match(/wp-block-button__link/g) || []).toHaveLength(2);
    expect(r.expectedText).toContain('Shop Now');
  });

  it('renders re-captured FAQ pairs as wp:details accordions, verbatim', () => {
    const s = section({ interactionModel: 'static', headings: ['Frequently Asked Questions'] }) as SectionSpec & {
      faqs?: { question: string; answer: string }[];
    };
    s.faqs = [{ question: 'Why recall Breez?', answer: 'Because the connector can corrode.' }];
    const r = reconstructPagePattern([s], opts);
    expect(r.php).toContain('<!-- wp:details -->');
    expect(r.php).toContain('<summary>Why recall Breez?</summary>');
    expect(r.php).toContain('Because the connector can corrode.');
    expect(r.expectedText).toContain('Why recall Breez?');
    expect(r.bodyText).toContain('Because the connector can corrode.');
  });

  it('emits a placeholder + flag for a FAQ question whose answer was not captured', () => {
    const s = section({ interactionModel: 'static', headings: ['FAQ'] }) as SectionSpec & {
      faqs?: { question: string; answer: string }[];
    };
    s.faqs = [{ question: 'Hydrated question?', answer: '' }];
    const r = reconstructPagePattern([s], opts);
    expect(r.php).toContain('<summary>Hydrated question?</summary>');
    expect(r.php).toContain('[answer not captured]');
    expect(r.provenanceFlags.join(' ')).toContain('not captured');
  });

  it('bounds card count by image count so responsive-duplicate headings do not spawn phantom cards', () => {
    // Replo captures desktop+mobile DOM: 5 features each appearing twice (+1) but only 5 images.
    const r = reconstructPagePattern(
      [
        section({
          interactionModel: 'project-card-grid',
          headings: ['A', 'B', 'C', 'D', 'E', 'A', 'B', 'C', 'D', 'E', 'A'],
          bodyText: ['da', 'db', 'dc', 'dd', 'de'],
          images: [img(`${WP}1.jpg`), img(`${WP}2.jpg`), img(`${WP}3.jpg`), img(`${WP}4.jpg`), img(`${WP}5.jpg`)],
        }),
      ],
      opts,
    );
    // Exactly 5 cards, all backed by a real image — no "[image unavailable]" placeholders.
    expect(r.php).not.toContain('image unavailable');
    expect(r.provenanceFlags).toHaveLength(0);
    expect((r.php.match(/wp-block-image/g) || []).length).toBe(5);
  });

  it('drops footer chrome so the pattern has no Shop/Support/Company nav', () => {
    const r = reconstructPagePattern(
      [
        section({ sectionIndex: 0, headings: ['Real content'] }),
        section({ sectionIndex: 1, interactionModel: 'footer', headings: ['Shop', 'Support', 'Company'] }),
      ],
      opts,
    );
    expect(r.php).toContain('Real content');
    expect(r.php).not.toContain('>Support</');
    expect(r.sectionsRendered).toBe(1);
  });

  it('skips a decorative (sub-200px) lead image in a text band but keeps a real photo', () => {
    // A 144x144 quote-mark glyph must NOT become the hero lead image...
    const deco = reconstructPagePattern(
      [section({ interactionModel: 'cover-with-headline', headings: ['Hero'], images: [{ url: `${WP}quote.png`, sourceUrl: `${WP}quote.png`, alt: '', kind: 'img', width: 144, height: 144 }] })],
      opts,
    );
    expect(deco.php).not.toContain('quote.png');
    expect(deco.expectedAssets).not.toContain(`${WP}quote.png`);
    // ...but a real 800x800 photo is rendered.
    const photo = reconstructPagePattern(
      [section({ interactionModel: 'cover-with-headline', headings: ['Hero'], images: [img(`${WP}hero.jpg`, 'Hero')] })],
      opts,
    );
    expect(photo.php).toContain(`${WP}hero.jpg`);
  });

  it('renders a uniform multi-cell grid (icon-feature row) as columns with all cell titles + body', () => {
    const s = section({
      interactionModel: 'columns',
      headings: ['One device.', 'Three bedtime essentials.'],
    }) as SectionSpec;
    s.cells = [
      { heading: 'Built-In Sounds', body: ['No Subscriptions Ever'], image: null, icon: null, button: null },
      { heading: 'Bluetooth Speaker', body: ['Listen to Anything'], image: null, icon: null, button: null },
      { heading: 'Night Light', body: ['Optional Soft Light'], image: null, icon: null, button: null },
    ];
    const r = reconstructPagePattern([s], opts);
    // Band headings render above the grid; all three cell titles recovered as h3.
    expect(r.php).toContain('>One device.</h2>');
    expect(r.php).toContain('>Three bedtime essentials.</h3>');
    expect(r.php).toContain('>Built-In Sounds</h3>');
    expect(r.php).toContain('>Bluetooth Speaker</h3>');
    expect(r.php).toContain('>Night Light</h3>');
    expect(r.php).toContain('Optional Soft Light');
    // Three columns, one per cell (count opening column comments only).
    expect((r.php.match(/<!-- wp:column /g) || []).length).toBe(3);
  });

  it('emits cell icons as theme SVG assets referenced via get_theme_file_uri (no wp:html)', () => {
    const s = section({ interactionModel: 'columns', headings: ['Three bedtime essentials.'] }) as SectionSpec;
    s.cells = [
      { heading: 'Built-In Sounds', body: ['No Subscriptions Ever'], image: null, icon: { kind: 'svg', markup: '<svg viewBox="0 0 24 24"><path d="M3 9h4l5-5v16l-5-5H3z"/></svg>', width: 52, height: 52 }, button: null },
      { heading: 'Night Light', body: ['Optional Soft Light'], image: null, icon: { kind: 'svg', markup: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>', width: 52, height: 52 }, button: null },
    ];
    const r = reconstructPagePattern([s], opts);
    // Two icon assets registered for the driver to write...
    expect(r.iconAssets).toHaveLength(2);
    expect(r.iconAssets[0].path).toBe('assets/icon-0.svg');
    expect(r.iconAssets[0].svg).toContain('<svg');
    // ...and referenced via the gate-sanctioned get_theme_file_uri form (not inlined).
    expect(r.php).toContain("get_theme_file_uri('assets/icon-0.svg')");
    expect(r.php).not.toMatch(/<svg/); // never inlined into block markup
    // The whole pattern passes the injection scan (the PHP form is sanctioned).
    expect(scanForInjection(r.php)).toEqual([]);
  });

  it('sanitizes a malicious cell-icon SVG before writing it as an asset', () => {
    const s = section({ interactionModel: 'columns', headings: ['Features'] }) as SectionSpec;
    const evil = '<svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><path d="M0 0h24v24H0z"/></svg>';
    s.cells = [
      { heading: 'A', body: ['a'], image: null, icon: { kind: 'svg', markup: evil, width: 40, height: 40 }, button: null },
      { heading: 'B', body: ['b'], image: null, icon: { kind: 'svg', markup: evil, width: 40, height: 40 }, button: null },
    ];
    const r = reconstructPagePattern([s], opts);
    expect(r.iconAssets.length).toBeGreaterThan(0);
    for (const a of r.iconAssets) {
      expect(a.svg).not.toMatch(/<script/i);
      expect(a.svg).not.toMatch(/onload/i);
    }
  });

  it('sanitizeSvgAsset strips SMIL animation + external/script hrefs (direct-navigation XSS vectors)', () => {
    // SMIL <set> setting an event handler — must be removed (on*= strip misses it).
    expect(sanitizeSvgAsset('<svg><set attributeName="onload" to="alert(1)"/></svg>')).not.toMatch(/<set|onload/i);
    expect(sanitizeSvgAsset('<svg><animate attributeName="onbegin" to="x"/></svg>')).not.toMatch(/<animate|onbegin/i);
    // External href on <image>/<a>/<use> — removed; local #refs + data:image kept.
    expect(sanitizeSvgAsset('<svg><image href="https://evil.example/x"/></svg>')).not.toMatch(/https?:/i);
    expect(sanitizeSvgAsset('<svg><a xlink:href="javascript:alert(1)">x</a></svg>')).not.toMatch(/javascript:/i);
    expect(sanitizeSvgAsset('<svg><use href="#local-glyph"/></svg>')).toContain('#local-glyph');
    // A normal icon is untouched.
    expect(sanitizeSvgAsset('<svg viewBox="0 0 24 24"><path d="M3 9h4"/></svg>')).toContain('<path');
  });

  it('renders a colorful light-tinted section on the raised surface (mint band), white on default', () => {
    // A mint-tinted band (rgba(158,228,211,...), brightness ~205) -> surface-raised.
    const tinted = reconstructPagePattern(
      [section({ interactionModel: 'static', headings: ['Tinted'], backgroundColor: 'rgba(158, 228, 211, 0.3)', backgroundBrightness: 205 })],
      opts,
    );
    expect(tinted.php).toContain('has-surface-raised-background-color');
    // A white band stays default (no raised background).
    const white = reconstructPagePattern(
      [section({ interactionModel: 'static', headings: ['White'], backgroundColor: 'rgb(255, 255, 255)', backgroundBrightness: 255 })],
      opts,
    );
    expect(white.php).not.toContain('has-surface-raised-background-color');
    // A neutral light grey is NOT treated as a tint.
    const grey = reconstructPagePattern(
      [section({ interactionModel: 'static', headings: ['Grey'], backgroundColor: 'rgb(238, 238, 238)', backgroundBrightness: 238 })],
      opts,
    );
    expect(grey.php).not.toContain('has-surface-raised-background-color');
  });

  it('renders a cover-with-headline hero WITH a lead photo as a 2-column media-text', () => {
    const withPhoto = reconstructPagePattern(
      [
        section({
          interactionModel: 'cover-with-headline',
          headings: ['Your Go-Anywhere Sound Machine', '$59.99'],
          bodyText: ['A travel-ready 3-in-1.'],
          images: [
            { url: `${WP}quote.png`, sourceUrl: `${WP}quote.png`, alt: '', kind: 'img', width: 144, height: 144 },
            img(`${WP}hero.jpg`, 'Hero photo'),
          ],
        }),
      ],
      opts,
    );
    // Two-column band with the real photo (not the 144px glyph) in the media column.
    expect(withPhoto.php).toContain('<!-- wp:columns');
    expect(withPhoto.php).toContain(`${WP}hero.jpg`);
    expect(withPhoto.php).not.toContain('quote.png');
    // A photo-less cover (e.g. a text sale banner) stays a centered text band.
    const banner = reconstructPagePattern(
      [section({ interactionModel: 'cover-with-headline', headings: ['SUMMER SALE'], images: [] })],
      opts,
    );
    expect(banner.php).not.toContain('<!-- wp:columns');
    expect(banner.php).toContain('>SUMMER SALE</h1>');
  });

  it('renders feature cells with a card background as distinct token-colored cards', () => {
    const s = section({ interactionModel: 'columns', headings: ['WHY DO BUSINESS WITH US', 'The Advantage'] }) as SectionSpec;
    const noFillIcon = { kind: 'svg' as const, markup: '<svg viewBox="0 0 24 24"><path d="M3 9h4"/></svg>', width: 48, height: 48 };
    s.cells = [
      { heading: 'EXPERIENCE', body: ['100 years in lumber.'], image: null, icon: noFillIcon, button: null, background: 'rgb(102, 101, 88)', radius: 10 },
      { heading: 'PROXIMITY', body: ['Near three major ports.'], image: null, icon: noFillIcon, button: null, background: 'rgb(102, 101, 88)', radius: 10 },
    ];
    const r = reconstructPagePattern([s], {
      patternSlug: 'demo-replica/page-x',
      title: 'X',
      paletteTokens: [
        { slug: 'surface-base', hex: '#ffffff' },
        { slug: 'surface-raised', hex: '#666558' },
        { slug: 'surface-inverse', hex: '#175236' },
      ],
    });
    // Each card maps to the nearest token (surface-raised taupe), rounded, light text.
    expect((r.php.match(/has-surface-raised-background-color/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(r.php).toContain('border-radius:10px');
    expect(r.php).toContain('has-text-inverse-color'); // dark card → light text
    // The (fill-less) icon glyph is recolored white so it's visible on the dark card.
    expect(r.iconAssets.length).toBe(2);
    expect(r.iconAssets.every((a) => /fill="#ffffff"/.test(a.svg))).toBe(true);
    // Without paletteTokens, the same cells render as plain columns (no card bg).
    const plain = reconstructPagePattern([s], { patternSlug: 'demo-replica/page-x', title: 'X' });
    expect(plain.php).not.toContain('has-surface-raised-background-color');
  });

  it('renders an animated-cover hero as a wp:cover with the photo + overlaid white text', () => {
    const wideHero = { url: `${WP}yard.jpg`, sourceUrl: `${WP}yard.jpg`, alt: 'lumber yard', kind: 'img' as const, width: 1440, height: 796 };
    const r = reconstructPagePattern(
      [section({ interactionModel: 'animated-cover', headings: ['Over 100 Years'], bodyText: ['We collaborate.'], buttonLabels: ['TALK TO US'], images: [wideHero] })],
      opts,
    );
    expect(r.php).toContain('<!-- wp:cover');
    expect(r.php).toContain('wp-block-cover__image-background');
    expect(r.php).toContain(`${WP}yard.jpg`);
    expect(r.php).toContain('>Over 100 Years</h1>');
    expect(r.php).toContain('has-text-inverse-color'); // overlaid white text
    expect(r.expectedAssets).toContain(`${WP}yard.jpg`);
    // No usable full-bleed photo → falls back to a centered text band.
    const noImg = reconstructPagePattern([section({ interactionModel: 'animated-cover', headings: ['Hi'] })], opts);
    expect(noImg.php).not.toContain('<!-- wp:cover');
  });

  it('renders a many-image gallery as a wp:gallery grid, not a 25-wide flex row', () => {
    const imgs = Array.from({ length: 25 }, (_, i) => img(`${WP}g${i}.jpg`, `img ${i}`));
    const r = reconstructPagePattern([section({ interactionModel: 'gallery', headings: ['Gallery'], images: imgs })], opts);
    expect(r.php).toContain('<!-- wp:gallery');
    expect(r.php).toContain('columns-4');
    expect(r.php).toContain('is-gallery-scroller');
    // 25 images become 25 wp:image figures inside ONE gallery, not 25 wp:columns.
    expect((r.php.match(/<!-- wp:image /g) || []).length).toBe(25);
    expect((r.php.match(/<!-- wp:column /g) || []).length).toBe(0);
    expect(r.expectedAssets).toHaveLength(25);
  });

  it('does NOT route to a cell grid when fewer than 2 cells carry a title + body (e.g. a hero split)', () => {
    const s = section({ interactionModel: 'cover-with-headline', headings: ['Hero'], bodyText: ['Sub'] }) as SectionSpec;
    // A 2-up hero: one text cell (title+body), one image cell (no title/body).
    s.cells = [
      { heading: 'Hero', body: ['Sub'], image: null, icon: null, button: null },
      { heading: null, body: [], image: img(`${WP}p.jpg`), icon: null, button: null },
    ];
    const r = reconstructPagePattern([s], opts);
    // Falls through to the text band (single h1), not a column grid.
    expect(r.php).toContain('>Hero</h1>');
    expect((r.php.match(/wp:columns\b/g) || []).length).toBe(0);
  });

  it('produces only WordPress block comments (no raw PHP/script/handlers in body)', () => {
    const r = reconstructPagePattern(
      [section({ headings: ['Hi <script>'], bodyText: ['onerror=alert(1)'] })],
      opts,
    );
    const body = r.php.split('?>\n')[1];
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<\?php/);
    // The dangerous chars are escaped, not emitted raw.
    expect(body).toContain('&lt;script&gt;');
  });

  it('neutralizes a comment-breakout title so the doc-comment header cannot inject PHP', () => {
    // A source-derived title crafted to close the doc-comment early, run PHP,
    // and re-open a comment that swallows the rest through the real `*/?>`.
    const malicious = '*/ system($_GET[0]); /*';
    const r = reconstructPagePattern([section({ headings: ['Hello'] })], {
      patternSlug: 'demo-replica/page-x',
      title: malicious,
    });
    // The comment-breakout delimiters are stripped, so the injected text is left
    // inert inside a properly-closed doc-comment (it never closes the comment to
    // reach executable context). Exactly one `*/` (the real header close) remains.
    expect(r.php).not.toContain('*/ system');
    expect(r.php).not.toContain('/*\n');
    expect((r.php.match(/\*\//g) || []).length).toBe(1);
    // ...and the whole pattern passes the injection scan (no smuggled PHP).
    expect(scanForInjection(r.php)).toEqual([]);
  });
});

describe('sanitizePatternHeaderField', () => {
  it('strips comment and PHP-tag delimiters and collapses to one line', () => {
    expect(sanitizePatternHeaderField('*/ evil(); /*')).toBe('evil();');
    // Only the `<?` / `?>` delimiters are stripped (so `<?php` leaves `php`); the
    // point is no open/close PHP tag survives, not lexical reconstruction.
    expect(sanitizePatternHeaderField('a <?php b ?> c')).toBe('a php b  c');
    expect(sanitizePatternHeaderField('line1\nline2')).toBe('line1 line2');
  });

  it('leaves a normal title/slug unchanged', () => {
    expect(sanitizePatternHeaderField('Page — X')).toBe('Page — X');
    expect(sanitizePatternHeaderField('demo-replica/page-x')).toBe('demo-replica/page-x');
  });
});
