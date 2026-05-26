// src/lib/replicate/page-reconstruct.ts
//
// Deterministic spec -> block-pattern renderer for non-homepage content pages.
//
//   SectionSpec[] (from liberate_section_extract detail:"full")
//        │  stripChrome (drop header/nav + sitewide footer sections)
//        │  renderSection (model -> faithful core-block markup, verbatim copy)
//        ▼
//   { php, expectedText[], bodyText[], expectedAssets[], provenanceFlags[] }
//
// The renderer is PURE and SOURCE-FAITHFUL by construction:
//   - All emitted copy is the spec's captured headings / bodyText / reviews,
//     entity/whitespace-normalized only — NEVER paraphrased or synthesized.
//   - Image slots reference the spec image's already-mediaMapped WP URL; a
//     slot whose image never reached the WP library (still a remote CDN URL)
//     is replaced with the missing-media placeholder + a provenanceFlag, never
//     an unrelated stand-in.
//   - Colors/spacing emit theme token slugs, never raw hex.
//   - No raw <?php / <script> / on*= — the markup is core-block-comment only.
//
// The artifact this returns is consumed by:
//   - liberate_validate_artifacts (provenance + escaping + injection gate)
//   - the patterns/page-<slug>.php file written into the theme bundle
//   - the reconstructedPages scaffold option (wires page-<slug>.html -> pattern)
//
// This is the same contract the about-us reconstruction satisfied; this module
// generalizes it across the remaining content-page interaction models.

import type { SectionSpec, SectionSpecImage, SectionSpecIcon } from './section-extract.js';
import { nearestToken, brightness, type PaletteToken } from './footer-color.js';
import type { ExtractedReview } from './review-extract.js';

/**
 * A source-VERBATIM FAQ question/answer pair. The renderer emits these as a
 * `wp:details` accordion (faithful to the source's expand/collapse UX). FAQ
 * answers that are JS-hydrated and absent from a static capture must be
 * re-captured with the accordions expanded and attached here — NEVER invented.
 * When a question's answer could not be captured, leave `answer` empty and the
 * renderer emits the missing-content placeholder + a provenance flag.
 */
export interface FaqPair {
  question: string;
  answer: string;
}

/** A spec section may carry source-verbatim FAQ pairs (re-captured from an accordion). */
type SectionSpecWithFaqs = SectionSpec & { faqs?: FaqPair[] };

export interface ReconstructOptions {
  /** Fully-qualified pattern slug, e.g. "getsnooz-com-replica/page-go2". */
  patternSlug: string;
  /** Human-readable pattern title for the PHP doc-comment. */
  title: string;
  /**
   * Theme palette tokens ({slug, hex}) — used to map a captured card/cell
   * background color to the nearest token (the gate forbids inline hex, so card
   * surfaces must reference a token slug). When absent, feature cells render as
   * plain columns rather than styled cards.
   */
  paletteTokens?: PaletteToken[];
}

export interface ReconstructResult {
  /** The pattern file body (PHP doc-comment header + block markup). */
  php: string;
  /** Verbatim headings + button labels + review quotes (provenance: headings). */
  expectedText: string[];
  /** Verbatim body prose (provenance: body <p> corpus). */
  bodyText: string[];
  /** WP-library asset URLs the pattern references. */
  expectedAssets: string[];
  /** Human-readable notes about missing-media / missing-content fallbacks. */
  provenanceFlags: string[];
  /** Count of page-body sections rendered (after chrome strip). */
  sectionsRendered: number;
  /**
   * Theme SVG assets the pattern references via get_theme_file_uri() (feature /
   * comparison icons). The orchestrator/driver MUST write each `svg` to the
   * theme's `path` (e.g. assets/icon-0.svg) before install, or the core/image
   * references 404. Sanitized (no script/event handlers) — safe to write.
   */
  iconAssets: Array<{ path: string; svg: string }>;
}

