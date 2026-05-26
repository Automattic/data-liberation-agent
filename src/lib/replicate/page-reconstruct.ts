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

import type { SectionSpec, SectionSpecImage } from './section-extract.js';
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

/** A WP media-library URL is the migrated form; anything else is a capture gap. */
function isWpUrl(u: string): boolean {
  return /\/wp-content\/uploads\//i.test(u);
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
}

function emptyOut(): BlockOut {
  return { markup: '', expectedText: [], bodyText: [], assets: [], flags: [] };
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
  opts: { level?: number; center?: boolean; muted?: boolean } = {},
): string {
  const t = normalizeCopy(text);
  if (!t) return '';
  out.expectedText.push(t);
  const level = opts.level ?? 2;
  const centerAttr = opts.center ? '"textAlign":"center",' : '';
  const centerClass = opts.center ? ' has-text-align-center' : '';
  const colorSlug = opts.muted ? 'text-muted' : 'text-default';
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
  opts: { center?: boolean; muted?: boolean; size?: string } = {},
): string {
  const t = normalizeCopy(text);
  if (!t) return '';
  out.bodyText.push(t);
  const centerAttr = opts.center ? '"align":"center",' : '';
  const centerClass = opts.center ? 'has-text-align-center ' : '';
  const colorSlug = opts.muted === false ? 'text-default' : 'text-muted';
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
  // A single lead image (if present) below the copy.
  if (s.images[0]) parts.push(imageBlock(s.images[0], out, `${s.interactionModel}#${s.sectionIndex}`, { align: 'center', rounded: true }));
  out.markup = wrapSection(parts.filter(Boolean), { constrained: '760px', center: true });
  return out;
}

/** media-text: one image beside a heading + paragraph (alternating sides). */
function renderMediaText(s: SectionSpec, flip: boolean): BlockOut {
  const out = emptyOut();
  const textParts: string[] = [];
  s.headings.forEach((h) => textParts.push(headingBlock(h, out, { level: 2 })));
  (s.bodyText ?? []).forEach((b) => textParts.push(paragraphBlock(b, out)));
  s.buttonLabels.forEach((b) => textParts.push(buttonBlock(b, out)));
  const imgMarkup = imageBlock(s.images[0], out, `media-text#${s.sectionIndex}`, { rounded: true });
  const textCol = column(textParts.filter(Boolean), '55%');
  const imgCol = column([imgMarkup], '45%');
  const cols = flip ? [imgCol, textCol] : [textCol, imgCol];
  out.markup = wrapSection([columns(cols)], { wide: '1100px' });
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
  out.markup = wrapSection([...extra.filter(Boolean), columns(cards)], { wide: '1100px' });
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

/** review-grid: verbatim source reviews (stars + quote + author). Never synthesized. */
function renderReviewGrid(s: SectionSpec): BlockOut {
  const out = emptyOut();
  const intro: string[] = [];
  // A leading heading (e.g. "Loved by Thousands") is band copy, not a review.
  s.headings
    .filter((h) => !/^\s*-/.test(h))
    .slice(0, 1)
    .forEach((h) => intro.push(headingBlock(h, out, { level: 2, center: true })));

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
        parts.push(
          `<!-- wp:paragraph {"align":"center","textColor":"${isRating ? 'text-muted' : 'text-default'}"${
            isRating ? ',"fontSize":"small"' : ''
          }} -->\n` +
            `<p class="has-text-align-center has-${isRating ? 'text-muted' : 'text-default'}-color has-text-color${
              isRating ? ' has-small-font-size' : ''
            }">${escapeHtml(line)}</p>\n<!-- /wp:paragraph -->`,
        );
      }
      cards.push(column(parts.filter(Boolean)));
    } else {
      out.flags.push(
        `review-grid#${s.sectionIndex}: review band detected but no verbatim reviews captured — placeholder emitted`,
      );
      cards.push(
        column([
          `<!-- wp:paragraph {"align":"center","textColor":"text-subtle"} -->\n` +
            `<p class="has-text-align-center has-text-subtle-color has-text-color">[reviews not captured]</p>\n` +
            `<!-- /wp:paragraph -->`,
        ]),
      );
    }
  } else {
    for (const r of reviews) {
      const parts: string[] = [];
      const starCount = Math.max(0, Math.min(5, Math.round(r.stars || 0)));
      if (starCount > 0) {
        // Star glyphs are a gate-exempt decorative run (not prose).
        parts.push(
          `<!-- wp:paragraph {"align":"center","textColor":"accent-primary"} -->\n` +
            `<p class="has-text-align-center has-accent-primary-color has-text-color">${'★'.repeat(starCount)}</p>\n` +
            `<!-- /wp:paragraph -->`,
        );
      }
      const quote = normalizeCopy(r.quote);
      if (quote) {
        out.bodyText.push(quote);
        parts.push(
          `<!-- wp:paragraph {"align":"center","textColor":"text-default"} -->\n` +
            `<p class="has-text-align-center has-text-default-color has-text-color">${escapeHtml(quote)}</p>\n` +
            `<!-- /wp:paragraph -->`,
        );
      }
      if (r.author) {
        const author = normalizeCopy(r.author);
        out.bodyText.push(author);
        parts.push(
          `<!-- wp:paragraph {"align":"center","textColor":"text-muted","fontSize":"small"} -->\n` +
            `<p class="has-text-align-center has-text-muted-color has-text-color has-small-font-size">${escapeHtml(
              author,
            )}</p>\n<!-- /wp:paragraph -->`,
        );
      }
      cards.push(column(parts.filter(Boolean)));
    }
  }
  out.markup = wrapSection([...intro.filter(Boolean), columns(cards)], {
    wide: '1100px',
    raised: true,
  });
  return out;
}

