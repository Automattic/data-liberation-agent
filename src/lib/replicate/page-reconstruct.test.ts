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
    // a page-builder footer: nav labels + contact + "© 2026 Website by …". Not the
    // getsnooz Shop/Support/Company shape, so it needs the generic copyright signal
    // — otherwise the page shows two footers (this section + the theme footer part).
    const out = stripChrome([
      section({ sectionIndex: 0, interactionModel: 'animated-cover', headings: ['Hero'] }),
      section({ sectionIndex: 1, headings: ['Body'] }),
      section({
        sectionIndex: 2,
        interactionModel: 'columns',
        bodyText: ['PRODUCTS', 'GALLERY', 'CALL US', '© 2026 Website by Acme Studio'],
      }),
    ]);
    expect(out.map((s) => s.sectionIndex)).toEqual([0, 1]);
  });

  it('strips a leading header-chrome tile (short nav+contact band) captured as static', () => {
    // Flat-Wix pages get captured as <section> tiles; the header tile arrives as
    // a short `static` band of nav links + contact, not model `nav`. It must be
    // stripped (the theme supplies its own header) or it renders above content.
    const out = stripChrome([
      section({
        sectionIndex: 0,
        interactionModel: 'static',
        height: 116,
        headings: ['Acme Co 555-0142'],
        bodyText: ['PRODUCTS', 'GALLERY', 'JOB OPPORTUNITIES', 'ABOUT US'],
      }),
      section({ sectionIndex: 1, height: 800, headings: ['Premium Hardwood'] }),
    ]);
    expect(out.map((s) => s.sectionIndex)).toEqual([1]);
  });

  it('does NOT strip a tall leading content band that happens to have short lines', () => {
    const out = stripChrome([
      section({ sectionIndex: 0, height: 520, headings: ['Hero'], bodyText: ['A', 'B', 'C'] }),
      section({ sectionIndex: 1, height: 400, headings: ['Body'] }),
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

  it('reproduces the source heading SIZES (responsive clamp) so eyebrow/headline are not inverted', () => {
    const s = section({ headings: ['WHY DO BUSINESS WITH US', 'The Premium Advantage'] }) as SectionSpec;
    s.headingSizes = [16, 55]; // tiny eyebrow label, large headline
    const r = reconstructPagePattern([s], opts);
    // Each heading carries a clamp() whose max equals the captured px.
    expect(r.php).toMatch(/font-size:clamp\([^)]*16px\)/); // eyebrow stays 16px
    expect(r.php).toMatch(/font-size:clamp\([^)]*55px\)/); // headline 55px
    // Headings without a captured size emit no explicit font-size (theme scale).
    const noSize = reconstructPagePattern([section({ headings: ['Plain'] })], opts);
    expect(noSize.php).not.toContain('font-size:clamp');
  });

  it('reproduces measured section vertical padding (whitespace) as responsive CSS', () => {
    // section-extract measures padding geometrically (content-box vs section-box)
    // because page-builder sections report padding:0. The renderer must trust the
    // measured px over the theme preset so source whitespace is faithful.
    const s = section({ headings: ['Spacious'] }) as SectionSpec;
    s.layout = { ...s.layout, padTopPx: 120, padBottomPx: 140 };
    const r = reconstructPagePattern([s], opts);
    // Responsive clamp whose max equals the captured px, on both top and bottom.
    expect(r.php).toMatch(/padding-top:clamp\(\d+px, [\d.]+vw, 120px\)/);
    expect(r.php).toMatch(/padding-bottom:clamp\(\d+px, [\d.]+vw, 140px\)/);
    // The preset spacing is NOT used for the measured vertical edges.
    expect(r.php).not.toMatch(/padding-top:var\(--wp--preset--spacing--60\)/);
  });

  it('emits a near-zero measured padding literally (no invalid clamp) and falls back to preset when unmeasured', () => {
    // Small measured values can't form a valid clamp (min would exceed max), so
    // they emit as a literal px. A full-bleed source band (≈0 padding) stays flush.
    const tight = section({ headings: ['Flush'] }) as SectionSpec;
    tight.layout = { ...tight.layout, padTopPx: 8, padBottomPx: 0 };
    const t = reconstructPagePattern([tight], opts);
    expect(t.php).toContain('padding-top:8px');
    expect(t.php).toContain('padding-bottom:0px');
    // No measurement → theme spacing preset (back-compat).
    const plain = reconstructPagePattern([section({ headings: ['Default'] })], opts);
    expect(plain.php).toMatch(/padding-top:var\(--wp--preset--spacing--60\)/);
  });

  it('honors the source text alignment instead of hard-centering (left source → left output)', () => {
    // the source left-aligns every heading; the renderer must not center them.
    const left = section({ headings: ['The Premium Advantage'], bodyText: ['Body copy.'], buttonLabels: ['SEE ALL'] }) as SectionSpec;
    left.textAlign = 'left';
    const lr = reconstructPagePattern([left], opts);
    expect(lr.php).not.toContain('has-text-align-center');
    expect(lr.php).toContain('is-content-justification-left'); // button row follows
    // A genuinely centered source band still centers.
    const ctr = section({ headings: ['Centered'], buttonLabels: ['GO'] }) as SectionSpec;
    ctr.textAlign = 'center';
    const cr = reconstructPagePattern([ctr], opts);
    expect(cr.php).toContain('has-text-align-center');
    expect(cr.php).toContain('is-content-justification-center');
  });

  it('preserves a body line that repeats a heading (the source genuinely shows both)', () => {
    const s = section({ headings: ['Premium Hardwood'], bodyText: ['Premium Hardwood', 'Real prose here.'] });
    const r = reconstructPagePattern([s], opts);
    // Heading tags and <p> are disjoint, visible-only captures — an exact match
    // means the source renders BOTH (e.g. a large subheading AND an identical
    // paragraph), so we keep both rather than lose content: the text appears
    // twice, once as a heading block and once as a paragraph block.
    expect((r.php.match(/Premium Hardwood/g) || []).length).toBe(2);
    expect(r.php).toContain('wp:heading');
    expect(r.php).toContain('wp:paragraph');
    expect(r.php).toContain('Real prose here.');
  });

  it('renders a 3+ same-scale non-lead image row as a gallery below the lead', () => {
    const s = section({
      headings: ['Products'],
      images: [
        img(`${WP}kiln.png`, 'kiln'), // lead (big)
        img(`${WP}s1.png`), img(`${WP}s2.png`), img(`${WP}s3.png`), // sample strip
      ],
    });
    // shrink the samples below the lead threshold but above the gallery floor
    (s.images[1] as { width: number; height: number }).width = 146;
    (s.images[1] as { width: number; height: number }).height = 146;
    (s.images[2] as { width: number; height: number }).width = 146;
    (s.images[2] as { width: number; height: number }).height = 146;
    (s.images[3] as { width: number; height: number }).width = 146;
    (s.images[3] as { width: number; height: number }).height = 146;
    const r = reconstructPagePattern([s], opts);
    expect(r.php).toContain('wp:gallery');
    expect(r.php).toContain('s1.png');
    expect(r.php).toContain('s3.png');
  });

  it('does not sprout a gallery for a text band with fewer than 3 extra images', () => {
    const s = section({ headings: ['Story'], images: [img(`${WP}lead.png`), img(`${WP}one.png`)] });
    const r = reconstructPagePattern([s], opts);
    expect(r.php).not.toContain('wp:gallery');
  });

  it('renders 1–2 extra content images individually instead of dropping them', () => {
    // A merged media-text section with a 2nd photo: both images must appear (no
    // gallery, but no dropped content either). Mirrors the about-us case where the
    // extractor merged two stacked image-right rows into one 2-image section.
    const s = section({ interactionModel: 'static', headings: ['Journey'], bodyText: ['Body.'], images: [img(`${WP}first.png`), img(`${WP}second.png`)] });
    s.mediaLayout = 'image-right';
    const r = reconstructPagePattern([s], opts);
    expect(r.php).not.toContain('wp:gallery'); // 1 extra → not a gallery
    expect(r.php).toContain('first.png'); // lead (media column)
    expect(r.php).toContain('second.png'); // extra — rendered, NOT dropped
  });

  it('renders a captured side-by-side mediaLayout as a 2-column media-text with the correct side', () => {
    // image-left: the image column precedes the text column.
    const left = section({ interactionModel: 'static', headings: ['Headline'], bodyText: ['Body.'], images: [img(`${WP}photo.png`, 'p')] });
    left.mediaLayout = 'image-left';
    const lr = reconstructPagePattern([left], opts);
    expect(lr.php).toContain('wp:columns');
    expect(lr.php.indexOf('photo.png')).toBeLessThan(lr.php.indexOf('>Headline<'));
    // image-right: the text column precedes the image column.
    const right = section({ interactionModel: 'static', headings: ['Headline'], bodyText: ['Body.'], images: [img(`${WP}photo.png`, 'p')] });
    right.mediaLayout = 'image-right';
    const rr = reconstructPagePattern([right], opts);
    expect(rr.php.indexOf('>Headline<')).toBeLessThan(rr.php.indexOf('photo.png'));
  });

  it('does not route a gallery model to media-text even if mediaLayout is set', () => {
    const s = section({ interactionModel: 'gallery', headings: ['Gallery'], images: [img(`${WP}a.png`), img(`${WP}b.png`)] });
    s.mediaLayout = 'image-left';
    const r = reconstructPagePattern([s], opts);
    expect(r.php).toContain('wp:gallery'); // stays a gallery, not 2-col media-text
  });

  it('renders sub-200px cell images (team headshots) that the lead threshold would drop', () => {
    const cell = (heading: string, url: string) => ({
      heading,
      body: ['contact'],
      image: { url, sourceUrl: url, alt: '', kind: 'img' as const, width: 182, height: 193 },
      icon: null,
      button: null,
    });
    const s = section({ interactionModel: 'static', headings: ['Meet the Experts'] }) as SectionSpec & {
      cells: unknown[];
    };
    s.cells = [cell('Jane Doe', `${WP}al.png`), cell('John Smith', `${WP}shap.png`)];
    const r = reconstructPagePattern([s as SectionSpec], opts);
    expect(r.php).toContain('al.png');
    expect(r.php).toContain('shap.png');
  });

  it('un-flattens a static band with columnCount>=2 and heading-only cells into a real grid', () => {
    const headingOnly = (heading: string) => ({ heading, body: [], image: null, icon: null, button: null });
    const s = section({ interactionModel: 'static', headings: ['Our Process'] }) as SectionSpec & {
      cells: unknown[];
    };
    s.layout = { ...s.layout, columnCount: 3 };
    s.cells = [headingOnly('Discover'), headingOnly('Design'), headingOnly('Deliver')];
    const r = reconstructPagePattern([s as SectionSpec], opts);
    // Was flattened to a centered text band that dropped the card titles; now a real grid.
    expect(r.php).toContain('wp:columns');
    expect(r.php).toContain('Discover');
    expect(r.php).toContain('Design');
    expect(r.php).toContain('Deliver');
  });

  it('does NOT un-flatten heading-only cells when columnCount < 2 (the gate)', () => {
    const headingOnly = (heading: string) => ({ heading, body: [], image: null, icon: null, button: null });
    const s = section({ interactionModel: 'static', headings: ['Single'] }) as SectionSpec & {
      cells: unknown[];
    };
    s.layout = { ...s.layout, columnCount: 1 };
    s.cells = [headingOnly('A'), headingOnly('B')];
    const r = reconstructPagePattern([s as SectionSpec], opts);
    expect(r.php).not.toContain('wp:columns');
  });

  it('maps per-heading font-families to display vs body and reproduces line-height', () => {
    const s = section({ headings: ['Serif Headline', 'A SANS EYEBROW'] }) as SectionSpec;
    s.headingFamilies = ['libre baskerville', 'wfont_5499e3_8190210ff07446afa535fc100a057226'];
    s.headingLineHeights = [1.4, 1.4];
    const r = reconstructPagePattern([s], {
      patternSlug: 'demo-replica/page-x',
      title: 'X',
      fontFamilies: [
        { slug: 'display', family: 'libre baskerville, serif' },
        { slug: 'body', family: 'Inter, sans-serif' },
        { slug: 'wf-8190210ff07446afa535fc100', family: 'wf_8190210ff07446afa535fc100, sans-serif' },
      ],
    });
    // The serif headline → display; the sans eyebrow (a Wix handle WP won't render
    // reliably) → the body face by elimination. Line-height transferred.
    expect(r.php).toMatch(/has-display-font-family[^>]*>Serif Headline</);
    expect(r.php).toMatch(/has-body-font-family[^>]*>A SANS EYEBROW</);
    expect(r.php).toContain('line-height:1.4');
  });

  it('carries source image width + aspect (not blown up to the container, not forced 4:3)', () => {
    // A standalone lead photo keeps its source rendered width, capped responsively.
    const big = section({
      headings: ['Photo'],
      images: [{ url: `${WP}kiln.png`, sourceUrl: `${WP}kiln.png`, alt: '', kind: 'img', width: 532, height: 472 }],
    });
    const r = reconstructPagePattern([big], opts);
    expect(r.php).toContain('width:532px');
    expect(r.php).toContain('max-width:100%');
    expect(r.php).toContain('is-resized');
    // A row of SQUARE thumbnails → a gallery whose items carry the source square
    // size via core/image width+height ATTRIBUTES (which survive block-fixer
    // canonicalization), not a stripped inline flex/aspect-ratio. 149×149 stays
    // square (width===height), not the theme's default 4:3 / 220–380px cell.
    const sq = (n: number) => ({ url: `${WP}s${n}.png`, sourceUrl: `${WP}s${n}.png`, alt: '', kind: 'img' as const, width: 149, height: 149 });
    const g = reconstructPagePattern([section({ headings: ['Samples'], images: [sq(1), sq(2), sq(3)] })], opts);
    expect(g.php).toContain('wp:gallery');
    expect(g.php).toContain('"width":"149px"');
    expect(g.php).toContain('"height":"149px"');
    expect(g.php).toContain('size-large is-resized');
    // No stripped-on-canonicalization inline flex/aspect-ratio on gallery figures.
    expect(g.php).not.toContain('flex:0 0');
    expect(g.php).not.toContain('aspect-ratio:149');
  });

  it('gallery is a fixed-height row constrained to the (clamped) landscape image height', () => {
    // A same-scale landscape gallery (the routed case — the first big photo is the
    // lead, the 3+ same-scale extras below it become the gallery). 800×400 items
    // wider than the 560 clamp: row height = 400*560/800 = 280, each item width =
    // 280*800/400 = 560. Uniform box, source 2:1 aspect retained (560/280), never
    // stretched or forced to the theme's 4:3 cell.
    const wide = (n: number) => ({ url: `${WP}w${n}.png`, sourceUrl: `${WP}w${n}.png`, alt: '', kind: 'img' as const, width: 800, height: 400 });
    const g = reconstructPagePattern([section({ headings: ['Gallery'], images: [wide(1), wide(2), wide(3), wide(4)] })], opts);
    expect(g.php).toContain('wp:gallery');
    expect((g.php.match(/"height":"280px"/g) || []).length).toBe(3); // 3 extras share the row height
    expect((g.php.match(/"width":"560px"/g) || []).length).toBe(3); // width clamped at the basis
    expect(g.php).toContain('size-large is-resized');
  });

  it('reproduces a structured CTA: source button color (token), icon, and destination href', () => {
    const s = section({ interactionModel: 'static', headings: ['Hero'] }) as SectionSpec;
    s.buttons = [
      {
        label: 'GET A QUOTE',
        href: '/contact',
        background: 'rgb(255, 255, 255)',
        color: 'rgb(0, 0, 0)',
        icon: { kind: 'svg', markup: '<svg viewBox="0 0 24 24"><path d="M3 9h4"/></svg>', width: 18, height: 18 },
      },
    ];
    const r = reconstructPagePattern([s], {
      patternSlug: 'demo-replica/page-x',
      title: 'X',
      paletteTokens: [
        { slug: 'surface-base', hex: '#ffffff' },
        { slug: 'text-default', hex: '#000000' },
        { slug: 'accent-primary', hex: '#175236' },
      ],
    });
    expect(r.php).toContain('href="/contact"'); // destination link
    expect(r.php).toContain('has-surface-base-background-color'); // white → surface-base
    expect(r.php).not.toContain('has-accent-primary-background-color'); // NOT the default green
    expect(r.php).toContain("get_theme_file_uri('assets/icon-0.svg')"); // icon shipped + referenced
    expect(r.iconAssets.length).toBeGreaterThan(0);
    expect(r.php).toContain('GET A QUOTE</a>'); // label present
  });

  it('places the button icon on the source-captured side (after the label when iconAfter)', () => {
    const icon = { kind: 'svg' as const, markup: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>', width: 18, height: 18 };
    const after = section({ interactionModel: 'static', headings: ['H'] }) as SectionSpec;
    after.buttons = [{ label: 'NEXT', href: '/x', icon, iconAfter: true }];
    const ra = reconstructPagePattern([after], opts);
    // label precedes the icon <img> in the markup
    expect(ra.php.indexOf('NEXT')).toBeLessThan(ra.php.indexOf('icon-0.svg'));
    const before = section({ interactionModel: 'static', headings: ['H'] }) as SectionSpec;
    before.buttons = [{ label: 'BACK', href: '/y', icon, iconAfter: false }];
    const rb = reconstructPagePattern([before], opts);
    // icon precedes the label
    expect(rb.php.indexOf('icon-0.svg')).toBeLessThan(rb.php.indexOf('BACK'));
  });

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
    expect(grey.php).not.toContain('background-color:#');
  });

  it('paints an opaque COLORED tint band with its exact captured color (not the grey raised token)', () => {
    // A solid pale-blue band (rgb(232,239,241)) is painted edge-to-edge with its
    // real color instead of being approximated by surface-raised.
    const blue = reconstructPagePattern(
      [section({ interactionModel: 'static', headings: ['Pale blue band'], backgroundColor: 'rgb(232, 239, 241)', backgroundBrightness: 237 })],
      opts,
    );
    expect(blue.php).toContain('background-color:#e8eff1');
    expect(blue.php).toContain('has-background');
    expect(blue.php).not.toContain('has-surface-raised-background-color');
  });

  it('stacks sections gaplessly — every section zeroes its top/bottom margin', () => {
    // White gaps between sections come from WP's default top-level block-gap;
    // each reconstructed section must zero its margin so bands butt edge-to-edge.
    const r = reconstructPagePattern(
      [
        section({ interactionModel: 'static', headings: ['One'] }),
        section({ interactionModel: 'static', headings: ['Two'] }),
      ],
      opts,
    );
    expect(r.php).toContain('margin-top:0;margin-bottom:0;');
    expect(r.php).not.toMatch(/"margin":\{"top":"var:preset/);
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

  it('reproduces a card’s captured padding + left icon/text alignment (computed-style transfer)', () => {
    const s = section({ interactionModel: 'columns', headings: ['WHY'] }) as SectionSpec;
    s.textAlign = 'left';
    const icon = { kind: 'svg' as const, markup: '<svg viewBox="0 0 24 24"><path d="M3 9h4"/></svg>', width: 48, height: 48 };
    const base = {
      body: ['desc'],
      image: null,
      icon,
      button: null,
      background: 'rgb(102, 101, 88)',
      radius: 10,
      padding: { top: 34, right: 45, bottom: 96, left: 45 },
      align: 'left' as const,
      iconAlign: 'left' as const,
    };
    s.cells = [{ heading: 'EXPERIENCE', ...base }, { heading: 'PROXIMITY', ...base }];
    const r = reconstructPagePattern([s], {
      patternSlug: 'demo-replica/page-x',
      title: 'X',
      paletteTokens: [{ slug: 'surface-raised', hex: '#666558' }],
    });
    // Captured card padding reproduced as a responsive clamp (max == captured px).
    // (The section wrapper keeps the preset for its own horizontal padding.)
    expect(r.php).toMatch(/padding-left:clamp\([^)]*45px\)/);
    expect(r.php).toMatch(/padding-top:clamp\([^)]*34px\)/);
    // Icon follows the card alignment (left) — not the old hard-center.
    expect(r.php).not.toContain('aligncenter');
    // Card text is left-aligned (no centered text).
    expect(r.php).not.toContain('has-text-align-center');
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

  it('renderReviewGrid carries the captured heading size + line-height (not the theme preset)', () => {
    const r = reconstructPagePattern([section({ interactionModel: 'review-grid', headings: ['What People Say'], headingSizes: [24], headingLineHeights: [1.4], headingFamilies: ['display'], bodyText: ['Great service', 'Loved it', 'Recommend'] })], opts);
    expect(r.php).toMatch(/"fontSize":"[^"]*24px|font-size:[^;]*24px/);
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

describe('reconstructPagePattern — coverage-gated core/html fallback', () => {
  const opts = { patternSlug: 'demo-replica/page-x', title: 'Page — X' };

  it('emits a verbatim core/html island when the structured render drops a captured image', () => {
    // A 150px image is below MIN_LEAD_IMAGE_PX (200), so renderTextBand drops it —
    // a silent content loss. With sectionHtml present, we fall back to the island.
    const s = section({
      headings: ['Our Story'],
      images: [{ url: '/wp-content/uploads/team.jpg', sourceUrl: 'https://cdn.test/team.jpg', alt: '', kind: 'img', width: 150, height: 150 }],
      sectionHtml: '<section><h2>Our Story</h2><img src="/wp-content/uploads/team.jpg" alt=""/></section>',
    } as Partial<SectionSpec>);
    const r = reconstructPagePattern([s], opts);
    expect(r.body).toContain('<!-- wp:html -->');
    expect(r.body).toContain('/wp-content/uploads/team.jpg'); // the dropped image is preserved
    expect(r.provenanceFlags.some((f) => /html-fallback#0/.test(f))).toBe(true);
  });

  it('keeps structured blocks when the render covers the captured content', () => {
    const s = section({
      headings: ['Our Story'],
      images: [{ url: '/wp-content/uploads/big.jpg', sourceUrl: 'https://cdn.test/big.jpg', alt: '', kind: 'img', width: 800, height: 600 }],
      sectionHtml: '<section><h2>Our Story</h2><img src="/wp-content/uploads/big.jpg"/></section>',
    } as Partial<SectionSpec>);
    const r = reconstructPagePattern([s], opts);
    expect(r.body).not.toContain('<!-- wp:html -->');
    expect(r.provenanceFlags.some((f) => /html-fallback/.test(f))).toBe(false);
  });

  it('prefers the styled snapshot and flags html-fallback-styled when styledHtml is present (R4b floor)', () => {
    // Same silent loss as above, but the section carries a self-contained styled
    // snapshot — R4b emits THAT (renders styled), not the bare sectionHtml.
    const s = section({
      headings: ['Our Story'],
      images: [{ url: '/wp-content/uploads/team.jpg', sourceUrl: 'https://cdn.test/team.jpg', alt: '', kind: 'img', width: 150, height: 150 }],
      sectionHtml: '<section><h2>Our Story</h2><img src="/wp-content/uploads/team.jpg" alt=""/></section>',
      styledHtml:
        '<section style="display:flex;background-color:rgb(10,20,30)">' +
        '<h2 style="color:rgb(255,255,255)">Our Story</h2>' +
        '<img style="width:150px;height:150px" src="/wp-content/uploads/team.jpg" alt=""/></section>',
    } as Partial<SectionSpec>);
    const r = reconstructPagePattern([s], opts);
    expect(r.body).toContain('<!-- wp:html -->');
    // The STYLED snapshot is what shipped — inline styles preserved verbatim.
    expect(r.body).toContain('display:flex');
    expect(r.body).toContain('color:rgb(255,255,255)');
    // Distinct provenance prefix so the styled island is NOT counted as an
    // unstyled fallback (`html-fallback#<i>` is the unstyled signal).
    expect(r.provenanceFlags.some((f) => /html-fallback-styled#0/.test(f))).toBe(true);
    expect(r.provenanceFlags.some((f) => /(^|\s)html-fallback#0/.test(f))).toBe(false);
  });

  it('does NOT fall back when the section is lossy but has no sectionHtml (ineligible)', () => {
    const s = section({
      headings: ['Our Story'],
      images: [{ url: '/wp-content/uploads/team.jpg', sourceUrl: 'https://cdn.test/team.jpg', alt: '', kind: 'img', width: 150, height: 150 }],
      // no sectionHtml → not fallback-eligible (e.g. over-cap / truncated)
    } as Partial<SectionSpec>);
    const r = reconstructPagePattern([s], opts);
    expect(r.body).not.toContain('<!-- wp:html -->');
  });
});
