// src/lib/replicate/section-extract.ts
//
// Two extraction paths, two fidelity levels:
//
//   extractSignature(url, html)      — CHEAP. cheerio over saved HTML, no browser.
//                                      Only structural hints (tag, class names).
//                                      Under-classifies page-builder DOM (Wix/Squarespace
//                                      wrap everything in style-less divs) → most sections
//                                      come back 'static'. Used for clustering.
//
//   extractFull(page, mediaMap)      — FIDELITY. Playwright + getComputedStyle + geometry.
//                                      Ports wp-clone's extract.js section-detect + the
//                                      extract-section.js computed-style walk, then runs the
//                                      interaction-model classifier (section-mapping.md) over
//                                      real layout features. Returns one SectionSpec per
//                                      detected section. This is what beats the cheap pass.
//
// The interaction-model classifier itself (classifySection) is a PURE function over a
// SectionFeatures descriptor so it can be unit-tested without a browser. extractFull builds
// those descriptors inside page.evaluate from computed styles + geometry, then classifies.
//
// Classify decision tree (cheap path, extractSignature):
//
//   landmark element
//       ├─ heading + button-like      → 'cover-with-headline'
//       ├─ ≥3 children w/ class 'col' → 'columns'
//       ├─ ≥4 <img>, low text         → 'gallery'
//       └─ default                    → 'static'

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
// Aliased so the bare DOM `Element` global stays available inside the
// page.evaluate closure (which runs in the browser). The cheerio path uses
// DomElement; the Playwright path uses the lib.dom Element.
import type { Element as DomElement } from 'domhandler';
import type { Page } from 'playwright';
import type { PageSignature, SectionSignature } from './page-signature.js';
import { extractReviewsFromHtml, type ExtractedReview } from './review-extract.js';
import { extractFaqsFromHtml, type ExtractedFaq } from './faq-extract.js';
import { getPlaywright, slugify } from '../../adapters/shared.js';
import { waitForStable, triggerLazyLoad, withEvaluateTimeout } from '../screenshot/page-helpers.js';
import { enforceSameOrigin } from '../screenshot/same-origin.js';

const LANDMARK_SELECTOR = 'section, header, footer, nav, main, article';

// ---------------------------------------------------------------------------
// Interaction models — the closed set enumerated by spec-files.md.
// ---------------------------------------------------------------------------

export type InteractionModel =
  | 'static'
  | 'cover-with-headline'
  | 'animated-cover'
  | 'media-text'
  | 'columns'
  | 'gallery'
  | 'logo-strip'
  | 'testimonial'
  | 'cta'
  | 'blog-card-grid'
  | 'project-card-grid'
  | 'price-list'
  // Repeated storefront product cards: each card has an image + title + PRICE
  // (and usually an Add-to-Cart CTA). Distinct from project-card-grid (no
  // price) and price-list (no per-card image). Common on Shopify/Replo
  // "shop our products" / "Sleep essentials" rows.
  | 'product-card-row'
  // Repeated review/testimonial columns, each with a star rating + a quote +
  // an attribution (name). Distinct from the single-quote `testimonial`.
  | 'review-grid'
  // App-download block: a heading + copy beside app-store / google-play badge
  // images (and often a phone/app screenshot).
  | 'app-download'
  | 'color-block-grid'
  | 'marquee-strip'
  | 'horizontal-showcase'
  | 'footer'
  | 'nav';

// ---------------------------------------------------------------------------
// SectionFeatures — the geometry + computed-style descriptor the classifier
// reasons over. Built inside page.evaluate (extractFull) OR by hand (tests).
// Keep this PLAIN so it serializes across the page.evaluate boundary and so
// unit tests can construct synthetic inputs without a browser.
// ---------------------------------------------------------------------------

export interface SectionChildFeature {
  /** Direct-child grouping bucket — used to detect repeated card/column units. */
  headingCount: number;
  paragraphCount: number;
  imageCount: number;
  buttonCount: number;
  /** Smallest font-size (px) of any own-text node in this child (byline detection). */
  minFontSizePx: number;
  /** Does any own-text node contain a currency symbol? (price-list marker) */
  hasCurrency: boolean;
  /** Does this card carry a star rating (glyphs/SVGs/aria/text)? (review-grid marker) */
  hasStarRating?: boolean;
  /** Does this card carry a quote / cite / review attribution? (review-grid marker) */
  hasQuote?: boolean;
}

export interface SectionFeatures {
  tag: string;
  /** Section role hint from semantic tag / ARIA (banner/contentinfo/navigation). */
  roleHint: 'banner' | 'contentinfo' | 'navigation' | null;
  /** Y band. */
  top: number;
  height: number;
  width: number;
  /** Section occupies ~the first viewport and is tall (hero candidate). */
  isAboveFold: boolean;
  /** height / viewportHeight ratio. */
  viewportRatio: number;
  /** Headings (h1-h6 or large styled text) count. */
  headingCount: number;
  /** Largest heading font-size px in the section. */
  maxHeadingPx: number;
  paragraphCount: number;
  /** Foreground <img> count. */
  imageCount: number;
  /** Background-image url count on the wrapper/descendants. */
  bgImageCount: number;
  videoCount: number;
  /** Inline svg count (logos/icons arrive as svg on page builders). */
  svgCount: number;
  buttonCount: number;
  /** <blockquote> / role=quote / <cite> present. */
  hasQuote: boolean;
  /** Total visible text length in the section. */
  textLength: number;
  /** Section base background brightness 0-255 (luma). */
  backgroundBrightness: number;
  /** Wrapper background-image is a gradient. */
  hasGradient: boolean;
  /** Repeated direct-child units (card grid / columns / price rows). */
  repeatedChildren: SectionChildFeature[];
  /** A scrolling / marquee / carousel motion signal is present. */
  motionSignals: string[];
  /** Average image aspect (w/h) across foreground images, or 0. */
  avgImageAspect: number;
  /**
   * Section carries a star-rating signal — repeated star glyphs/SVGs, a
   * `★`/`⭐` run, an `out of 5`/`N reviews` text pattern, or rating-class
   * markup. Drives review-grid detection (Replo/Okendo/Junip review widgets).
   */
  hasStarRating?: boolean;
  /**
   * Section references an app-store / google-play badge image (download block).
   * Detected from image alt/src/filename matching store-badge markers.
   */
  hasStoreBadge?: boolean;
}

// ---------------------------------------------------------------------------
// The classifier. Pure function. Mirrors the heuristics embedded in
// references/section-mapping.md (the "Classification heuristic (step 3)" notes
// per template) plus the spec-files.md interaction-model enumeration.
//
// Order matters: more specific models are tested before generic fallbacks so
// e.g. a price-list row of {heading + button + $} isn't swallowed by 'columns'.
// ---------------------------------------------------------------------------