// ---------------------------------------------------------------------------
// HTML escaping — mirrors theme-scaffold.escapeHtml. Source text is escaped on
// the way into block markup so a stray "<" / "&" / quote in captured copy can't
// break the block comment or inject markup.
// ---------------------------------------------------------------------------
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Collapse whitespace; drop zero-width + soft-hyphen noise. Keeps copy verbatim. */
export function normalizeCopy(s: string): string {
  return s
    .replace(/­/g, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MISSING_IMAGE_PLACEHOLDER = '[image unavailable — not captured]';

/**
 * Minimum side (px) for an image to qualify as a section's LEAD photo. Below
 * this it's decorative — a quote-mark glyph, badge, or icon that a page builder
 * renders as a small <img>. Blowing such a graphic up to fill a hero/text-band
 * lead slot is the "giant quotation mark where the product photo should be"
 * artifact, so the lead-image slots skip sub-threshold images.
 */
const MIN_LEAD_IMAGE_PX = 200;

/** First image large enough to be a real lead photo (not a decorative glyph). */
function pickLeadImage(images: SectionSpecImage[]): SectionSpecImage | undefined {
  return images.find((im) => Math.min(im.width || 0, im.height || 0) >= MIN_LEAD_IMAGE_PX);
}

/**
 * Neutralize a value interpolated into the PHP pattern doc-comment header so a
 * crafted source-derived title/slug cannot break OUT of the doc-comment and
 * inject executable PHP. A title shaped like a comment-close + code + comment-open
 * would, in PHP, close the doc-comment early, run the code, then re-open a comment
 * that swallows the rest through the real header close — a comment-breakout RCE.
 * (`validate_artifacts` also defends this via a tempered header match, but the
 * renderer must never EMIT such a header in the first place.) The header is
 * metadata only, never rendered copy, so stripping comment/PHP-tag delimiters and
 * collapsing to one line is lossless here.
 */
export function sanitizePatternHeaderField(s: string): string {
  return s
    .replace(/\*\//g, '') // cannot close the doc-comment early
    .replace(/\/\*/g, '') // cannot open a nested comment
    .replace(/<\?/g, '') // no PHP open tag
    .replace(/\?>/g, '') // no PHP close tag
    .replace(/[\r\n]+/g, ' ') // single line
    .trim();
}

/** A WP media-library URL is the migrated form; anything else is a capture gap. */
function isWpUrl(u: string): boolean {
  return /\/wp-content\/uploads\//i.test(u);
}

/**
 * True when a section sits on a colorful LIGHT background tint (the source's
 * mint feature bands), so it should render on the raised surface token instead
 * of flattening to white. Excludes white/near-white (brightness >=245), dark
 * bands (<100 — those need an inverse-text treatment, handled separately), and
 * neutral greys (low saturation). Navy text stays readable on the light mint, so
 * no per-emitter text-color cascade is needed for this case.
 */
function isTintedSection(s: SectionSpec): boolean {
  const b = s.backgroundBrightness;
  if (b >= 245 || b < 100) return false;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s.backgroundColor || '');
  if (!m) return false;
  const sat = Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]);
  return sat >= 25;
}

/** Footer/nav chrome detection — the sitewide Shopify footer leaks into every
 *  Replo page capture as trailing sections. We render page body only; header +
 *  footer come from the theme parts. */
function isChromeSection(s: SectionSpec): boolean {
  if (s.interactionModel === 'footer' || s.interactionModel === 'nav') return true;
  const heads = s.headings.map((h) => normalizeCopy(h).toLowerCase());
  const hasFooterNav =
    heads.includes('shop') && heads.includes('support') && heads.includes('company');
  const body = (s.bodyText ?? []).map((b) => normalizeCopy(b));
  const hasNewsletter = body.some((b) => /get some good snooz/i.test(b));
  return hasFooterNav || hasNewsletter;
}

/**
 * Drop trailing sitewide chrome (footer + newsletter) and any leading nav.
 * Only strips from the ends — a dark-bg content band in the page middle (e.g.
 * the "100 Night Happiness Guarantee" block) is preserved.
 */
export function stripChrome(sections: SectionSpec[]): SectionSpec[] {
  let start = 0;
  let end = sections.length;
  while (start < end && sections[start].interactionModel === 'nav') start++;
  while (end > start && isChromeSection(sections[end - 1])) end--;
  return sections.slice(start, end);
}

// ---------------------------------------------------------------------------
// Block emitters. Each returns { markup, expectedText, bodyText, assets, flags }.
// ---------------------------------------------------------------------------

interface BlockOut {
  markup: string;
  expectedText: string[];
  bodyText: string[];
  assets: string[];
  flags: string[];
  /** Theme SVG assets this block references (path relative to the theme root + bytes). */
  iconAssets: Array<{ path: string; svg: string }>;
}

function emptyOut(): BlockOut {
  return { markup: '', expectedText: [], bodyText: [], assets: [], flags: [], iconAssets: [] };
}

/**
 * Sanitize a source-captured inline SVG before it's written as a theme asset and
 * referenced from a `core/image`. Loading SVG via `<img src>` already prevents
 * script execution in browsers, but strip active content defensively (the SVG is
 * source-derived = attacker-controlled per the project trust boundary): no
 * <script>, <foreignObject>, event-handler attributes, or javascript: URLs.
 */
export function sanitizeSvgAsset(svg: string): string {
  return (
    svg
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
      // SMIL animation elements can set event-handler attributes at runtime
      // (e.g. <set attributeName="onload" to="…">) — a direct-navigation XSS
      // vector that the on*= attribute strip below misses. A static icon glyph
      // never animates, so drop these wholesale (both self-closing and paired).
      .replace(/<(set|animate|animateTransform|animateMotion)\b[\s\S]*?(?:\/>|<\/\1\s*>)/gi, '')
      // External / script href on <a>/<use>/<image> (tracking + SSRF-ish on
      // direct navigation). Keep local #fragment refs and inline data:image.
      .replace(
        /\s(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:(?!image\/))[^"']*["']/gi,
        '',
      )
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '')
      .trim()
  );
}

