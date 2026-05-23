import { describe, it, expect } from 'vitest';
import {
  extractSignature,
  classifySection,
  filterIconCandidate,
  isIconFontFamily,
  MAX_SVG_MARKUP_BYTES,
  MIN_ICON_PX,
  MAX_ICON_PX,
} from './section-extract.js';
import type { SectionFeatures, SectionChildFeature } from './section-extract.js';

const HTML = `<!doctype html><html><body>
  <section><h1>Welcome</h1><a class="button">Call us</a></section>
  <section><div class="col"></div><div class="col"></div><div class="col"></div></section>
</body></html>`;

describe('extractSignature', () => {
  it('derives an ordered section-type sequence from saved HTML', () => {
    const sig = extractSignature('https://x/', HTML, 5);
    expect(sig.url).toBe('https://x/');
    expect(sig.sections.map((s) => s.type)).toEqual(['cover-with-headline', 'columns']);
    expect(sig.sections[1].columns).toBe(3);
  });

  it('falls back to a single static section when no landmarks exist', () => {
    const sig = extractSignature('https://x/', '<body><p>hi</p></body>', 1);
    expect(sig.sections.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// classifySection — pure interaction-model classifier over a synthetic
// SectionFeatures descriptor (no browser). These are the same shapes
// extractFull builds inside page.evaluate from computed styles + geometry.
// ---------------------------------------------------------------------------

/** Minimal SectionFeatures with sane defaults; override per-test. */
function feat(over: Partial<SectionFeatures> = {}): SectionFeatures {
  return {
    tag: 'section',
    roleHint: null,
    top: 1000,
    height: 400,
    width: 1440,
    isAboveFold: false,
    viewportRatio: 0.4,
    headingCount: 0,
    maxHeadingPx: 0,
    paragraphCount: 0,
    imageCount: 0,
    bgImageCount: 0,
    videoCount: 0,
    svgCount: 0,
    buttonCount: 0,
    hasQuote: false,
    textLength: 0,
    backgroundBrightness: 255,
    hasGradient: false,
    repeatedChildren: [],
    motionSignals: [],
    avgImageAspect: 0,
    ...over,
  };
}

function card(over: Partial<SectionChildFeature> = {}): SectionChildFeature {
  return {
    headingCount: 0,
    paragraphCount: 0,
    imageCount: 0,
    buttonCount: 0,
    minFontSizePx: 16,
    hasCurrency: false,
    ...over,
  };
}

describe('classifySection', () => {
  it('classifies nav/footer by tag and role', () => {
    expect(classifySection(feat({ tag: 'nav' }))).toBe('nav');
    expect(classifySection(feat({ tag: 'footer' }))).toBe('footer');
    expect(classifySection(feat({ tag: 'div', roleHint: 'navigation' }))).toBe('nav');
    expect(classifySection(feat({ tag: 'div', roleHint: 'contentinfo' }))).toBe('footer');
  });

  it('classifies an above-fold headline with CTA as cover-with-headline', () => {
    const f = feat({
      top: 0,
      height: 800,
      isAboveFold: true,
      viewportRatio: 0.9,
      headingCount: 1,
      maxHeadingPx: 56,
      buttonCount: 1,
      bgImageCount: 1,
      backgroundBrightness: 40,
    });
    expect(classifySection(f)).toBe('cover-with-headline');
  });

  it('promotes a cover with motion to animated-cover', () => {
    const f = feat({
      top: 0,
      isAboveFold: true,
      viewportRatio: 0.9,
      headingCount: 1,
      maxHeadingPx: 56,
      buttonCount: 1,
      hasGradient: true,
      motionSignals: ['css-animation'],
    });
    expect(classifySection(f)).toBe('animated-cover');
  });

  it('classifies a 4-card titled image grid as project-card-grid', () => {
    const f = feat({
      imageCount: 4,
      headingCount: 4,
      textLength: 200,
      repeatedChildren: [
        card({ imageCount: 1, headingCount: 1 }),
        card({ imageCount: 1, headingCount: 1 }),
        card({ imageCount: 1, headingCount: 1 }),
        card({ imageCount: 1, headingCount: 1 }),
      ],
    });
    expect(classifySection(f)).toBe('project-card-grid');
  });

  it('classifies a 3-card grid with small byline as blog-card-grid', () => {
    const f = feat({
      imageCount: 3,
      headingCount: 3,
      paragraphCount: 3,
      textLength: 300,
      repeatedChildren: [
        card({ imageCount: 1, headingCount: 1, paragraphCount: 1, minFontSizePx: 12 }),
        card({ imageCount: 1, headingCount: 1, paragraphCount: 1, minFontSizePx: 12 }),
        card({ imageCount: 1, headingCount: 1, paragraphCount: 1, minFontSizePx: 12 }),
      ],
    });
    expect(classifySection(f)).toBe('blog-card-grid');
  });

  it('classifies horizontal rows with price + CTA as price-list', () => {
    const f = feat({
      headingCount: 3,
      buttonCount: 3,
      textLength: 250,
      repeatedChildren: [
        card({ headingCount: 1, buttonCount: 1, hasCurrency: true }),
        card({ headingCount: 1, buttonCount: 1, hasCurrency: true }),
        card({ headingCount: 1, buttonCount: 1, hasCurrency: true }),
      ],
    });
    expect(classifySection(f)).toBe('price-list');
  });

  it('classifies a 4+ image low-text section as gallery', () => {
    const f = feat({
      imageCount: 8,
      textLength: 30,
      repeatedChildren: [], // no titled cards
    });
    expect(classifySection(f)).toBe('gallery');
  });

  it('classifies a uniform logo row as logo-strip', () => {
    const f = feat({
      svgCount: 5,
      imageCount: 0,
      textLength: 20,
      height: 160,
      viewportRatio: 0.18,
    });
    expect(classifySection(f)).toBe('logo-strip');
  });

  it('classifies a quote block as testimonial', () => {
    const f = feat({ hasQuote: true, textLength: 220, imageCount: 0 });
    expect(classifySection(f)).toBe('testimonial');
  });

  it('classifies one-image + heading + paragraph as media-text', () => {
    const f = feat({
      imageCount: 1,
      headingCount: 1,
      paragraphCount: 2,
      textLength: 320,
      repeatedChildren: [],
    });
    expect(classifySection(f)).toBe('media-text');
  });

  it('classifies a 3-column text feature grid as columns', () => {
    const f = feat({
      headingCount: 3,
      paragraphCount: 3,
      textLength: 400,
      repeatedChildren: [
        card({ headingCount: 1, paragraphCount: 1 }),
        card({ headingCount: 1, paragraphCount: 1 }),
        card({ headingCount: 1, paragraphCount: 1 }),
      ],
    });
    expect(classifySection(f)).toBe('columns');
  });

  it('classifies a centered headline + button (no image) as cta', () => {
    const f = feat({ headingCount: 1, buttonCount: 1, imageCount: 0, textLength: 80 });
    expect(classifySection(f)).toBe('cta');
  });

  it('falls back to static for an unstructured block', () => {
    const f = feat({ paragraphCount: 1, textLength: 600 });
    expect(classifySection(f)).toBe('static');
  });

  it('does NOT classify a plain paragraph wall as a richer model', () => {
    const f = feat({ textLength: 1200, paragraphCount: 4 });
    expect(classifySection(f)).toBe('static');
  });
});

// ---------------------------------------------------------------------------
// isIconFontFamily — pure font-family icon-font detector.
// ---------------------------------------------------------------------------

describe('isIconFontFamily', () => {
  it('detects known icon fonts (case-insensitive, in a font stack)', () => {
    expect(isIconFontFamily('FontAwesome')).toBe(true);
    expect(isIconFontFamily('"Font Awesome 6 Free", sans-serif')).toBe(true);
    expect(isIconFontFamily('Material Icons')).toBe(true);
    expect(isIconFontFamily('dashicons')).toBe(true);
    expect(isIconFontFamily('Wix-Icon, Arial')).toBe(true);
  });

  it('rejects ordinary text fonts and empty input', () => {
    expect(isIconFontFamily('Helvetica, Arial, sans-serif')).toBe(false);
    expect(isIconFontFamily('Georgia')).toBe(false);
    expect(isIconFontFamily('')).toBe(false);
    expect(isIconFontFamily(null)).toBe(false);
    expect(isIconFontFamily(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterIconCandidate — pure icon size/markup filter (the policy extractFull
// applies in Node over the raw candidates collected by the DOM walk).
// ---------------------------------------------------------------------------

describe('filterIconCandidate', () => {
  it('keeps a small inline svg and preserves its markup', () => {
    const out = filterIconCandidate({
      kind: 'svg',
      markup: '<svg viewBox="0 0 24 24"><path d="M0 0h24"/></svg>',
      width: 32,
      height: 32,
    });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('svg');
    expect(out!.markup).toContain('<svg');
    expect(out!.width).toBe(32);
    expect(out!.height).toBe(32);
  });

  it('rejects a tracking-pixel-sized svg (below MIN_ICON_PX)', () => {
    expect(
      filterIconCandidate({ kind: 'svg', markup: '<svg></svg>', width: MIN_ICON_PX - 1, height: 4 }),
    ).toBeNull();
  });

  it('rejects a hero-illustration-sized svg (above MAX_ICON_PX)', () => {
    expect(
      filterIconCandidate({
        kind: 'svg',
        markup: '<svg></svg>',
        width: MAX_ICON_PX + 50,
        height: MAX_ICON_PX + 50,
      }),
    ).toBeNull();
  });

  it('keeps the slot but drops oversized svg markup (over the byte cap)', () => {
    const huge = `<svg>${'x'.repeat(MAX_SVG_MARKUP_BYTES + 1)}</svg>`;
    const out = filterIconCandidate({ kind: 'svg', markup: huge, width: 40, height: 40 });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('svg');
    expect(out!.markup).toBeUndefined(); // heavy markup dropped, slot kept
    expect(out!.width).toBe(40);
  });

  it('rejects an svg candidate with no markup', () => {
    expect(filterIconCandidate({ kind: 'svg', markup: '', width: 32, height: 32 })).toBeNull();
  });

  it('keeps a single-glyph icon-font candidate with its font-family', () => {
    const out = filterIconCandidate({
      kind: 'glyph',
      glyph: '', // fa-check
      fontFamily: 'Font Awesome 6 Free',
      width: 24,
      height: 24,
    });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('glyph');
    expect(out!.glyph).toBe('');
    expect(out!.fontFamily).toBe('Font Awesome 6 Free');
  });

  it('rejects a glyph candidate that is actually a run of text', () => {
    expect(
      filterIconCandidate({ kind: 'glyph', glyph: 'Read more', fontFamily: 'icomoon', width: 20, height: 20 }),
    ).toBeNull();
  });

  it('rejects an empty glyph', () => {
    expect(
      filterIconCandidate({ kind: 'glyph', glyph: '   ', fontFamily: 'icomoon', width: 20, height: 20 }),
    ).toBeNull();
  });

  it('uses the smaller side for the min check and larger side for the max check', () => {
    // tall-but-thin: minSide too small → reject
    expect(
      filterIconCandidate({ kind: 'svg', markup: '<svg></svg>', width: 4, height: 200 }),
    ).toBeNull();
    // within bounds on both sides → keep
    expect(
      filterIconCandidate({ kind: 'svg', markup: '<svg></svg>', width: 16, height: 48 }),
    ).not.toBeNull();
  });
});