export function classifySection(f: SectionFeatures): InteractionModel {
  // --- structural roles first (nav / footer) -------------------------------
  if (f.tag === 'nav' || f.roleHint === 'navigation') return 'nav';
  if (f.tag === 'footer' || f.roleHint === 'contentinfo') return 'footer';

  const cards = f.repeatedChildren;
  const cardCount = cards.length;

  // --- marquee / horizontal showcase (motion-driven) -----------------------
  // marquee-strip ONLY when the spec's motion profile is a moving strip.
  const hasMarquee = f.motionSignals.includes('marquee-like');
  const hasCarousel = f.motionSignals.includes('carousel-like');
  if (hasMarquee && f.imageCount + f.svgCount >= 2 && f.textLength < 400) {
    return 'marquee-strip';
  }

  // --- review-grid ---------------------------------------------------------
  // 2+ repeated review columns, each with a star rating AND a quote/attribution.
  // Distinct from the single-quote `testimonial` (one block). Tested before
  // product-card-row and the card grids so a star+quote column isn't swallowed.
  const reviewCards = cards.filter((c) => c.hasStarRating && (c.hasQuote || c.paragraphCount >= 1));
  if (
    (reviewCards.length >= 2 && reviewCards.length >= cardCount - 1) ||
    // Section-level signal when the grid host isn't split into per-card units
    // (some review widgets render a flat list): star rating + quote + short-ish.
    (f.hasStarRating && f.hasQuote && f.imageCount <= cardCount + 1)
  ) {
    return 'review-grid';
  }

  // --- product-card-row ----------------------------------------------------
  // 2+ repeated storefront cards, each with an IMAGE + a title + a PRICE. The
  // Add-to-Cart CTA is common but not required (some cards link the whole tile).
  // Distinct from price-list (those have no per-card image) and project-card-
  // grid (no price). Tested before project/blog grids so the price semantics win.
  const productCards = cards.filter(
    (c) => c.imageCount >= 1 && c.hasCurrency && c.headingCount + c.paragraphCount >= 1,
  );
  if (productCards.length >= 2 && productCards.length >= cardCount - 1) {
    return 'product-card-row';
  }

  // --- app-download --------------------------------------------------------
  // A download block: app-store / google-play badge image(s) plus a heading.
  // The badges arrive as small <img>s with store-badge alt/src markers; the
  // section pairs them with an app screenshot + copy (media-text-like) but the
  // badge presence is the discriminator.
  if (f.hasStoreBadge && f.headingCount >= 1) {
    return 'app-download';
  }

  // --- price-list ----------------------------------------------------------
  // 2+ horizontal rows, each with exactly one heading/title + one button, and a
  // currency marker in the row. (section-mapping.md price-list heuristic.)
  const priceRows = cards.filter(
    (c) => c.buttonCount >= 1 && c.headingCount + c.paragraphCount >= 1 && c.hasCurrency,
  );
  if (priceRows.length >= 2 && priceRows.length === cardCount) {
    return 'price-list';
  }

  // --- blog-card-grid ------------------------------------------------------
  // 3+ adjacent cards, each with one img + a small-font byline para + a heading.
  const blogCards = cards.filter(
    (c) => c.imageCount >= 1 && c.headingCount >= 1 && c.paragraphCount >= 1 && c.minFontSizePx > 0 && c.minFontSizePx < 14,
  );
  if (blogCards.length >= 3 && blogCards.length >= cardCount - 1) {
    return 'blog-card-grid';
  }

  // --- project-card-grid ---------------------------------------------------
  // 3+ adjacent cards, each with an image + title (heading). Distinguished from
  // blog by no small-byline requirement; distinguished from gallery by per-card
  // text/structure (each card carries a heading, not just an image).
  const projectCards = cards.filter((c) => c.imageCount >= 1 && c.headingCount >= 1);
  if (projectCards.length >= 3 && projectCards.length >= cardCount - 1) {
    return 'project-card-grid';
  }

  // --- color-block-grid ----------------------------------------------------
  // grid of cells where each cell carries its own image/bg and short/no text —
  // image-tiles. Treated as 3+ image cells with minimal per-cell prose.
  const tileCards = cards.filter((c) => c.imageCount >= 1 && c.headingCount + c.paragraphCount <= 1);
  if (tileCards.length >= 3 && tileCards.length === cardCount && f.textLength < cardCount * 60) {
    return 'color-block-grid';
  }

  // --- testimonial ---------------------------------------------------------
  if (f.hasQuote && f.imageCount <= 1 && f.textLength < 800) {
    return 'testimonial';
  }

  // --- logo-strip ----------------------------------------------------------
  // A short horizontal row of small uniform logos (img/svg), minimal text, no
  // headings of its own beyond a short label. Small height relative to width.
  const logoUnits = f.imageCount + f.svgCount;
  if (
    logoUnits >= 3 &&
    f.textLength < 120 &&
    f.headingCount <= 1 &&
    f.height < 360 &&
    f.viewportRatio < 0.5
  ) {
    return 'logo-strip';
  }

  // --- cover-with-headline / animated-cover --------------------------------
  // A hero: heading + (button or large heading) occupying the top of the page
  // and/or a tall section with a background image/gradient and a big headline.
  const heroLike =
    f.headingCount >= 1 &&
    f.maxHeadingPx >= 28 &&
    (f.isAboveFold || f.viewportRatio >= 0.6) &&
    (f.bgImageCount >= 1 || f.hasGradient || f.videoCount >= 1 || f.buttonCount >= 1);
  if (heroLike) {
    const animated = f.motionSignals.includes('css-animation') || f.motionSignals.includes('transform');
    return animated ? 'animated-cover' : 'cover-with-headline';
  }

  // --- gallery -------------------------------------------------------------
  // 4+ images, minimal text, and NOT structured as per-card titled units
  // (those were caught by project/blog/color-block above).
  if (f.imageCount >= 4 && f.textLength < f.imageCount * 40) {
    return 'gallery';
  }

  // --- horizontal-showcase -------------------------------------------------
  // wide laterally-scanned strip of large cards with a carousel/scroll signal.
  if (hasCarousel && cardCount >= 2 && f.imageCount >= 2) {
    return 'horizontal-showcase';
  }

  // --- media-text ----------------------------------------------------------
  // one image beside a heading + paragraph (feature row). Single (or few) image,
  // real prose, a heading.
  if (
    f.imageCount + f.bgImageCount >= 1 &&
    f.imageCount + f.bgImageCount <= 2 &&
    f.headingCount >= 1 &&
    f.paragraphCount >= 1 &&
    f.textLength >= 40 &&
    cardCount <= 2
  ) {
    return 'media-text';
  }

  // --- columns -------------------------------------------------------------
  // 3+ sibling units each carrying some content (heading or paragraph), no
  // strong image-grid signal. Generic feature grid.
  const contentColumns = cards.filter((c) => c.headingCount + c.paragraphCount >= 1);
  if (contentColumns.length >= 3) {
    return 'columns';
  }

  // --- cta -----------------------------------------------------------------
  // centered headline + button, no (or background-only) images, short text.
  if (f.headingCount >= 1 && f.buttonCount >= 1 && f.imageCount === 0 && f.textLength < 600) {
    return 'cta';
  }

  // --- default -------------------------------------------------------------
  return 'static';
}

// ---------------------------------------------------------------------------
// extractSignature — CHEAP structural path (cheerio, no browser).
// ---------------------------------------------------------------------------

/** Element children of a node, skipping non-rendering tags (script/style/etc.). */
function contentChildren($: CheerioAPI, el: DomElement): DomElement[] {
  const skip = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'br']);
  return $(el)
    .children()
    .toArray()
    .filter((c) => c.type === 'tag' && !skip.has(c.tagName.toLowerCase())) as DomElement[];
}

/**
 * Expand a content landmark (typically `<main>`) into its real section rows
 * when the page has no semantic `<section>`/`<article>` children.
 *
 * Page builders (Shopify/Replo, Wix, Squarespace) emit no semantic section
 * tags — the whole page body lives under `<main>` inside one or more
 * style-less wrapper `<div>`s, with the actual page sections as sibling
 * children of a single deep "content root". The landmark-only signature then
 * collapses every such page to a single `static` section, so the homepage
 * clusters with products and blog posts (all signatures look identical).
 *
 * Strategy: descend through single-child wrapper divs (unwrapping the builder
 * chrome) until we reach a node with multiple content children, and treat
 * those children as the page's sections. Falls back to the landmark itself
 * when no multi-child root is found (preserving prior behavior for
 * genuinely-flat pages).
 */
// A page is treated as having "good semantic structure" when its content
// landmark wraps at least this many top-level semantic <section>/<article>
// children. Wix/Squarespace export real <section> tags as their layout
// primitive; page builders (Shopify/Replo, Shogun) emit ZERO. The presence of
// genuine semantic sections is the discriminator between the two clustering
// strategies — see expandContentSections.
const SEMANTIC_STRUCTURE_MIN = 2;

function expandContentSections($: CheerioAPI, landmark: DomElement): DomElement[] {
  // Collect top-level semantic <section>/<article> descendants (not ones nested
  // inside another semantic section), preserving document order.
  const semantic = $(landmark).find('section, article').toArray() as DomElement[];
  const topLevelSemantic = semantic.filter((el) => {
    let a = el.parent;
    while (a && a !== landmark && a.type === 'tag') {
      const t = (a as DomElement).tagName?.toLowerCase() ?? '';
      if (t === 'section' || t === 'article') return false;
      a = a.parent;
    }
    return true;
  });

  // GOOD SEMANTIC STRUCTURE (Wix/Squarespace): the page already uses real
  // <section> tags as its layout primitive. Expanding each one into its own
  // signature row over-fragments clustering — section count and order vary per
  // page, so every page gets a unique key (swiftlumber regressed 7 pages -> 6
  // clusters this way). Treat the whole content landmark as ONE coarse section
  // (the pre-page-builder-unwrap behavior), which clusters siblings together
  // (~2 clusters for a small Wix site). Div-soup builders have ZERO semantic
  // sections and fall through to the unwrap path below.
  if (topLevelSemantic.length >= SEMANTIC_STRUCTURE_MIN) {
    return [landmark];
  }
  // Exactly one semantic section under <main> is still "good enough" structure
  // (a single-section content page) — keep it coarse rather than unwrapping the
  // div soup inside it.
  if (topLevelSemantic.length === 1) {
    return [landmark];
  }

  // DIV-SOUP PAGE BUILDER (Shopify/Replo): no semantic <section> tags at all —
  // the real sections are children of a deep style-less content root. Descend
  // through single-child wrapper chains until we reach the multi-child root and
  // treat those children as the page's sections, so the homepage (many real
  // sections) differentiates from products/posts.
  let node: DomElement = landmark;
  // Descend through single-wrapper chains (max depth guards against runaway).
  for (let depth = 0; depth < 12; depth++) {
    const kids = contentChildren($, node);
    if (kids.length === 0) break;
    if (kids.length === 1) {
      node = kids[0];
      continue;
    }
    // Multiple children → this is the content root. Each child is a section
    // candidate. Filter out trailing empties (no text and no media).
    const sections = kids.filter((k) => {
      const $k = $(k);
      return $k.text().trim().length > 0 || $k.find('img,svg,picture,video').length > 0;
    });
    if (sections.length >= 2) return sections;
    // A single meaningful child masquerading as multi (e.g. one section + a
    // tracking pixel div) — keep descending into the meaningful one.
    if (sections.length === 1) {
      node = sections[0];
      continue;
    }
    break;
  }
  return [landmark];
}

function classifyLandmark($: CheerioAPI, el: DomElement): SectionSignature {
  const $el = $(el);

  // 1. cover-with-headline: has a heading AND a button-like element
  const hasHeading = $el.find('h1,h2,h3,h4,h5,h6').length > 0;
  const hasButton =
    $el.find('button').length > 0 ||
    $el.find('a').filter((_i, a) => {
      const cls = $(a).attr('class') ?? '';
      return /\bbtn\b|\bbutton\b/i.test(cls);
    }).length > 0 ||
    $el.find('[class]').filter((_i, node) => {
      const cls = $(node).attr('class') ?? '';
      return /\bbtn\b|\bbutton\b/i.test(cls);
    }).length > 0;

  if (hasHeading && hasButton) {
    return { type: 'cover-with-headline' };
  }

  // 2. columns: ≥3 direct children (or descendants) with class containing 'col'
  const colChildren = $el.children().filter((_i, child) => {
    const cls = $(child).attr('class') ?? '';
    return /\bcol\b/i.test(cls) || /\bcol-/i.test(cls);
  });
  if (colChildren.length >= 3) {
    return { type: 'columns', columns: colChildren.length };
  }

  // 3. gallery: ≥4 <img> with low surrounding text
  const imgCount = $el.find('img').length;
  if (imgCount >= 4) {
    const text = ($el.text() ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < imgCount * 40) {
      return { type: 'gallery', imageBucket: imgCount >= 8 ? 'many' : 'few' };
    }
  }

  // 4. default
  return { type: 'static' };
}

