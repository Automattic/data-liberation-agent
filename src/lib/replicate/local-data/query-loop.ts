// src/lib/replicate/local-data/query-loop.ts
//
// Emit the native block markup that replaces an empty JS-mount <div> (e.g.
// `<div class="obj-grid obj-grid--4" id="newestGrid"></div>` that mountGrid()
// used to fill) with a real WordPress query loop:
//
//   core/query (anchor = mount id)         -> <div class="wp-block-query" id="newestGrid">
//     core/post-template (className = grid) -> <ul class="wp-block-post-template obj-grid obj-grid--4">
//       dla/data-card (dynamic)             -> <article class="obj-card" data-cat data-id>...</article>
//
// The mount id lands on the query wrapper (so `#newestGrid .obj-card` selectors
// in the kept filter/animation JS keep matching) and the grid class lands on the
// post-template <ul> (so the carried `.obj-grid` CSS lays the cards out).
//
// post-template wraps each item in an <li>, which would (a) leave the grid class
// one level above the cards and (b) leave empty grid cells when the client-side
// filter hides an .obj-card. Both are fixed by flattening the <li> with
// `display:contents` so the .obj-card itself becomes the grid item — emitted as
// the result `css` and folded into the theme's parity stylesheet.
import type { MountSpec } from './types.js';

/** The dynamic block name that renders one CPT post as a source-faithful card. */
export const DATA_CARD_BLOCK = 'dla/data-card';

/** WP query loop perPage cannot express "all"; clamp the model's -1 sentinel. */
const ALL_POSTS_PER_PAGE = 100;

export interface QueryLoopResult {
  /** Serialized block markup that replaces the empty mount <div>. */
  markup: string;
  /**
   * CSS flattening the post-template <li> wrappers for this mount so the source
   * grid layout + client-side filtering keep binding to `.obj-card`. '' when the
   * mount has no id to anchor the rule.
   */
  css: string;
}

/** The id half of a `#foo` selector, or null for non-id selectors. */
function anchorFromSelector(selector: string): string | null {
  const m = /^#([\w-]+)$/.exec(selector.trim());
  return m ? m[1] : null;
}

/** Lowercase the model's ASC/DESC into the query block's asc/desc. */
function normalizeOrder(order: 'ASC' | 'DESC' | undefined): 'asc' | 'desc' {
  return order === 'ASC' ? 'asc' : 'desc';
}

/**
 * Build the query-loop block markup (+ li-flatten CSS) that replaces one empty
 * JS-mount div. `queryId` disambiguates multiple loops on the same page (the
 * block's queryId attribute); defaults to 0.
 */
export function buildQueryLoop(mount: MountSpec, queryId = 0): QueryLoopResult {
  const anchor = anchorFromSelector(mount.selector);
  const perPage =
    mount.query.perPage === -1 ? ALL_POSTS_PER_PAGE : mount.query.perPage;

  // Mirror WP's query-attribute key order so the markup reads like editor output.
  const query: Record<string, unknown> = {
    perPage,
    pages: 0,
    offset: 0,
    postType: mount.query.postType,
    order: normalizeOrder(mount.query.order),
    orderBy: mount.query.orderBy ?? 'date',
    inherit: false,
  };

  const queryAttrs: Record<string, unknown> = { queryId, query };
  if (anchor) queryAttrs.anchor = anchor;

  const idAttr = anchor ? ` id="${anchor}"` : '';

  const templateAttrs = mount.wrapperClass
    ? ` ${JSON.stringify({ className: mount.wrapperClass })}`
    : '';

  const markup =
    `<!-- wp:query ${JSON.stringify(queryAttrs)} -->\n` +
    `<div class="wp-block-query"${idAttr}><!-- wp:post-template${templateAttrs} -->\n` +
    `<!-- wp:${DATA_CARD_BLOCK} /-->\n` +
    `<!-- /wp:post-template --></div>\n` +
    `<!-- /wp:query -->`;

  // Flatten the post-template <li> so the .obj-card is the direct grid item:
  // keeps the carried grid CSS and the client-side filter (.obj-card.hidden)
  // working. Scoped to this mount's id so it can't leak to other lists.
  const css = anchor
    ? `#${anchor} .wp-block-post-template > li{display:contents}`
    : '';

  return { markup, css };
}