/** color-block-grid / logo-strip / gallery: a row of images, no per-image copy. */
function renderImageRow(s: SectionSpec): BlockOut {
  const out = emptyOut();
  const parts: string[] = [];
  s.headings.forEach((h) => parts.push(headingBlock(h, out, { level: 2, center: true })));
  (s.bodyText ?? []).forEach((b) => parts.push(paragraphBlock(b, out, { center: true })));
  const imgCols = s.images
    .map((im, i) => column([imageBlock(im, out, `${s.interactionModel}#${s.sectionIndex}.img${i}`, { rounded: true })]))
    .filter(Boolean);
  if (imgCols.length) parts.push(columns(imgCols));
  out.markup = wrapSection(parts.filter(Boolean), { wide: '1100px' });
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
  out.markup = wrapSection(parts.filter(Boolean), { constrained: '760px' });
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
  opts: { constrained?: string; wide?: string; center?: boolean; raised?: boolean },
): string {
  const body = parts.filter(Boolean).join('\n');
  if (!body) return '';
  const layout = opts.constrained
    ? `"layout":{"type":"constrained","contentSize":"${opts.constrained}"}`
    : opts.wide
      ? `"layout":{"type":"constrained","wideSize":"${opts.wide}"}`
      : `"layout":{"type":"constrained"}`;
  const bg = opts.raised ? ',"backgroundColor":"surface-raised"' : '';
  const bgClass = opts.raised ? ' has-surface-raised-background-color has-background' : '';
  return (
    `<!-- wp:group {"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}}${bg},${layout}} -->\n` +
    `<section class="wp-block-group alignfull${bgClass}" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--40)">\n` +
    `${body}\n` +
    `</section>\n<!-- /wp:group -->`
  );
}

// ---------------------------------------------------------------------------
// Section dispatch
// ---------------------------------------------------------------------------

function renderSection(s: SectionSpecWithFaqs, mediaTextIndex: { i: number }): BlockOut {
  // A section carrying re-captured FAQ pairs renders as an accordion regardless
  // of its geometric interaction model.
  if (s.faqs && s.faqs.length) return renderFaq(s);
  switch (s.interactionModel) {
    case 'media-text': {
      const flip = mediaTextIndex.i % 2 === 1;
      mediaTextIndex.i++;
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
    case 'static':
    case 'cta':
    case 'cover-with-headline':
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
  const mediaTextIndex = { i: 0 };

  for (const s of body) {
    const out = renderSection(s, mediaTextIndex);
    if (!out.markup) continue;
    sectionMarkup.push(out.markup);
    expectedText.push(...out.expectedText);
    bodyText.push(...out.bodyText);
    assets.push(...out.assets);
    provenanceFlags.push(...out.flags);
  }

  const header =
    `<?php\n/**\n * Title: ${opts.title}\n * Slug: ${opts.patternSlug}\n` +
    ` * Categories: featured\n * Inserter: false\n */\n?>\n`;

  return {
    php: header + sectionMarkup.join('\n\n') + '\n',
    expectedText: dedupe(expectedText),
    bodyText: dedupe(bodyText),
    expectedAssets: dedupe(assets),
    provenanceFlags,
    sectionsRendered: sectionMarkup.length,
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