/** Shared render context threaded through a single reconstructPagePattern call. */
interface RenderCtx {
  /** Alternating side index for media-text bands. */
  mediaTextIndex: number;
  /** Monotonic counter for unique icon-asset filenames across the page. */
  iconCounter: number;
  /** Theme palette tokens for mapping captured card backgrounds → token slugs. */
  paletteTokens: PaletteToken[];
}

/**
 * Emit a cell icon as a `core/image` referencing a theme SVG asset via the
 * gate-sanctioned `get_theme_file_uri()` form (theme-relative, no slug needed;
 * wp:html is banned so the glyph can't be inlined). Registers the sanitized SVG
 * bytes on `out.iconAssets` for the driver to write to assets/. Returns '' when
 * the icon has no usable markup.
 */
function iconImageBlock(icon: SectionSpecIcon, out: BlockOut, ctx: RenderCtx, sizePx = 48): string {
  if (icon.kind !== 'svg' || !icon.markup) return '';
  const svg = sanitizeSvgAsset(icon.markup);
  if (!svg || !/<svg[\s>]/i.test(svg)) return '';
  const path = `assets/icon-${ctx.iconCounter++}.svg`;
  out.iconAssets.push({ path, svg });
  const src = `<?php echo esc_url(get_theme_file_uri('${path}')); ?>`;
  return (
    `<!-- wp:image {"width":"${sizePx}px","height":"${sizePx}px","sizeSlug":"full","align":"center"} -->\n` +
    `<figure class="wp-block-image aligncenter size-full is-resized"><img src="${src}" alt="" style="width:${sizePx}px;height:${sizePx}px"/></figure>\n` +
    `<!-- /wp:image -->`
  );
}

/** Pick the first usable WP image; if none reached the library, flag it. */
function resolveImage(
  img: SectionSpecImage | undefined,
  out: BlockOut,
  context: string,
): { url: string; alt: string; usable: boolean } {
  if (!img) {
    out.flags.push(`${context}: no image in spec — placeholder emitted`);
    return { url: '', alt: MISSING_IMAGE_PLACEHOLDER, usable: false };
  }
  if (!isWpUrl(img.url)) {
    out.flags.push(`${context}: image not in WP library (${img.sourceUrl}) — placeholder emitted`);
    return { url: '', alt: MISSING_IMAGE_PLACEHOLDER, usable: false };
  }
  return { url: img.url, alt: img.alt || '', usable: true };
}

function imageBlock(
  img: SectionSpecImage | undefined,
  out: BlockOut,
  context: string,
  opts: { rounded?: boolean; align?: 'center' | null } = {},
): string {
  const r = resolveImage(img, out, context);
  const roundStyle = opts.rounded ? ',"style":{"border":{"radius":"12px"}}' : '';
  const roundClass = opts.rounded ? ' has-custom-border' : '';
  const alignAttr = opts.align === 'center' ? ',"align":"center"' : '';
  const alignClass = opts.align === 'center' ? ' aligncenter' : '';
  if (!r.usable) {
    // A sized placeholder paragraph (gate-exempt text) instead of an unrelated photo.
    return (
      `<!-- wp:paragraph {"align":"center","textColor":"text-subtle","fontSize":"small"} -->\n` +
      `<p class="has-text-align-center has-text-subtle-color has-text-color has-small-font-size">${escapeHtml(
        MISSING_IMAGE_PLACEHOLDER,
      )}</p>\n<!-- /wp:paragraph -->`
    );
  }
  out.assets.push(r.url);
  return (
    `<!-- wp:image {"sizeSlug":"large"${alignAttr}${roundStyle}} -->\n` +
    `<figure class="wp-block-image${alignClass} size-large${roundClass}"><img src="${escapeHtml(
      r.url,
    )}" alt="${escapeHtml(r.alt)}"${opts.rounded ? ' style="border-radius:12px"' : ''}/></figure>\n` +
    `<!-- /wp:image -->`
  );
}

function headingBlock(
  text: string,
  out: BlockOut,
  opts: { level?: number; center?: boolean; muted?: boolean; inverse?: boolean } = {},
): string {
  const t = normalizeCopy(text);
  if (!t) return '';
  out.expectedText.push(t);
  const level = opts.level ?? 2;
  const centerAttr = opts.center ? '"textAlign":"center",' : '';
  const centerClass = opts.center ? ' has-text-align-center' : '';
  const colorSlug = opts.inverse ? 'text-inverse' : opts.muted ? 'text-muted' : 'text-default';
  return (
    `<!-- wp:heading {${centerAttr}"level":${level},"fontFamily":"display","textColor":"${colorSlug}"} -->\n` +
    `<h${level} class="wp-block-heading${centerClass} has-${colorSlug}-color has-text-color has-display-font-family">${escapeHtml(
      t,
    )}</h${level}>\n<!-- /wp:heading -->`
  );
}