export function extractSignature(url: string, html: string, htmlBytes: number): PageSignature {
  const $ = cheerio.load(html);

  // Collect top-level landmark elements in document order.
  // "Top-level" means we skip landmarks that are nested inside another landmark.
  const landmarks: DomElement[] = [];
  $(LANDMARK_SELECTOR).each((_i, el) => {
    // Walk ancestors; if any ancestor is also a landmark, skip this element.
    let ancestor = el.parent;
    let nested = false;
    while (ancestor && ancestor.type === 'tag') {
      const tag = (ancestor as DomElement).tagName?.toLowerCase() ?? '';
      if (['section', 'header', 'footer', 'nav', 'main', 'article'].includes(tag)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!nested) {
      landmarks.push(el);
    }
  });

  // Fallback: no landmarks → single static section
  if (landmarks.length === 0) {
    return { url, htmlBytes, sections: [{ type: 'static' }] };
  }

  // Expand content landmarks (<main>, <article>) into their real section rows.
  // Page builders (Shopify/Replo, Wix, Squarespace) emit no semantic <section>
  // tags, so the whole body collapses under one <main> landmark. Without this,
  // every builder page yields a near-identical thin signature and clusters
  // incorrectly (homepage lumped with products/posts). header/footer/nav stay
  // as single landmarks — only the content blob is expanded.
  const sections: SectionSignature[] = [];
  for (const el of landmarks) {
    const tag = el.tagName?.toLowerCase() ?? '';
    if (tag === 'main' || tag === 'article') {
      const rows = expandContentSections($, el);
      for (const row of rows) sections.push(classifyLandmark($, row));
    } else {
      sections.push(classifyLandmark($, el));
    }
  }
  return { url, htmlBytes, sections };
}

// ---------------------------------------------------------------------------
// SectionSpec — the rich, per-section output that satisfies spec-files.md.
// One per detected section. Image URLs are rewritten through mediaMap when a
// CDN URL matches; otherwise kept as-is.
// ---------------------------------------------------------------------------

export interface SectionSpecImage {
  /** Final URL: rewritten through mediaMap when matched, else the source URL. */
  url: string;
  /** Original CDN/source URL as captured (pre-rewrite). */
  sourceUrl: string;
  alt: string;
  kind: 'img' | 'background';
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Inline icon graphics — check / building / location-pin glyphs that arrive as
// inline <svg> (not <img>) or as icon-font glyphs (Font Awesome / Material /
// Wix's `wix-icon` fonts). The image walk above only collects <img>/background,
// so these were silently dropped. We capture them per-section here.
//
// How the BUILDER must consume these (no-wp:html-respecting approach):
//   `wp:html` (Custom HTML block) is banned project-wide — see
//   src/lib/wordpress/block-policy.ts. So we CANNOT emit an inline <svg> in
//   block markup. The cleanest legal path:
//     1. The orchestrator writes each captured inline SVG's bytes to a theme
//        asset: assets/icon-NN.svg.  (That's why `svgMarkup` carries the raw
//        bytes back out of the browser — extractFull surfaces them so the
//        orchestrator can persist them; nothing here writes to disk.)
//     2. The icon is referenced from block markup as an `wp:image` whose `src`
//        resolves via `get_theme_file_uri( 'assets/icon-NN.svg' )` (a theme
//        function call rendered server-side / by a small pattern), NOT inlined.
//   Icon-font glyphs (`kind:'glyph'`) carry the glyph char + the font-family so
//   the builder can re-create them with the same icon font enqueued in the
//   theme, or fall back to a Unicode/dashicon equivalent — again, no raw HTML.
// ---------------------------------------------------------------------------

export interface SectionSpecIcon {
  kind: 'svg' | 'glyph';
  /** Serialized <svg> outerHTML (kind:'svg' only). Capped; absent if oversized. */
  markup?: string;
  /** The glyph character (kind:'glyph' only). */
  glyph?: string;
  /** computed font-family of the glyph element (kind:'glyph' only). */
  fontFamily?: string;
  /** Rendered box, px. */
  width: number;
  height: number;
}

/**
 * One structured cell of a grid/columns section (an icon-feature tile, a
 * sound-library column, a comparison column). Captured PER cell so the renderer
 * can emit a faithful N-column grid instead of flattening every cell's text into
 * one stacked band. All text is source-verbatim. Present only on sections whose
 * layout is a uniform multi-cell grid; the renderer decides whether to use it
 * (card-grids keep their image-led per-index path).
 */
export interface SectionSpecCell {
  /** The cell's title — its largest-font text node, or null when no clear title. */
  heading: string | null;
  /** Remaining cell text in document order (labels, descriptions, list items). */
  body: string[];
  /** A content image in the cell (mediaMapped), if any. */
  image: SectionSpecImage | null;
  /** A small inline icon (SVG) in the cell, if any. */
  icon: SectionSpecIcon | null;
  /** A button/CTA label in the cell, if any. */
  button: string | null;
  /** Card container background (rgb string) when the cell is a styled card, else null.
   *  Mapped to the nearest theme token by the renderer so cards render distinctly.
   *  Optional for back-compat with hand-built specs. */
  background?: string | null;
  /** Card corner radius in px (0 = no rounded card). Optional for back-compat. */
  radius?: number;
}

export interface SectionSpecMotion {
  /** Coarse motion class for the spec's "Motion profile". */
  motionClass:
    | 'none'
    | 'css-transition'
    | 'css-keyframes'
    | 'entry-reveal'
    | 'marquee'
    | 'carousel'
    | 'parallax'
    | 'video'
    | 'lottie'
    | 'scroll-triggered';
  /** Raw signals collected (transition, transform, carousel-like, …). */
  signals: string[];
  /** Count of animated elements in the section. */
  animatedElements: number;
}

export interface SectionSpecLayout {
  /** wrapper.rect.width */
  containerWidth: number;
  padding: string;
  childLayout: 'grid' | 'flex-row' | 'flex-column' | 'stack';
  columnCount: number;
  gap: string;
}

export interface SectionSpec {
  sectionIndex: number;
  interactionModel: InteractionModel;
  /** Y band. */
  top: number;
  height: number;
  headings: string[];
  /** Computed font-size (px) of each heading, parallel to `headings` — lets the
   *  renderer reproduce the source type scale (eyebrow label vs headline) rather
   *  than collapse to generic heading levels. Optional for back-compat. */
  headingSizes?: number[];
  /**
   * Source-VERBATIM body copy captured from this section's served HTML — every
   * visible `<p>`/`<li>` text node, in document order, deduped. This is the
   * provenance source for non-heading prose: the pattern builder MUST emit
   * section body paragraphs from THIS array verbatim (entity/whitespace
   * normalization only), never reworded, and `validateArtifacts` checks emitted
   * body text against it. When a template slot wants body copy this array does
   * not contain, the builder uses the missing-content placeholder + run-report
   * flag — it must NEVER synthesize or paraphrase. (The earlier getsnooz build
   * lacked this field, so body copy had no source to verify against and was
   * invented; capturing it here closes that gap.)
   */
  bodyText: string[];
  buttonLabels: string[];
  images: SectionSpecImage[];
  /** Inline SVG / icon-font glyphs in the section's Y-band (icons above cards). */
  icons: SectionSpecIcon[];
  /** 0-255 luma of the section base background (0.299R + 0.587G + 0.114B). */
  backgroundBrightness: number;
  /** Wrapper background color (rgb/rgba string as computed). */
  backgroundColor: string;
  /** Gradient string if the effective background is a gradient, else null. */
  gradient: string | null;
  /** Where the gradient originates — drives the skip-vs-emit rule downstream. */
  gradientSource: 'wrapper' | 'ancestor' | 'sibling' | 'pageBackground' | 'inherited' | null;
  motionProfile: SectionSpecMotion;
  /** {color, thickness} of a divider bracketing the section, or null. */
  dividerAbove: { color: string; thickness: number } | null;
  dividerBelow: { color: string; thickness: number } | null;
  layout: SectionSpecLayout;
  /**
   * Source-VERBATIM customer reviews captured from this section's served HTML
   * (Replo/page-builder review carousels render every slide inline; see
   * review-extract.ts). Present only on review-grid sections. When a review
   * band is detected but this is empty/undefined, the pattern builder MUST use
   * the missing-content fallback (sized placeholders + run-report flag) — it
   * must NEVER synthesize review prose.
   */
  reviews?: ExtractedReview[];
  /**
   * Source-VERBATIM FAQ question/answer pairs captured from this section's
   * served HTML (accordions render every answer inline; see faq-extract.ts).
   * Present only on FAQ sections. When set, the renderer emits a faithful
   * `wp:details` accordion instead of dumping answers as a generic text band.
   * A question whose answer could not be resolved carries an empty `answer`,
   * and the renderer emits a missing-content placeholder — NEVER an invented one.
   */
  faqs?: ExtractedFaq[];
  /**
   * Per-cell structured content for uniform grid/columns sections (icon-feature
   * rows, sound-library columns, comparison columns). When present (>=2 cells),
   * the renderer emits a faithful N-column grid; otherwise grid content is
   * flattened into a single stacked band. All cell text is source-verbatim.
   */
  cells?: SectionSpecCell[];
}

// ---------------------------------------------------------------------------
// extractFull — FIDELITY path. Runs inside the browser via page.evaluate.
//
// The whole pipeline runs in ONE round-trip: section-detect (extract.js port) +
// per-section computed-style walk (extract-section.js port) + feature build.
// classifySection runs back in Node so it's the same code the unit tests cover.
// ---------------------------------------------------------------------------

/** A raw icon candidate as the browser walk collects it (pre-filter). */
interface RawIconCandidate {
  kind: 'svg' | 'glyph';
  markup?: string;
  glyph?: string;
  fontFamily?: string;
  width: number;
  height: number;
}

/** Raw per-section payload returned from the browser, before classification. */
interface RawSection {
  features: SectionFeatures;
  headings: string[];
  headingSizes: number[];
  bodyText: string[];
  buttonLabels: string[];
  images: Array<{ src: string; alt: string; kind: 'img' | 'background'; w: number; h: number }>;
  iconCandidates: RawIconCandidate[];
  backgroundColor: string;
  gradient: string | null;
  gradientSource: SectionSpec['gradientSource'];
  dividerAbove: { color: string; thickness: number } | null;
  dividerBelow: { color: string; thickness: number } | null;
  layout: SectionSpecLayout;
  /** Serialized outerHTML of the section (capped) — input to review-extract. */
  sectionHtml?: string;
  /** Per-cell raw capture for grid sections (built into SectionSpec.cells in Node). */
  cells?: RawCell[];
}

/** Raw per-cell capture from the browser walk (shaped into SectionSpecCell in Node). */
interface RawCell {
  texts: Array<{ t: string; size: number }>;
  image: { src: string; alt: string; w: number; h: number } | null;
  icon: { markup: string; w: number; h: number } | null;
  button: string;
  /** Card container opaque background (rgb string) + corner radius (px), if any. */
  bg: string | null;
  radius: number;
}

// ---------------------------------------------------------------------------
// Icon capture tunables + a PURE size/markup filter (unit-tested below). These
// live in Node so the browser walk just collects raw candidates; the policy of
// what counts as a usable icon is exercised without a browser.
// ---------------------------------------------------------------------------

/** Max serialized inline-SVG size we keep. Bigger = an illustration, not a glyph. */
export const MAX_SVG_MARKUP_BYTES = 8 * 1024; // 8KB
/** Smallest rendered side (px) we'll treat as a real icon (skip 1px tracking pixels). */
export const MIN_ICON_PX = 8;
/** Largest rendered side (px) we'll treat as an icon glyph (bigger = hero art). */
export const MAX_ICON_PX = 256;

/** Substrings that mark a computed font-family as an icon font (lowercased match). */
export const ICON_FONT_HINTS = [
  'fontawesome',
  'font awesome',
  'material icons',
  'material symbols',
  'glyphicon',
  'dashicons',
  'ionicons',
  'feather',
  'wix-icon',
  'wix madefor icons',
  'icomoon',
  'eicons',
  'elementor icons',
];

/** True when a computed font-family string names a known icon font. */
export function isIconFontFamily(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) return false;
  const f = fontFamily.toLowerCase();
  return ICON_FONT_HINTS.some((hint) => f.includes(hint));
}

/**
 * PURE icon filter. Given a raw candidate (already shaped by the DOM walk),
 * decide whether to keep it and normalize it into a SectionSpecIcon — or return
 * null to drop it. Rules:
 *   - reject if the rendered box is outside [MIN_ICON_PX, MAX_ICON_PX] on its
 *     smaller side (1px trackers / hero illustrations are not icons),
 *   - for svg: drop the (oversized) markup but only if it exceeds the cap —
 *     the icon is still kept as a sized placeholder so the layout slot survives,
 *   - for glyph: require a single non-whitespace glyph char.
 */
export function filterIconCandidate(c: {
  kind: 'svg' | 'glyph';
  markup?: string;
  glyph?: string;
  fontFamily?: string;
  width: number;
  height: number;
}): SectionSpecIcon | null {
  const w = Math.round(c.width);
  const h = Math.round(c.height);
  const minSide = Math.min(w, h);
  const maxSide = Math.max(w, h);
  if (minSide < MIN_ICON_PX || maxSide > MAX_ICON_PX) return null;

  if (c.kind === 'svg') {
    const markup = typeof c.markup === 'string' ? c.markup : '';
    if (!markup) return null;
    // Over the cap → keep the slot (sized) but drop the heavy markup.
    const keptMarkup = markup.length <= MAX_SVG_MARKUP_BYTES ? markup : undefined;
    return { kind: 'svg', markup: keptMarkup, width: w, height: h };
  }

  // glyph
  const glyph = (c.glyph ?? '').trim();
  if (glyph.length === 0 || glyph.length > 4) return null; // single icon-font codepoint (may be surrogate pair)
  return { kind: 'glyph', glyph, fontFamily: c.fontFamily, width: w, height: h };
}

/** Derive a coarse motion class from the raw signals (spec "Motion profile"). */
function deriveMotionClass(signals: string[]): SectionSpecMotion['motionClass'] {
  if (signals.includes('marquee-like')) return 'marquee';
  if (signals.includes('carousel-like')) return 'carousel';
  if (signals.includes('scroll-effect')) return 'scroll-triggered';
  if (signals.includes('lottie-like')) return 'lottie';
  if (signals.includes('video')) return 'video';
  if (signals.includes('css-animation')) return 'css-keyframes';
  if (signals.includes('transition')) return 'css-transition';
  if (signals.includes('transform')) return 'entry-reveal';
  return 'none';
}

/**
 * Rewrite a CDN URL through the media map. The map's keys are source URLs as
 * the pipeline saw them; CDN query params (w_, h_, q_, fit_) are stripped for
 * matching since the same asset appears at many sizes. Falls back to the source
 * URL untouched when no match.
 */
/** filename portion of a URL, query string + fragment stripped. */
function urlBasename(u: string): string {
  const noQuery = u.replace(/[?#].*$/, '');
  const last = noQuery.split('/').filter(Boolean).pop() ?? '';
  return last.toLowerCase();
}

/**
 * Cache of basename → localUrl indexes, keyed by mediaMap identity. Building the
 * index once per extraction (rather than per image) keeps rewrite O(1) per call.
 */
const basenameIndexCache = new WeakMap<Record<string, string>, Map<string, string>>();
function basenameIndexFor(mediaMap: Record<string, string>): Map<string, string> {
  let idx = basenameIndexCache.get(mediaMap);
  if (!idx) {
    idx = new Map<string, string>();
    for (const [key, val] of Object.entries(mediaMap)) {
      const b = urlBasename(key);
      // First write wins — captured order is stable and deterministic.
      if (b && !idx.has(b)) idx.set(b, val);
    }
    basenameIndexCache.set(mediaMap, idx);
  }
  return idx;
}

export function rewriteThroughMediaMap(src: string, mediaMap: Record<string, string>): string {
  if (mediaMap[src]) return mediaMap[src];
  const stripped = src.replace(/([?&])(w|h|q|quality|fit|crop)_[^&]+/g, '$1');
  if (mediaMap[stripped]) return mediaMap[stripped];
  // also try matching map keys with their own params stripped
  for (const [key, val] of Object.entries(mediaMap)) {
    const k = key.replace(/([?&])(w|h|q|quality|fit|crop)_[^&]+/g, '$1');
    if (k === stripped) return val;
  }
  // Basename fallback. Shopify CDN serves the same asset at many sizes via
  // `?v=...&width=...` query strings (and `assets.replocdn.com` adds `?width=`),
  // so the captured media-stub key and the in-page src rarely match exactly.
  // The image bytes are identical regardless of the size param, so matching on
  // filename recovers the WP-library URL — consistent with media-install.php's
  // basename matching and the WXR attachment-URL rewrite. Without this, Shopify
  // images leak through as remote CDN URLs and validate-artifacts rejects them.
  const b = urlBasename(src);
  if (b) {
    const hit = basenameIndexFor(mediaMap).get(b);
    if (hit) return hit;
  }
  return src;
}

export async function extractFull(
  page: Page,
  mediaMap: Record<string, string>,
  timeoutMs = 15_000,
): Promise<SectionSpec[]> {
  const raw = await withEvaluateTimeout(
    page.evaluate(() => {
      // ====== ported helpers (extract.js / extract-section.js) ==============
      const isVisible = (el: Element): boolean => {
        if (!el || el.nodeType !== 1) return false;
        const he = el as unknown as HTMLElement;
        if (he.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const absTop = (el: Element): number => {
        const r = el.getBoundingClientRect();
        return Math.round(r.top + window.scrollY);
      };
      const isGradient = (v: string | null | undefined): boolean =>
        typeof v === 'string' && /gradient\(/.test(v);
      const isTransparent = (v: string | null | undefined): boolean =>
        !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
      const extractCssUrls = (value: string | null | undefined): string[] => {
        if (!value || value === 'none') return [];
        return Array.from(String(value).matchAll(/url\((['"]?)(.*?)\1\)/g))
          .map((m) => m[2])
          .filter(Boolean)
          .map((u) => {
            try {
              return new URL(u, document.baseURI).href;
            } catch {
              return u;
            }
          });
      };
      const parseTimeMs = (value: string | null | undefined): number =>
        String(value || '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const n = parseFloat(p);
            if (!Number.isFinite(n)) return 0;
            return p.endsWith('ms') ? n : n * 1000;
          })
          .reduce((max, n) => Math.max(max, n), 0);

      const luma = (rgb: string | null): number => {
        if (!rgb) return 255;
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return 255;
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      };

      // ====== section detection (extract.js port) ==========================
      const SEMANTIC_SELECTOR =
        'main > section, main > article, section, header, footer, nav, article, aside, [role="region"], [role="banner"], [role="contentinfo"], [role="navigation"]';
      const semanticCandidates = Array.from(document.querySelectorAll(SEMANTIC_SELECTOR)).filter((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.height < 200 || r.width < 600) return false;
        if (el === document.body || el === document.documentElement) return false;
        return true;
      });
      const semanticWinners = semanticCandidates.filter(
        (el) =>
          !semanticCandidates.some(
            (other) => other !== el && el.contains(other) && other.getBoundingClientRect().height >= 200,
          ),
      );

      // Y-band candidate collection: every element big enough to be a content
      // band that carries an image or real text. Shared by the page-builder
      // fallback AND the hybrid gap-fill below.
      const collectBandCandidates = (): Element[] =>
        Array.from(document.body.querySelectorAll('*')).filter((el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.height < 200 || r.width < 600) return false;
          if (el.querySelectorAll('img').length === 0 && (el.textContent || '').trim().length < 20) return false;
          if (el === document.body || el === document.documentElement) return false;
          return true;
        });
      // Y-band clustering: bucket candidates into 300px bands and keep the
      // SMALLEST qualifying element per band (avoids picking giant wrapper divs).
      const pickBandWinners = (candidates: Element[]): Array<{ band: number; el: Element }> => {
        const bands = new Map<number, Element[]>();
        for (const el of candidates) {
          const band = Math.round(absTop(el) / 300) * 300;
          if (!bands.has(band)) bands.set(band, []);
          bands.get(band)!.push(el);
        }
        const winners: Array<{ band: number; el: Element }> = [];
        for (const [band, els] of bands) {
          els.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
          });
          winners.push({ band, el: els[0] });
        }
        winners.sort((a, b) => a.band - b.band);
        return winners;
      };

      let bandWinners: Array<{ band: number; el: Element }>;
      if (semanticWinners.length >= 3) {
        // Base: the semantic landmarks in document order.
        const base = semanticWinners
          .map((el) => ({ band: absTop(el), el }))
          .sort((a, b) => a.band - b.band);
        // HYBRID pages (e.g. a Shopify/Replo theme: a handful of real
        // <section>/<footer>/<header> tags wrapping a <main> full of <div>-based
        // page-builder bands) leave large VERTICAL GAPS between semantic
        // landmarks where the div content actually lives — hero, comparison,
        // feature bands. The pure-semantic path would drop all of it. Fill each
        // gap taller than GAP_MIN with band-fallback winners whose top falls
        // inside it. Fully-semantic exports (Wix real <section>s that tile the
        // page with no >GAP_MIN gaps) get no fillers, so this is a no-op there.
        const GAP_MIN = 400;
        const bandCands = collectBandCandidates();
        const sortedCovers = base
          .map((w) => {
            const r = w.el.getBoundingClientRect();
            const top = absTop(w.el);
            return { top, bottom: top + Math.round(r.height) };
          })
          .sort((a, b) => a.top - b.top);
        const gapRanges: Array<[number, number]> = [];
        let cursor = 0;
        for (const c of sortedCovers) {
          if (c.top - cursor > GAP_MIN) gapRanges.push([cursor, c.top]);
          cursor = Math.max(cursor, c.bottom);
        }
        const fillers: Array<{ band: number; el: Element }> = [];
        for (const [lo, hi] of gapRanges) {
          // Div bands STRICTLY inside the gap: a top in [lo,hi) and not a wrapper
          // that contains a semantic landmark (those are page/section wrappers,
          // not content bands).
          const within = bandCands.filter((el) => {
            const t = absTop(el);
            return t >= lo && t < hi && !base.some((b) => el.contains(b.el));
          });
          for (const w of pickBandWinners(within)) fillers.push(w);
        }
        bandWinners = base.concat(fillers).sort((a, b) => a.band - b.band);
      } else {
        // Page-builder DOM with no semantic sections: pure Y-band fallback.
        bandWinners = pickBandWinners(collectBandCandidates());
      }

      // De-nest: drop any winner CONTAINED by another kept winner. The hybrid
      // gap-fill can pick both a content band and a grid nested inside it when
      // they fall in different 300px bands (e.g. a comparison band at y2758 and
      // its inner spec table at y2970) — the ±40px collapse below would miss
      // that, and buildSection would emit the inner content twice. Keep the
      // outer band, which carries the section heading plus the nested content.
      bandWinners = bandWinners.filter(
        (w) => !bandWinners.some((o) => o.el !== w.el && o.el.contains(w.el)),
      );

      // near-duplicate collapse (desktop/mobile DOM variants).
      // When two winners share a Y band (±40px) keep the TALLER one. Wix stacks
      // a thin style-less overlay header at top:0 over the real hero (also
      // top:0); blindly keeping the first dropped the hero and the section
      // classified as 'static'. Preferring the taller element keeps the
      // substantive section.
      const deduped: Array<{ band: number; el: Element }> = [];
      for (const w of bandWinners) {
        const collidedIdx = deduped.findIndex((d) => Math.abs(d.band - w.band) < 40);
        if (collidedIdx === -1) {
          deduped.push(w);
          continue;
        }
        const kept = deduped[collidedIdx];
        if (w.el.getBoundingClientRect().height > kept.el.getBoundingClientRect().height) {
          deduped[collidedIdx] = w;
        }
      }

      // ====== divider detection (shared heuristic) =========================
      const collectDividers = () =>
        Array.from(document.body.querySelectorAll('*')).reduce<
          Array<{ top: number; width: number; height: number; color: string }>
        >((acc, el) => {
          if (!isVisible(el)) return acc;
          const r = el.getBoundingClientRect();
          if (r.height < 1 || r.height > 4) return acc;
          if (r.width < window.innerWidth * 0.6) return acc;
          const parent = el.parentElement;
          if (parent && (parent.textContent || '').trim().length > 50) return acc;
          const cs = getComputedStyle(el);
          let color: string | null = null;
          if (!isTransparent(cs.backgroundColor)) color = cs.backgroundColor;
          else if (!isTransparent(cs.borderTopColor) && parseFloat(cs.borderTopWidth) >= 1) color = cs.borderTopColor;
          if (!color) return acc;
          acc.push({
            top: Math.round(r.top + window.scrollY),
            width: Math.round(r.width),
            height: Math.round(r.height),
            color,
          });
          return acc;
        }, []);
      const dividers = collectDividers();

      // ====== page-background gradient (for gradientSource attribution) ====
      const pageBackground = (() => {
        const pageH = document.body.scrollHeight;
        const cands = Array.from(document.body.querySelectorAll('*')).filter((el) => {
          if (!isVisible(el)) return false;
          const cs = getComputedStyle(el);
          if (!cs.backgroundImage || cs.backgroundImage === 'none') return false;
          if (!/gradient\(/.test(cs.backgroundImage)) return false;
          const r = el.getBoundingClientRect();
          return r.height >= pageH * 0.8 && r.width >= window.innerWidth * 0.6;
        });
        if (cands.length === 0) return null;
        cands.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return getComputedStyle(cands[0]).backgroundImage.slice(0, 400);
      })();

      // ====== effective-background walker (extract-section.js port) ========
      const pickEffectiveBg = (
        el: Element,
        top: number,
        bottom: number,
      ): { color: string | null; image: string | null; source: string | null } => {
        const out: { color: string | null; image: string | null; source: string | null } = {
          color: null,
          image: null,
          source: null,
        };
        const ownCs = getComputedStyle(el);
        if (!isTransparent(ownCs.backgroundColor)) {
          out.color = ownCs.backgroundColor;
          out.source = 'wrapper';
        }
        if (ownCs.backgroundImage && ownCs.backgroundImage !== 'none') {
          out.image = ownCs.backgroundImage.slice(0, 400);
          out.source = 'wrapper';
        }
        let p = el.parentElement;
        let depth = 0;
        while (p && p !== document.body && depth < 4) {
          const pcs = getComputedStyle(p);
          if (!out.image && pcs.backgroundImage && pcs.backgroundImage !== 'none') {
            out.image = pcs.backgroundImage.slice(0, 400);
            out.source = 'ancestor';
          }
          if (!out.color && !isTransparent(pcs.backgroundColor)) {
            out.color = pcs.backgroundColor;
            if (!out.source) out.source = 'ancestor';
          }
          if (out.image && isGradient(out.image)) break;
          p = p.parentElement;
          depth++;
        }
        if (!out.image || !isGradient(out.image)) {
          const sectionH = bottom - top;
          const siblings = Array.from(document.body.querySelectorAll('*')).filter((c) => {
            if (c === el || el.contains(c) || c.contains(el)) return false;
            if (!isVisible(c)) return false;
            const cr = c.getBoundingClientRect();
            const cTop = cr.top + window.scrollY;
            const cBot = cTop + cr.height;
            const overlap = Math.max(0, Math.min(cBot, bottom) - Math.max(cTop, top));
            return overlap >= sectionH * 0.8 && cr.width >= 600;
          });
          for (const c of siblings) {
            const ccs = getComputedStyle(c);
            if (ccs.backgroundImage && ccs.backgroundImage !== 'none' && isGradient(ccs.backgroundImage)) {
              out.image = ccs.backgroundImage.slice(0, 400);
              out.source = 'sibling';
              break;
            }
          }
        }
        return out.color || out.image ? out : { color: null, image: null, source: null };
      };

      // ====== motion signals for a subtree ================================
      const motionForElement = (el: Element): string[] => {
        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const data = Array.from(el.attributes || [])
          .map((a) => `${a.name}=${a.value}`)
          .join(' ')
          .toLowerCase();
        const combined = `${className} ${data}`;
        const signals: string[] = [];
        if (cs.animationName && cs.animationName !== 'none' && parseTimeMs(cs.animationDuration) > 0)
          signals.push('css-animation');
        if (cs.transitionProperty && cs.transitionProperty !== 'none' && parseTimeMs(cs.transitionDuration) > 0)
          signals.push('transition');
        if (cs.transform && cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)')
          signals.push('transform');
        if (cs.position === 'sticky' || cs.position === 'fixed') signals.push(`position-${cs.position}`);
        if (cs.willChange && cs.willChange !== 'auto') signals.push('will-change');
        if (tag === 'video') signals.push('video');
        if (tag === 'canvas') signals.push('canvas');
        if (tag === 'svg') signals.push('svg');
        if (/marquee|ticker|crawl|scrolling-text/.test(combined)) signals.push('marquee-like');
        if (/slider|carousel|swiper|splide|slideshow/.test(combined)) signals.push('carousel-like');
        if (/parallax|pin-spacer|scrolltrigger/.test(combined)) signals.push('scroll-effect');
        if (/lottie|bodymovin/.test(combined)) signals.push('lottie-like');
        return signals;
      };

      // ====== per-section feature build ===================================
      const HEADING_TAGS = /^h[1-6]$/;
      const CURRENCY = /[$€£¥]/;
      // Star-rating markers: glyphs, an "out of 5" / "N reviews" text pattern,
      // and rating-class markup (Okendo/Junip/Yotpo/Stamped widgets render these
      // client-side, so the live extractFull walk sees them even when the saved
      // HTML doesn't). Used to tell a review-grid from a generic columns block.
      const STAR_GLYPH = /[★⭐✰✪]/;
      const RATING_TEXT = /\b(out of 5|[0-5](?:\.\d)?\s*\/\s*5|\d+\s*reviews?)\b/i;
      const RATING_CLASS = /(star-?rating|rating-?stars|review-?stars|okendo|yotpo|junip|stamped|loox|judgeme|judge\.me|\bstars?\b)/i;
      const elHasStarRating = (root: Element): boolean => {
        const text = (root.textContent || '');
        if (STAR_GLYPH.test(text)) return true;
        if (RATING_TEXT.test(text)) return true;
        const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const n of nodes) {
          const cls = typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className : '';
          const al = n.getAttribute('aria-label') || '';
          const lbl = n.getAttribute('data-rating') || n.getAttribute('data-score') || '';
          if (RATING_CLASS.test(cls) || RATING_CLASS.test(al) || /star|rating/i.test(al) || lbl) return true;
        }
        // Star-row shape: a parent with 4-6 same-size small (<=28px) SVG/img
        // children laid out in a horizontal run is almost always a star rating
        // even when the widget gives the elements no semantic markers (Replo's
        // anonymous SVG-path stars). Look for such a tight uniform run.
        const containers = nodes.filter((n) => {
          const kids = Array.from(n.children).filter(isVisible);
          return kids.length >= 4 && kids.length <= 6;
        });
        for (const c of containers) {
          const kids = Array.from(c.children).filter(isVisible);
          const allSmall = kids.every((k) => {
            const tag = k.tagName.toLowerCase();
            if (tag !== 'svg' && tag !== 'img' && tag !== 'i' && tag !== 'span') return false;
            const kr = k.getBoundingClientRect();
            const side = Math.max(kr.width, kr.height);
            return side > 0 && side <= 28 && Math.abs(kr.width - kr.height) <= 8;
          });
          const tags = new Set(kids.map((k) => k.tagName));
          if (allSmall && tags.size === 1) return true;
        }
        return false;
      };
      // Quote-shaped text: a sentence wrapped in typographic or straight quotes,
      // long enough to be a real testimonial (Replo review carousels use no
      // <blockquote>). Distinguishes a testimonial band from generic prose.
      const QUOTE_TEXT = /[“"][^“”"]{40,}[”"]/;
      // App-store / google-play badge image markers (download blocks).
      const STORE_BADGE = /(app[-_ ]?store|appstore|google[-_ ]?play|googleplay|download[-_ ]on[-_ ]the|get[-_ ]it[-_ ]on|play[-_ ]?store|badge[-_]?(?:ios|android|apple|google))/i;
      const isStoreBadge = (img: { src?: string; alt?: string }): boolean =>
        STORE_BADGE.test(img.alt || '') || STORE_BADGE.test(img.src || '');
      const viewportH = window.innerHeight;

      const buildSection = (entry: { band: number; el: Element }, index: number) => {
        const el = entry.el;
        const r = el.getBoundingClientRect();
        const top = Math.round(r.top + window.scrollY);
        const height = Math.round(r.height);
        const bottom = top + height;
        const width = Math.round(r.width);
        const cs = getComputedStyle(el);

        const descendants = Array.from(el.querySelectorAll('*')).filter(isVisible);

        // headings: semantic h1-h6 OR styled text >= 28px
        const headingEls: Element[] = [];
        let maxHeadingPx = 0;
        for (const d of descendants) {
          const tag = d.tagName.toLowerCase();
          const size = parseFloat(getComputedStyle(d).fontSize) || 0;
          const ownText = Array.from(d.childNodes).some(
            (n) => n.nodeType === 3 && (n.nodeValue || '').trim().length > 2,
          );
          if (!ownText) continue;
          if (HEADING_TAGS.test(tag) || (size >= 28 && (d.textContent || '').trim().length < 120)) {
            headingEls.push(d);
            if (size > maxHeadingPx) maxHeadingPx = size;
          }
        }
        // Capture each heading's text WITH its computed font-size (px) so the
        // renderer can reproduce the source type scale faithfully — a 16px
        // eyebrow label and a 55px headline must not both collapse to generic
        // heading levels (which inverts their sizes).
        const headingData = headingEls
          .map((h) => ({
            text: (h.textContent || '').trim().slice(0, 160),
            size: Math.round(parseFloat(getComputedStyle(h).fontSize) || 0),
          }))
          .filter((h) => h.text)
          .slice(0, 12);
        const headings = headingData.map((h) => h.text);
        const headingSizes = headingData.map((h) => h.size);

        const paragraphEls = descendants.filter((d) => {
          const tag = d.tagName.toLowerCase();
          if (tag !== 'p' && tag !== 'li') return false;
          return (d.textContent || '').trim().length > 4;
        });

        // Source-VERBATIM body copy: every visible <p>/<li> text node, in
        // document order, deduped. This is the provenance source for non-heading
        // prose so the builder never has to invent it. Captured here (not later)
        // because only the live DOM knows what's actually visible. Reviews are
        // captured separately (spec.reviews) and buttons via buttonLabels, so we
        // skip <p>/<li> that sit inside a button/anchor-button to avoid dupes.
        // NOTE: the cap MUST be large enough to hold a whole paragraph verbatim.
        // The validate-artifacts BODY-COPY provenance gate compares emitted
        // paragraphs against this captured text; truncating to 600 chars made a
        // genuinely-verbatim >600-char paragraph fall below the containment
        // threshold and falsely HARD-FAIL the install. Capture the full
        // paragraph (bounded to a generous 8000 chars so a runaway node can't
        // bloat the payload — real prose paragraphs are well under that).
        const BODY_TEXT_MAX = 8000;
        const bodyTextSeen = new Set<string>();
        const bodyText: string[] = [];
        for (const p of paragraphEls) {
          const inButton = !!(p as HTMLElement).closest('button,[role="button"]');
          if (inButton) continue;
          const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length < 5 || t.length > BODY_TEXT_MAX) continue;
          if (bodyTextSeen.has(t)) continue;
          bodyTextSeen.add(t);
          bodyText.push(t);
        }

        const imgEls = descendants.filter((d) => d.tagName === 'IMG') as HTMLImageElement[];
        const buttonEls = descendants.filter((d) => {
          const tag = d.tagName.toLowerCase();
          if (tag === 'button') return true;
          if (tag === 'a') {
            const role = d.getAttribute('role');
            const cls = typeof d.className === 'string' ? d.className.toLowerCase() : '';
            return role === 'button' || /\bbtn\b|\bbutton\b/.test(cls);
          }
          return false;
        });
        const svgEls = descendants.filter((d) => d.tagName === 'svg' || d.tagName === 'SVG');
        const videoEls = descendants.filter((d) => d.tagName === 'VIDEO');
        const hasQuote =
          descendants.some(
            (d) =>
              d.tagName === 'BLOCKQUOTE' ||
              d.tagName === 'CITE' ||
              d.getAttribute('role') === 'quote',
          ) ||
          // Page-builder review carousels render quotes as plain text wrapped in
          // typographic quotes (no <blockquote>) — recognize that shape too.
          QUOTE_TEXT.test(el.textContent || '');

        // foreground images
        const fgImages = imgEls
          .map((img) => {
            const ir = img.getBoundingClientRect();
            return {
              src: (img.currentSrc || img.src || '').slice(0, 400),
              alt: img.alt || '',
              kind: 'img' as const,
              w: img.naturalWidth || Math.round(ir.width),
              h: img.naturalHeight || Math.round(ir.height),
            };
          })
          .filter((i) => i.src && i.w > 40);

        // background images (wrapper + descendants)
        const bgImages: Array<{ src: string; alt: string; kind: 'background'; w: number; h: number }> = [];
        for (const d of [el, ...descendants]) {
          const dcs = getComputedStyle(d);
          for (const u of extractCssUrls(dcs.backgroundImage)) {
            const dr = d.getBoundingClientRect();
            if (dr.width < 80 || dr.height < 60) continue;
            bgImages.push({
              src: u.slice(0, 400),
              alt: d.getAttribute('aria-label') || d.getAttribute('title') || '',
              kind: 'background',
              w: Math.round(dr.width),
              h: Math.round(dr.height),
            });
          }
        }
        // Content background-images that live OUTSIDE this section's DOM subtree
        // but VISUALLY within its Y-band. A 2-column hero often renders its
        // product photo as a CSS background-image on the IMAGE column, which is a
        // SIBLING of the detected (text-column) section element — so the
        // descendant scan above misses it and the hero loses its photo. Assign a
        // large RASTER bg-image to the section whose band contains its vertical
        // center (near-unique: section bands don't overlap). Excludes the
        // section's own ancestors (their bg is the section background, not
        // content) and gradients/data-URIs (decorative, not photos).
        const RASTER_BG = /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i;
        for (const d of Array.from(document.body.querySelectorAll('*'))) {
          if (!isVisible(d) || el.contains(d) || d.contains(el)) continue;
          const dr = d.getBoundingClientRect();
          if (dr.width < 200 || dr.height < 200) continue;
          const cy = dr.top + window.scrollY + dr.height / 2;
          if (cy < top || cy >= bottom) continue;
          const dcs = getComputedStyle(d);
          for (const u of extractCssUrls(dcs.backgroundImage)) {
            if (!RASTER_BG.test(u)) continue;
            bgImages.push({
              src: u.slice(0, 400),
              alt: d.getAttribute('aria-label') || d.getAttribute('title') || '',
              kind: 'background',
              w: Math.round(dr.width),
              h: Math.round(dr.height),
            });
          }
        }
        // dedupe images by params-stripped src
        const seen = new Set<string>();
        const allImages: Array<{ src: string; alt: string; kind: 'img' | 'background'; w: number; h: number }> = [];
        for (const im of [...fgImages, ...bgImages]) {
          const key = im.src.replace(/([?&])(w|h|q|quality|fit|crop)_[^&]+/g, '$1');
          if (seen.has(key)) continue;
          seen.add(key);
          allImages.push(im);
        }

        // ---- inline icon graphics (svg + icon-font glyphs) ------------------
        // The image walk above only collects <img>/background. Icons that arrive
        // as inline <svg> or as an icon-font glyph (small element whose computed
        // font-family is a known icon font) are captured here. Policy/filtering
        // happens in Node (filterIconCandidate); the walk just gathers candidates.
        const ICON_FONT_RE =
          /fontawesome|font awesome|material icons|material symbols|glyphicon|dashicons|ionicons|feather|wix-icon|wix madefor icons|icomoon|eicons|elementor icons/;
        const iconCandidates: Array<{
          kind: 'svg' | 'glyph';
          markup?: string;
          glyph?: string;
          fontFamily?: string;
          width: number;
          height: number;
        }> = [];
        const iconSeen = new Set<string>();
        for (const d of descendants) {
          const tag = d.tagName.toLowerCase();
          // Skip svgs that live inside an <a>/<button> that's already a CTA? No —
          // an icon next to a card heading is exactly what we want; keep them all.
          if (tag === 'svg') {
            // Skip svgs nested inside another svg (we serialize the outermost only).
            if (d.parentElement && d.parentElement.closest('svg')) continue;
            const ir = d.getBoundingClientRect();
            let markup = '';
            try {
              markup = d.outerHTML || '';
            } catch {
              markup = '';
            }
            // de-dupe identical glyphs (same markup repeated across cards is fine
            // to keep — they're distinct slots — so key on markup+rounded-top).
            const key = `svg:${Math.round(ir.top + window.scrollY)}:${markup.length}`;
            if (iconSeen.has(key)) continue;
            iconSeen.add(key);
            iconCandidates.push({
              kind: 'svg',
              markup,
              width: Math.round(ir.width),
              height: Math.round(ir.height),
            });
            continue;
          }
          // icon-font glyph: an element whose computed font-family is an icon font
          // AND which renders a single short glyph (no real prose). Catches
          // <i class="fa fa-check"></i> (glyph via ::before) and <span> glyphs.
          const dcs = getComputedStyle(d);
          const fam = (dcs.fontFamily || '').toLowerCase();
          if (!ICON_FONT_RE.test(fam)) continue;
          // Pull the glyph: own text first, else the ::before content (icon fonts
          // typically inject the codepoint via ::before).
          const ownText = (d.textContent || '').trim();
          let glyph = ownText;
          if (!glyph) {
            const before = getComputedStyle(d, '::before').content;
            if (before && before !== 'none' && before !== 'normal') {
              glyph = before.replace(/^["']|["']$/g, '');
            }
          }
          if (!glyph) continue;
          const ir = d.getBoundingClientRect();
          const key = `glyph:${Math.round(ir.top + window.scrollY)}:${glyph}`;
          if (iconSeen.has(key)) continue;
          iconSeen.add(key);
          iconCandidates.push({
            kind: 'glyph',
            glyph,
            fontFamily: dcs.fontFamily || '',
            width: Math.round(ir.width),
            height: Math.round(ir.height),
          });
        }

        const buttonLabels = buttonEls
          .map((b) => (b.textContent || '').trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 12);

        // repeated direct-child units (cards / columns / rows)
        // Use the tightest content wrapper whose direct children form a UNIFORM
        // repeated set (a card row / column grid) as the unit grid. Page
        // builders (Replo/Shopify) nest a single product's parts under their own
        // wrapper, so "most children" alone picks the wrong level (one product's
        // image+title+price+CTA looks like a 4-card grid). Prefer hosts whose
        // children share a tag and each carry their own image — the hallmark of
        // a real product/card row — and lay out horizontally (flex-row/grid).
        const gridHost = (() => {
          const candidates = [el, ...descendants].filter((d) => {
            const kids = Array.from(d.children).filter(isVisible);
            return kids.length >= 2 && kids.length <= 12;
          });
          let best: Element | null = null;
          let bestScore = -1;
          for (const c of candidates) {
            const kids = Array.from(c.children).filter(isVisible);
            const tags = new Set(kids.map((k) => k.tagName));
            const uniformTag = tags.size === 1;
            // Fraction of children that contain at least one image (card-like).
            const withImg = kids.filter((k) => k.querySelector('img')).length / kids.length;
            const hcs = getComputedStyle(c);
            const horiz =
              (hcs.display === 'flex' && hcs.flexDirection !== 'column') ||
              hcs.display === 'grid' ||
              hcs.display === 'inline-grid';
            // Score: reward uniformity, per-child imagery, horizontal layout, and
            // a moderate count (real card rows are 2-6 wide). The raw child count
            // is only a weak tiebreaker so a deep one-product wrapper can't win.
            const countFit = kids.length >= 2 && kids.length <= 6 ? 1 : 0.3;
            const score =
              (uniformTag ? 2 : 0) +
              withImg * 3 +
              (horiz ? 1.5 : 0) +
              countFit +
              kids.length * 0.05;
            if (score > bestScore) {
              best = c;
              bestScore = score;
            }
          }
          return best;
        })();
        const childUnits = gridHost ? Array.from(gridHost.children).filter(isVisible) : [];
        const repeatedChildren = childUnits.map((child) => {
          const kidDesc = [child, ...Array.from(child.querySelectorAll('*'))].filter(isVisible);
          let headingCount = 0;
          let paragraphCount = 0;
          let imageCount = 0;
          let buttonCount = 0;
          let minFontSizePx = Infinity;
          let hasCurrency = false;
          let hasQuote = false;
          for (const k of kidDesc) {
            const tag = k.tagName.toLowerCase();
            const kcs = getComputedStyle(k);
            const size = parseFloat(kcs.fontSize) || 0;
            const ownText = Array.from(k.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => (n.nodeValue || '').trim())
              .join(' ');
            if (HEADING_TAGS.test(tag) || (size >= 24 && ownText.length > 2 && ownText.length < 120)) headingCount++;
            else if ((tag === 'p' || tag === 'li') && ownText.length > 4) paragraphCount++;
            if (tag === 'img') imageCount++;
            if (tag === 'button' || (tag === 'a' && (k.getAttribute('role') === 'button' || /\bbtn\b|\bbutton\b/.test(typeof k.className === 'string' ? k.className.toLowerCase() : '')))) buttonCount++;
            if (ownText.length > 0 && size > 0 && size < minFontSizePx) minFontSizePx = size;
            if (CURRENCY.test(ownText)) hasCurrency = true;
            if (tag === 'blockquote' || tag === 'cite' || k.getAttribute('role') === 'quote') hasQuote = true;
          }
          // Fallback: prices/quotes are often deeper than a single element's own
          // text node (Replo wraps `$99.99` in nested spans). Check the card's
          // full subtree text once — but as a price-shaped token, not a stray $
          // in legal copy.
          if (!hasCurrency) {
            const cardText = (child.textContent || '');
            if (/[$€£¥]\s?\d/.test(cardText)) hasCurrency = true;
          }
          return {
            headingCount,
            paragraphCount,
            imageCount,
            buttonCount,
            minFontSizePx: Number.isFinite(minFontSizePx) ? minFontSizePx : 0,
            hasCurrency,
            hasStarRating: elHasStarRating(child),
            hasQuote,
          };
        });

        // Per-cell STRUCTURED content for grid/columns sections (icon-feature
        // rows, sound-library columns, comparison columns). repeatedChildren
        // above captures only COUNTS; this captures the actual ordered text +
        // image + icon PER cell so the renderer can emit a faithful N-column
        // grid instead of flattening every cell into one stacked text band
        // (which also drops mid-size labels that are neither heading-sized nor
        // <p>/<li>). Only captured when a uniform multi-cell grid host exists;
        // the renderer decides whether to use it (card-grids keep their own path).
        const cells = childUnits.map((cell) => {
          const cdesc = [cell, ...Array.from(cell.querySelectorAll('*'))].filter(isVisible);
          const texts: Array<{ t: string; size: number }> = [];
          const seenText = new Set<string>();
          for (const d of cdesc) {
            const own = Array.from(d.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => (n.nodeValue || '').trim())
              .filter(Boolean)
              .join(' ');
            if (own.length < 1 || own.length > 400) continue;
            if (seenText.has(own)) continue;
            seenText.add(own);
            texts.push({ t: own, size: parseFloat(getComputedStyle(d).fontSize) || 0 });
          }
          let image: { src: string; alt: string; w: number; h: number } | null = null;
          const imgEl = cell.querySelector('img');
          if (imgEl) {
            const ir = imgEl.getBoundingClientRect();
            const src = (imgEl as HTMLImageElement).currentSrc || (imgEl as HTMLImageElement).src || '';
            if (src) image = { src, alt: imgEl.getAttribute('alt') || '', w: Math.round(ir.width), h: Math.round(ir.height) };
          }
          let icon: { markup: string; w: number; h: number } | null = null;
          const svgEl = cell.querySelector('svg');
          if (svgEl) {
            const sr = svgEl.getBoundingClientRect();
            if (sr.width > 0 && sr.width <= 128 && sr.height > 0 && sr.height <= 128) {
              try {
                icon = { markup: (svgEl as unknown as HTMLElement).outerHTML || '', w: Math.round(sr.width), h: Math.round(sr.height) };
              } catch {
                icon = null;
              }
            }
          }
          let button = '';
          const btn = cell.querySelector('button, a[role="button"]');
          if (btn) button = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          // Card container styling: a feature CELL is often a styled card (its own
          // opaque background + rounded corners on a plain section), not just a
          // text column. Capture the cell's own opaque bg + radius, else the
          // largest opaque-bg descendant (page builders wrap the card surface a
          // level down). Lets the renderer emit distinct cards instead of a flat band.
          const opaqueBg = (c: string | null): string | null => {
            const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
            if (!m) return null;
            const a = m[4] === undefined ? 1 : parseFloat(m[4]);
            return a > 0.5 ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : null;
          };
          let bg: string | null = null;
          let radius = 0;
          const cellCs = getComputedStyle(cell);
          bg = opaqueBg(cellCs.backgroundColor);
          radius = parseFloat(cellCs.borderRadius) || 0;
          if (!bg) {
            const cr = cell.getBoundingClientRect();
            for (const d of Array.from(cell.querySelectorAll('*'))) {
              const o = opaqueBg(getComputedStyle(d).backgroundColor);
              if (!o) continue;
              const dr = d.getBoundingClientRect();
              if (dr.width >= cr.width * 0.6 && dr.height >= cr.height * 0.5) {
                bg = o;
                radius = parseFloat(getComputedStyle(d).borderRadius) || radius;
                break;
              }
            }
          }
          return { texts: texts.slice(0, 14), image, icon, button: button.slice(0, 80), bg, radius: Math.round(radius) };
        });

        // motion signals across the section
        const motionSet = new Set<string>();
        let animatedElements = 0;
        for (const d of [el, ...descendants]) {
          const sig = motionForElement(d);
          if (sig.length) {
            animatedElements++;
            for (const s of sig) motionSet.add(s);
          }
        }
        const motionSignals = Array.from(motionSet);

        // effective bg + brightness
        const eff = pickEffectiveBg(el, top, bottom);
        let gradient: string | null = eff.image && isGradient(eff.image) ? eff.image : null;
        let gradientSource: string | null = gradient ? eff.source : null;
        // page-level gradient attribution (so downstream skips re-painting)
        if (gradient && pageBackground && gradient === pageBackground) {
          gradientSource = 'pageBackground';
        }
        const baseColor = eff.color || cs.backgroundColor;
        const backgroundBrightness = luma(baseColor && !isTransparent(baseColor) ? baseColor : 'rgb(255,255,255)');

        // dividers bracketing this band
        const dAbove =
          dividers.find((d) => Math.abs(d.top - top) <= 40 && d.top <= top + 10) || null;
        const dBelow =
          dividers.find((d) => Math.abs(d.top - bottom) <= 40 && d.top >= bottom - 40) || null;

        // layout snapshot
        const childLayout: SectionSpecLayout['childLayout'] = (() => {
          const host = gridHost || el;
          const hcs = getComputedStyle(host);
          if (hcs.display === 'grid' || hcs.display === 'inline-grid') return 'grid';
          if (hcs.display === 'flex' || hcs.display === 'inline-flex') {
            return hcs.flexDirection === 'column' ? 'flex-column' : 'flex-row';
          }
          return 'stack';
        })();
        const gapVal = (() => {
          const host = gridHost || el;
          const hcs = getComputedStyle(host);
          return hcs.gap && hcs.gap !== 'normal' ? hcs.gap : '0px';
        })();

        const textLength = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
        const avgImageAspect = fgImages.length
          ? fgImages.reduce((s, im) => s + (im.h ? im.w / im.h : 1), 0) / fgImages.length
          : 0;

        const roleAttr = el.getAttribute('role');
        const roleHint: SectionFeatures['roleHint'] =
          roleAttr === 'banner'
            ? 'banner'
            : roleAttr === 'contentinfo'
              ? 'contentinfo'
              : roleAttr === 'navigation'
                ? 'navigation'
                : null;

        const features: SectionFeatures = {
          tag: el.tagName.toLowerCase(),
          roleHint,
          top,
          height,
          width,
          isAboveFold: top < viewportH * 0.5 && height >= viewportH * 0.5,
          viewportRatio: viewportH ? height / viewportH : 0,
          headingCount: headingEls.length,
          maxHeadingPx,
          paragraphCount: paragraphEls.length,
          imageCount: fgImages.length,
          bgImageCount: bgImages.length,
          videoCount: videoEls.length,
          svgCount: svgEls.length,
          buttonCount: buttonEls.length,
          hasQuote,
          textLength,
          backgroundBrightness,
          hasGradient: !!gradient,
          repeatedChildren,
          motionSignals,
          avgImageAspect,
          hasStarRating: elHasStarRating(el),
          hasStoreBadge: allImages.some((im) => isStoreBadge(im)),
        };

        const layout: SectionSpecLayout = {
          containerWidth: width,
          padding: cs.padding || '0px',
          childLayout,
          columnCount: repeatedChildren.length,
          gap: gapVal,
        };

        // Serialized section markup — handed back to Node so the deterministic
        // review extractor (review-extract.ts) can pull source-verbatim review
        // text without a second browser pass. Capped so a huge section doesn't
        // bloat the evaluate payload; reviews live near the top of their band.
        let sectionHtml = '';
        try {
          sectionHtml = (el as HTMLElement).outerHTML || '';
        } catch {
          sectionHtml = '';
        }
        if (sectionHtml.length > 600_000) sectionHtml = sectionHtml.slice(0, 600_000);

        return {
          features,
          headings,
          headingSizes,
          bodyText: bodyText.slice(0, 40),
          buttonLabels,
          images: allImages.slice(0, 36),
          iconCandidates: iconCandidates.slice(0, 48),
          backgroundColor: baseColor && !isTransparent(baseColor) ? baseColor : 'rgb(255, 255, 255)',
          gradient,
          gradientSource: gradientSource as RawSectionGradientSource,
          dividerAbove: dAbove ? { color: dAbove.color, thickness: dAbove.height } : null,
          dividerBelow: dBelow ? { color: dBelow.color, thickness: dBelow.height } : null,
          layout,
          motionAnimatedElements: animatedElements,
          sectionHtml,
          cells,
        };
      };

      type RawSectionGradientSource =
        | 'wrapper'
        | 'ancestor'
        | 'sibling'
        | 'pageBackground'
        | 'inherited'
        | null;

      return deduped.slice(0, 25).map((entry, i) => buildSection(entry, i));
    }),
    timeoutMs,
  );

  // Classify back in Node (same code as the unit tests) and assemble specs.
  return raw.map((r, i) => {
    const rr = r as unknown as RawSection & { motionAnimatedElements: number };
    let interactionModel = classifySection(rr.features);

    // Deterministic review capture: pull source-verbatim reviews from the
    // section's served markup. The extractor is pure and self-gating — it only
    // returns a review when a unit carries BOTH a star run AND a quote-marked
    // testimonial — so it's safe to run on every section (a hero/product band
    // yields []). This rescues Replo review carousels the geometry classifier
    // missed: their slides nest too deep to read as repeated children, so the
    // band classifies as 'static', yet the real reviews sit inline in the HTML.
    // When reviews ARE found we promote the model so downstream builds the grid
    // VERBATIM. When a band looks like reviews but NONE are captured, the model
    // stays put and the builder uses the missing-content fallback — we NEVER
    // synthesize quotes.
    let reviews: ExtractedReview[] | undefined;
    if (rr.sectionHtml) {
      const found = extractReviewsFromHtml(rr.sectionHtml);
      if (found.length > 0) {
        reviews = found;
        interactionModel = 'review-grid';
      }
    }

    // Deterministic FAQ capture: when a band reads as an FAQ (a "Frequently
    // Asked Questions" heading, or accordion markup), pull source-verbatim
    // {question, answer} pairs so the renderer emits a faithful wp:details
    // accordion instead of dumping every answer as one wall of prose with
    // disconnected question labels. Gated on FAQ signals so a product-spec
    // accordion elsewhere doesn't get mistaken for an FAQ. Reviews take
    // precedence (a review band is never an FAQ).
    let faqs: ExtractedFaq[] | undefined;
    if (!reviews && rr.sectionHtml) {
      const looksFaq =
        (rr.headings ?? []).some((h) => /frequently asked questions|\bfaqs?\b/i.test(h)) ||
        /faq-question|faq__question|class="[^"]*\bfaq\b/i.test(rr.sectionHtml);
      if (looksFaq) {
        const found = extractFaqsFromHtml(rr.sectionHtml);
        if (found.length >= 2) faqs = found;
      }
    }

    // Build structured grid cells from the raw per-cell capture. Each cell's
    // title is its largest-font text; the rest is body in document order. Only
    // surfaced when there are >=2 non-empty cells (a real grid), so a hero's
    // 2-up text|image split or a single-child wrapper doesn't masquerade as one.
    let cells: SectionSpecCell[] | undefined;
    const rawCells = (rr as unknown as { cells?: RawCell[] }).cells;
    if (Array.isArray(rawCells) && rawCells.length >= 2) {
      const built = rawCells.map((c): SectionSpecCell => {
        const texts = (c.texts ?? []).filter((t) => t.t && t.t.trim().length > 0);
        const maxSize = texts.reduce((m, t) => Math.max(m, t.size || 0), 0);
        const headingIdx = texts.findIndex((t) => (t.size || 0) === maxSize && maxSize > 0);
        const heading = headingIdx >= 0 ? texts[headingIdx].t.trim() : null;
        const body = texts.filter((_t, i) => i !== headingIdx).map((t) => t.t.trim());
        const image: SectionSpecImage | null = c.image && c.image.src
          ? {
              url: rewriteThroughMediaMap(c.image.src, mediaMap),
              sourceUrl: c.image.src,
              alt: c.image.alt ?? '',
              kind: 'img',
              width: c.image.w,
              height: c.image.h,
            }
          : null;
        const icon: SectionSpecIcon | null =
          c.icon && c.icon.markup ? { kind: 'svg', markup: c.icon.markup, width: c.icon.w, height: c.icon.h } : null;
        return {
          heading,
          body,
          image,
          icon,
          button: c.button ? c.button.trim() : null,
          background: c.bg ?? null,
          radius: c.radius ?? 0,
        };
      });
      // A meaningful grid: at least 2 cells carrying real content (a heading,
      // body, or image). Filters out decorative/empty wrappers.
      const meaningful = built.filter((c) => c.heading || c.body.length > 0 || c.image);
      if (meaningful.length >= 2) cells = meaningful;
    }

    return {
      sectionIndex: i,
      interactionModel,
      top: rr.features.top,
      height: rr.features.height,
      headings: rr.headings,
      headingSizes: rr.headingSizes ?? [],
      bodyText: rr.bodyText ?? [],
      buttonLabels: rr.buttonLabels,
      images: rr.images.map((im) => ({
        url: rewriteThroughMediaMap(im.src, mediaMap),
        sourceUrl: im.src,
        alt: im.alt,
        kind: im.kind,
        width: im.w,
        height: im.h,
      })),
      // Filter/normalize icon candidates in Node (pure, unit-tested). Inline SVGs
      // keep their raw bytes in `markup` so the orchestrator can write them to
      // assets/icon-NN.svg and reference via get_theme_file_uri in an wp:image
      // (wp:html is banned — see SectionSpecIcon doc + block-policy.ts).
      icons: (rr.iconCandidates ?? [])
        .map((c) => filterIconCandidate(c))
        .filter((i): i is SectionSpecIcon => i !== null),
      backgroundBrightness: rr.features.backgroundBrightness,
      backgroundColor: rr.backgroundColor,
      gradient: rr.gradient,
      gradientSource: rr.gradientSource,
      motionProfile: {
        motionClass: deriveMotionClass(rr.features.motionSignals),
        signals: rr.features.motionSignals,
        animatedElements: rr.motionAnimatedElements,
      },
      dividerAbove: rr.dividerAbove,
      dividerBelow: rr.dividerBelow,
      layout: rr.layout,
      ...(reviews ? { reviews } : {}),
      ...(faqs ? { faqs } : {}),
      ...(cells ? { cells } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// extractFullFromUrl — navigation entry point. Launches Chromium via the repo's
// shared connectBrowser helper (same as screenshotter.ts), navigates, settles,
// triggers lazy-load, runs extractFull, then tears down. Same-origin enforced.
// ---------------------------------------------------------------------------

export async function extractFullFromUrl(
  url: string,
  mediaMap: Record<string, string>,
  opts: { cdpPort?: number; timeoutMs?: number; settleMs?: number } = {},
): Promise<SectionSpec[]> {
  // Same-origin hygiene: a single URL trivially shares its own origin, but this
  // also normalizes/validates the URL the same way the capture pipeline does.
  enforceSameOrigin(url, [url]);

  const pw = await getPlaywright();
  const browser = opts.cdpPort
    ? await pw.chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`)
    : await pw.chromium.launch({ headless: true });

  // Polyfill tsx/esbuild's __name helper inside the page (mirrors screenshotter).
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(`
    if (typeof globalThis.__name === 'undefined') {
      globalThis.__name = function (fn) { return fn; };
    }
  `);

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await waitForStable(page, opts.settleMs ?? 1_000);
    await triggerLazyLoad(page);
    return await extractFull(page, mediaMap, opts.timeoutMs ?? 15_000);
  } finally {
    try {
      await context.close();
    } catch {
      /* best-effort */
    }
    try {
      await browser.close();
    } catch {
      /* best-effort */
    }
  }
}

// Keep slugify referenced for callers that key specs by URL; re-export the
// shared one so the orchestrator persisting specs uses the same derivation.
export { slugify };