function paragraphBlock(
  text: string,
  out: BlockOut,
  opts: { center?: boolean; muted?: boolean; size?: string; inverse?: boolean } = {},
): string {
  const t = normalizeCopy(text);
  if (!t) return '';
  out.bodyText.push(t);
  const centerAttr = opts.center ? '"align":"center",' : '';
  const centerClass = opts.center ? 'has-text-align-center ' : '';
  const colorSlug = opts.inverse ? 'text-inverse' : opts.muted === false ? 'text-default' : 'text-muted';
  const sizeAttr = opts.size ? `"fontSize":"${opts.size}",` : '';
  const sizeClass = opts.size ? ` has-${opts.size}-font-size` : '';
  return (
    `<!-- wp:paragraph {${centerAttr}${sizeAttr}"textColor":"${colorSlug}"} -->\n` +
    `<p class="${centerClass}has-${colorSlug}-color has-text-color${sizeClass}">${escapeHtml(
      t,
    )}</p>\n<!-- /wp:paragraph -->`
  );
}

function buttonBlock(label: string, out: BlockOut): string {
  const t = normalizeCopy(label);
  if (!t) return '';
  out.expectedText.push(t);
  // Static, hrefless CTA: source interactivity (add-to-cart) did not survive
  // extraction, so we emit an honest non-linking button rather than invent a URL.
  return (
    `<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->\n` +
    `<div class="wp-block-buttons">\n` +
    `<!-- wp:button {"backgroundColor":"accent-primary","textColor":"text-inverse"} -->\n` +
    `<div class="wp-block-button"><a class="wp-block-button__link has-text-inverse-color has-accent-primary-background-color has-text-color has-background wp-element-button">${escapeHtml(
      t,
    )}</a></div>\n` +
    `<!-- /wp:button -->\n</div>\n<!-- /wp:buttons -->`
  );
}

/** A centered, constrained text band (hero / intro / static). */
function renderTextBand(s: SectionSpec): BlockOut {
  const out = emptyOut();
  const parts: string[] = [];
  s.headings.forEach((h, i) =>
    parts.push(headingBlock(h, out, { level: i === 0 ? 1 : 2, center: true })),
  );
  (s.bodyText ?? []).forEach((b) => parts.push(paragraphBlock(b, out, { center: true })));
  s.buttonLabels.forEach((b) => parts.push(buttonBlock(b, out)));
  // A single lead image (if present) below the copy — only a real photo, never a
  // decorative glyph (a small quote-mark/badge <img> would otherwise fill the slot).
  const lead = pickLeadImage(s.images);
  if (lead) parts.push(imageBlock(lead, out, `${s.interactionModel}#${s.sectionIndex}`, { align: 'center', rounded: true }));
  out.markup = wrapSection(parts.filter(Boolean), { constrained: '760px', center: true, raised: isTintedSection(s) });
  return out;
}

/** media-text: one image beside a heading + paragraph (alternating sides). */
function renderMediaText(s: SectionSpec, flip: boolean): BlockOut {
  const out = emptyOut();
  const textParts: string[] = [];
  s.headings.forEach((h) => textParts.push(headingBlock(h, out, { level: 2 })));
  (s.bodyText ?? []).forEach((b) => textParts.push(paragraphBlock(b, out)));
  s.buttonLabels.forEach((b) => textParts.push(buttonBlock(b, out)));
  // Prefer a real lead photo over a decorative glyph (a small quote-mark <img>
  // would otherwise fill the media column).
  const imgMarkup = imageBlock(pickLeadImage(s.images) ?? s.images[0], out, `media-text#${s.sectionIndex}`, { rounded: true });
  const textCol = column(textParts.filter(Boolean), '55%');
  const imgCol = column([imgMarkup], '45%');
  const cols = flip ? [imgCol, textCol] : [textCol, imgCol];
  out.markup = wrapSection([columns(cols)], { wide: '1100px', raised: isTintedSection(s) });
  return out;
}

/** product-card-row / project-card-grid: a grid of image+title+desc(+button) cards.
 *  Replo captures duplicate desktop/mobile DOM, so headings/buttons can arrive
 *  repeated. We dedupe leading repeats and bound the card count by the number of
 *  real images so a responsive-duplicate heading run never spawns phantom
 *  placeholder cards. */
function renderCardGrid(s: SectionSpec, withButtons: boolean): BlockOut {
  const out = emptyOut();
  const headings = dedupeAdjacent(s.headings);
  const bodyText = s.bodyText ?? [];
  // Each card is anchored by an image (card grids are image-led). When there are
  // more distinct headings than images, fall back to heading-led cards.
  const cardCount =
    s.images.length > 0 ? s.images.length : Math.min(headings.length, bodyText.length || headings.length);
  const cards: string[] = [];
  for (let i = 0; i < cardCount; i++) {
    const cardParts: string[] = [];
    if (s.images.length > 0) {
      cardParts.push(imageBlock(s.images[i], out, `${s.interactionModel}#${s.sectionIndex}.card${i}`, { rounded: true }));
    }
    if (headings[i]) cardParts.push(headingBlock(headings[i], out, { level: 3, center: true }));
    if (bodyText[i]) cardParts.push(paragraphBlock(bodyText[i], out, { center: true, size: 'small' }));
    if (withButtons && s.buttonLabels[i]) cardParts.push(buttonBlock(s.buttonLabels[i], out));
    if (cardParts.filter(Boolean).length) cards.push(column(cardParts.filter(Boolean)));
  }
  // Body text not consumed per-card (a section intro) renders above the grid.
  const extra: string[] = [];
  for (let i = cardCount; i < bodyText.length; i++) extra.push(paragraphBlock(bodyText[i], out, { center: true }));
  out.markup = wrapSection([...extra.filter(Boolean), columns(cards)], { wide: '1100px', raised: isTintedSection(s) });
  return out;
}

/** Collapse a run of identical adjacent strings (Replo desktop/mobile DOM dupes). */
function dedupeAdjacent(arr: string[]): string[] {
  const out: string[] = [];
  for (const x of arr) {
    if (out.length === 0 || normalizeCopy(out[out.length - 1]) !== normalizeCopy(x)) out.push(x);
  }
  return out;
}

/** review-grid: verbatim source reviews (stars + quote + author). Never synthesized.
 *  On a dark source band (e.g. getsnooz's navy reviews) the band renders on the
 *  inverse surface with light text; on a light band it keeps the mint raised
 *  surface with dark text. */
function renderReviewGrid(s: SectionSpec): BlockOut {
  const out = emptyOut();
  const dark = isDarkSection(s);
  const bodyColor = dark ? 'text-inverse' : 'text-default';
  const mutedColor = dark ? 'text-inverse' : 'text-muted';
  // A centered review paragraph in the band's text color (kept as a local helper
  // so quote/author/rating all track the dark-vs-light treatment consistently).
  const reviewP = (text: string, slug: string, small = false): string =>
    `<!-- wp:paragraph {"align":"center","textColor":"${slug}"${small ? ',"fontSize":"small"' : ''}} -->\n` +
    `<p class="has-text-align-center has-${slug}-color has-text-color${small ? ' has-small-font-size' : ''}">${escapeHtml(
      text,
    )}</p>\n<!-- /wp:paragraph -->`;

  const intro: string[] = [];
  // A leading heading (e.g. "Loved by Thousands") is band copy, not a review.
  s.headings
    .filter((h) => !/^\s*-/.test(h))
    .slice(0, 1)
    .forEach((h) => intro.push(headingBlock(h, out, { level: 2, center: true, inverse: dark })));

  const reviews: ExtractedReview[] = s.reviews ?? [];
  const cards: string[] = [];
  if (reviews.length === 0) {
    // The deterministic review extractor didn't structure this band into
    // reviews[], but the section's verbatim copy may still carry the review
    // prose in bodyText (rating line + quote + byline). Prefer rendering that
    // captured text verbatim over a "not captured" placeholder — the content
    // IS present, just unstructured. Only when there is NO captured body copy
    // do we emit the honest missing-content placeholder + flag.
    const captured = (s.bodyText ?? []).map((b) => normalizeCopy(b)).filter(Boolean);
    if (captured.length > 0) {
      const parts: string[] = [];
      for (const line of captured) {
        out.bodyText.push(line);
        const isRating = /\d(?:\.\d)?\s*\/\s*5|rating|\breviews?\b/i.test(line) && line.length < 60;
        parts.push(reviewP(line, isRating ? mutedColor : bodyColor, isRating));
      }
      cards.push(column(parts.filter(Boolean)));
    } else {
      out.flags.push(
        `review-grid#${s.sectionIndex}: review band detected but no verbatim reviews captured — placeholder emitted`,
      );
      cards.push(column([reviewP('[reviews not captured]', dark ? 'text-inverse' : 'text-subtle')]));
    }
  } else {
    for (const r of reviews) {
      const parts: string[] = [];
      const starCount = Math.max(0, Math.min(5, Math.round(r.stars || 0)));
      // Star glyphs are a gate-exempt decorative run (accent on either surface).
      if (starCount > 0) parts.push(reviewP('★'.repeat(starCount), 'accent-primary'));
      const quote = normalizeCopy(r.quote);
      if (quote) {
        out.bodyText.push(quote);
        parts.push(reviewP(quote, bodyColor));
      }
      if (r.author) {
        const author = normalizeCopy(r.author);
        out.bodyText.push(author);
        parts.push(reviewP(author, mutedColor, true));
      }
      cards.push(column(parts.filter(Boolean)));
    }
  }
  out.markup = wrapSection([...intro.filter(Boolean), columns(cards)], {
    wide: '1100px',
    inverse: dark,
    raised: !dark,
  });
  return out;
}

/** A responsive wp:gallery grid of WP-library images. A single flex `columns`
 *  row gives every image 1/N width (25 images → unreadable thumbnails); a gallery
 *  block wraps to a fixed column count at a sensible size. */
function galleryBlock(images: SectionSpecImage[], out: BlockOut): string {
  const usable = images.filter((im) => isWpUrl(im.url));
  if (usable.length === 0) return '';
  const cols = Math.min(4, usable.length);
  const figures = usable.map((im) => {
    out.assets.push(im.url);
    return (
      `<!-- wp:image {"sizeSlug":"large","linkDestination":"none"} -->\n` +
      `<figure class="wp-block-image size-large"><img src="${escapeHtml(im.url)}" alt="${escapeHtml(im.alt || '')}"/></figure>\n` +
      `<!-- /wp:image -->`
    );
  });
  return (
    `<!-- wp:gallery {"columns":${cols},"imageCrop":true,"linkTo":"none","sizeSlug":"large"} -->\n` +
    `<figure class="wp-block-gallery has-nested-images columns-${cols} is-cropped">\n${figures.join('\n')}\n</figure>\n` +
    `<!-- /wp:gallery -->`
  );
}

/** color-block-grid / logo-strip / gallery: a band of images, no per-image copy.
 *  Rendered as a responsive gallery grid (not a single N-wide flex row). */
function renderImageRow(s: SectionSpec): BlockOut {
  const out = emptyOut();
  const parts: string[] = [];
  s.headings.forEach((h) => parts.push(headingBlock(h, out, { level: 2, center: true })));
  (s.bodyText ?? []).forEach((b) => parts.push(paragraphBlock(b, out, { center: true })));
  const gallery = galleryBlock(s.images, out);
  if (gallery) parts.push(gallery);
  out.markup = wrapSection(parts.filter(Boolean), { wide: '1100px', raised: isTintedSection(s) });
  return out;
}

/** FAQ accordion: verbatim Q/A pairs as wp:details. Never synthesizes answers. */
function renderFaq(s: SectionSpecWithFaqs): BlockOut {
  const out = emptyOut();
  const parts: string[] = [];
  // A leading "Frequently Asked Questions" heading is band copy.
  s.headings.slice(0, 1).forEach((h) => parts.push(headingBlock(h, out, { level: 2, center: true })));
  const faqs = s.faqs ?? [];
  for (const f of faqs) {
    const q = normalizeCopy(f.question);
    if (!q) continue;
    out.expectedText.push(q);
    const a = normalizeCopy(f.answer);
    let answerBlock: string;
    if (a) {
      out.bodyText.push(a);
      answerBlock =
        `<!-- wp:paragraph {"textColor":"text-muted"} -->\n` +
        `<p class="has-text-muted-color has-text-color">${escapeHtml(a)}</p>\n<!-- /wp:paragraph -->`;
    } else {
      out.flags.push(`faq#${s.sectionIndex}: answer for "${q}" not captured — placeholder emitted`);
      answerBlock =
        `<!-- wp:paragraph {"textColor":"text-subtle"} -->\n` +
        `<p class="has-text-subtle-color has-text-color">[answer not captured]</p>\n<!-- /wp:paragraph -->`;
    }
    parts.push(
      `<!-- wp:details -->\n<details class="wp-block-details"><summary>${escapeHtml(q)}</summary>\n` +
        `${answerBlock}\n</details>\n<!-- /wp:details -->`,
    );
  }
  out.markup = wrapSection(parts.filter(Boolean), { constrained: '760px', raised: isTintedSection(s) });
  return out;
}

// --- structural helpers ----------------------------------------------------

function column(parts: string[], width?: string): string {
  const widthAttr = width ? `{"width":"${width}"}` : '';
  const widthStyle = width ? ` style="flex-basis:${width}"` : '';
  return (
    `<!-- wp:column ${widthAttr} -->\n` +
    `<div class="wp-block-column"${widthStyle}>\n${parts.join('\n')}\n</div>\n` +
    `<!-- /wp:column -->`
  );
}

function columns(cols: string[]): string {
  if (cols.length === 0) return '';
  return (
    `<!-- wp:columns {"verticalAlignment":"center"} -->\n` +
    `<div class="wp-block-columns are-vertically-aligned-center">\n${cols.join('\n')}\n</div>\n` +
    `<!-- /wp:columns -->`
  );
}

function wrapSection(
  parts: string[],
  opts: { constrained?: string; wide?: string; center?: boolean; raised?: boolean; inverse?: boolean },
): string {
  const body = parts.filter(Boolean).join('\n');
  if (!body) return '';
  const layout = opts.constrained
    ? `"layout":{"type":"constrained","contentSize":"${opts.constrained}"}`
    : opts.wide
      ? `"layout":{"type":"constrained","wideSize":"${opts.wide}"}`
      : `"layout":{"type":"constrained"}`;
  // inverse (dark band) wins over raised (mint band). A dark band also sets the
  // group text color to text-inverse so emitters that don't self-set a color
  // (and the inverse-aware ones) read light on the dark surface.
  const bg = opts.inverse
    ? ',"backgroundColor":"surface-inverse","textColor":"text-inverse"'
    : opts.raised
      ? ',"backgroundColor":"surface-raised"'
      : '';
  const bgClass = opts.inverse
    ? ' has-surface-inverse-background-color has-text-inverse-color has-text-color has-background'
    : opts.raised
      ? ' has-surface-raised-background-color has-background'
      : '';
  return (
    `<!-- wp:group {"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}}${bg},${layout}} -->\n` +
    `<section class="wp-block-group alignfull${bgClass}" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--40)">\n` +
    `${body}\n` +
    `</section>\n<!-- /wp:group -->`
  );
}

/** A section whose captured background is dark (needs inverse/light text). */
function isDarkSection(s: SectionSpec): boolean {
  return s.backgroundBrightness < 100;
}

/**
 * Uniform multi-cell content grid — an icon-feature row ("Built-In Sounds /
 * Bluetooth Speaker / Night Light"), sound-library columns (Classic / Nature /
 * Ambient), or a comparison's column triplet (labels / Go 2 / Go v1). Each
 * captured cell becomes one column with its title, body lines, optional lead
 * image, and button. Band-level headings (a heading that is NOT a cell title —
 * e.g. "Three bedtime essentials.") render above the grid. This is what keeps a
 * grid section from collapsing into one stacked text band that also drops the
 * mid-size cell labels the flat-array capture missed.
 */
function renderCellGrid(s: SectionSpec, ctx: RenderCtx): BlockOut {
  const out = emptyOut();
  const cells = s.cells ?? [];
  const cellHeadSet = new Set(cells.map((c) => normalizeCopy(c.heading ?? '')).filter(Boolean));
  const intro: string[] = [];
  s.headings.forEach((h, i) => {
    if (cellHeadSet.has(normalizeCopy(h))) return; // a cell title — rendered in its column
    intro.push(headingBlock(h, out, { level: i === 0 ? 2 : 3, center: true }));
  });
  const cols: string[] = [];
  for (const c of cells) {
    // A styled card: the captured cell container background mapped to the nearest
    // theme token (dark card → light text + rounded surface), so feature cards
    // render DISTINCTLY instead of flattening into one band.
    const cardToken = c.background ? nearestToken(c.background, ctx.paletteTokens) : null;
    const cardDark = c.background ? brightness(c.background) < 140 : false;
    const parts: string[] = [];
    // A small inline icon (speaker / bluetooth / sun glyph, comparison check/X)
    // tops the cell — shipped as a theme SVG asset, referenced via core/image.
    if (c.icon) parts.push(iconImageBlock(c.icon, out, ctx));
    if (c.image && isWpUrl(c.image.url) && Math.min(c.image.width || 0, c.image.height || 0) >= MIN_LEAD_IMAGE_PX) {
      parts.push(imageBlock(c.image, out, `cell#${s.sectionIndex}`, { rounded: true }));
    }
    if (c.heading) parts.push(headingBlock(c.heading, out, { level: 3, center: true, inverse: cardDark }));
    for (const b of c.body) parts.push(paragraphBlock(b, out, { center: true, size: 'small', inverse: cardDark }));
    if (c.button) parts.push(buttonBlock(c.button, out));
    const kept = parts.filter(Boolean);
    if (!kept.length) continue;
    cols.push(column(cardToken ? [cardGroup(kept, cardToken, cardDark, c.radius ?? 0)] : kept));
  }
  out.markup = wrapSection([...intro.filter(Boolean), columns(cols)], { wide: '1100px', raised: isTintedSection(s) });
  return out;
}

/** Wrap a cell's content in a styled card group: token background, light text on a
 *  dark card, rounded corners, and padding. Radius is capped to a sane range. */
function cardGroup(parts: string[], bgToken: string, dark: boolean, radius: number): string {
  const textToken = dark ? 'text-inverse' : 'text-default';
  const r = radius > 0 ? Math.min(radius, 32) : 12;
  return (
    `<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"}},"border":{"radius":"${r}px"}},"backgroundColor":"${bgToken}","textColor":"${textToken}","layout":{"type":"constrained"}} -->\n` +
    `<div class="wp-block-group has-${textToken}-color has-${bgToken}-background-color has-text-color has-background" style="border-radius:${r}px;padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">\n${parts.join('\n')}\n</div>\n` +
    `<!-- /wp:group -->`
  );
}

/** Models with their own specialized renderers — never overridden by the cell grid. */
const NON_CELL_GRID_MODELS = new Set([
  'product-card-row',
  'project-card-grid',
  'blog-card-grid',
  'review-grid',
  'testimonial',
]);

// ---------------------------------------------------------------------------
// Section dispatch
// ---------------------------------------------------------------------------

function renderSection(s: SectionSpecWithFaqs, ctx: RenderCtx): BlockOut {
  // A section carrying re-captured FAQ pairs renders as an accordion regardless
  // of its geometric interaction model.
  if (s.faqs && s.faqs.length) return renderFaq(s);
  // A uniform multi-cell content grid: >=2 cells each carrying BOTH a title and
  // body (a genuine feature/column grid, not a hero's text|image split or a
  // single CTA). Card grids / reviews keep their specialized paths.
  if (
    s.cells &&
    !NON_CELL_GRID_MODELS.has(s.interactionModel) &&
    s.cells.filter((c) => c.heading && c.body.length > 0).length >= 2
  ) {
    return renderCellGrid(s, ctx);
  }
  switch (s.interactionModel) {
    case 'media-text': {
      const flip = ctx.mediaTextIndex % 2 === 1;
      ctx.mediaTextIndex++;
      return renderMediaText(s, flip);
    }
    case 'product-card-row':
      return renderCardGrid(s, /* withButtons */ true);
    case 'project-card-grid':
    case 'blog-card-grid':
      return renderCardGrid(s, /* withButtons */ false);
    case 'review-grid':
    case 'testimonial':
      return renderReviewGrid(s);
    case 'color-block-grid':
    case 'logo-strip':
    case 'gallery':
    case 'marquee-strip':
      return renderImageRow(s);
    case 'columns':
      // A two-up columns band: if it has both copy and one image, treat as media-text;
      // otherwise a centered text band.
      if (s.images.length === 1 && (s.headings.length || (s.bodyText ?? []).length)) {
        return renderMediaText(s, false);
      }
      return renderTextBand(s);
    case 'cover-with-headline': {
      // A hero with a REAL lead photo renders as a 2-column media-text (text |
      // image), matching the common source hero layout. flip=false keeps text
      // left / image right. Without a photo (e.g. a text-only sale banner) it's
      // a centered band. (animated-cover stays a centered band — those are
      // typically full-bleed covers, not two-up heroes.)
      if (pickLeadImage(s.images) && (s.headings.length || (s.bodyText ?? []).length)) {
        const flip = ctx.mediaTextIndex % 2 === 1;
        ctx.mediaTextIndex++;
        return renderMediaText(s, flip);
      }
      return renderTextBand(s);
    }
    case 'static':
    case 'cta':
    case 'animated-cover':
    case 'price-list':
    case 'app-download':
    case 'horizontal-showcase':
    default:
      return renderTextBand(s);
  }
}

/**
 * Reconstruct a full page pattern from its captured section specs.
 * Chrome (header/footer/nav) is stripped; only page-body sections are rendered.
 */
export function reconstructPagePattern(
  sections: SectionSpec[],
  opts: ReconstructOptions,
): ReconstructResult {
  const body = stripChrome(sections);
  const expectedText: string[] = [];
  const bodyText: string[] = [];
  const assets: string[] = [];
  const provenanceFlags: string[] = [];
  const sectionMarkup: string[] = [];
  const iconAssets: Array<{ path: string; svg: string }> = [];
  const ctx: RenderCtx = { mediaTextIndex: 0, iconCounter: 0, paletteTokens: opts.paletteTokens ?? [] };

  for (const s of body) {
    const out = renderSection(s, ctx);
    if (!out.markup) continue;
    sectionMarkup.push(out.markup);
    expectedText.push(...out.expectedText);
    bodyText.push(...out.bodyText);
    assets.push(...out.assets);
    provenanceFlags.push(...out.flags);
    iconAssets.push(...out.iconAssets);
  }

  const header =
    `<?php\n/**\n * Title: ${sanitizePatternHeaderField(opts.title)}\n * Slug: ${sanitizePatternHeaderField(
      opts.patternSlug,
    )}\n` +
    ` * Categories: featured\n * Inserter: false\n */\n?>\n`;

  return {
    php: header + sectionMarkup.join('\n\n') + '\n',
    expectedText: dedupe(expectedText),
    bodyText: dedupe(bodyText),
    expectedAssets: dedupe(assets),
    provenanceFlags,
    sectionsRendered: sectionMarkup.length,
    iconAssets,
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
