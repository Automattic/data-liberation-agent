// src/lib/replicate/normalize/emit-blocks.ts
import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import { isTag, isText } from 'domhandler';
import type { Element } from 'domhandler';
import type { ModalBehavior, Section, SliderBehavior, TabsBehavior } from '../local-site/types.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON-encode a block-attribute string with WP's '--' escaping so values can
 * never terminate the surrounding block comment. Shared by all emitters. */
export function attrJson(value: string): string {
  return JSON.stringify(value).replace(/--/g, '\\u002d\\u002d');
}

/** class attr of an element as a single className string ('' when none). */
function classNameOf($el: Cheerio<Element>): string {
  return ($el.attr('class') ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/** Build the {…} attr fragment merging optional className into existing pairs. */
function blockAttrs(pairs: string[], className: string): string {
  const all = className ? [...pairs, `"className":${attrJson(className)}`] : pairs;
  return all.length ? ` {${all.join(',')}}` : '';
}

const HEADING = /^h([1-6])$/;

/** Inline tags preserved verbatim in rich-text content (a keeps only an escaped href). */
const INLINE_ALLOWED = new Set(['a', 'strong', 'em', 'b', 'i', 'br']);

/**
 * Serialize an element's inline content: allowed inline tags kept (anchors
 * keep only an escaped href — other attributes dropped), text nodes escaped,
 * any other tag transparently unwrapped (recursed) so nested allowed tags
 * survive. Links are content ("never lose source content") — a paragraph's
 * <a href> must survive emission, even wrapped in a <span>.
 */
function inlineHtml($: CheerioAPI, el: Element): string {
  let out = '';
  for (const node of $(el).contents().get()) {
    if (isText(node)) {
      out += escapeHtml(node.data);
    } else if (isTag(node)) {
      const tag = node.tagName?.toLowerCase() ?? '';
      if (tag === 'br') {
        out += '<br/>';
        continue;
      }
      if (INLINE_ALLOWED.has(tag)) {
        const inner = inlineHtml($, node);
        const cls = ($(node).attr('class') ?? '').trim();
        const clsAttr = cls ? ` class="${escapeHtml(cls)}"` : '';
        if (tag === 'a') {
          const href = escapeHtml($(node).attr('href') ?? '');
          out += `<a${clsAttr} href="${href}">${inner}</a>`;
        } else {
          out += `<${tag}${clsAttr}>${inner}</${tag}>`;
        }
      } else {
        // Transparent unwrap: recurse so nested allowed tags (e.g. a link
        // inside a <span>) survive instead of flattening to bare text.
        out += inlineHtml($, node);
      }
    }
  }
  return out;
}

function imageBlock($: CheerioAPI, imgEl: Element): string {
  const src = escapeHtml($(imgEl).attr('src') ?? '');
  const alt = escapeHtml($(imgEl).attr('alt') ?? '');
  const cls = classNameOf($(imgEl));
  const attrs = blockAttrs([], cls);
  const figCls = ['wp-block-image', cls].filter(Boolean).join(' ');
  return `<!-- wp:image${attrs} -->\n<figure class="${escapeHtml(figCls)}"><img src="${src}" alt="${alt}"/></figure>\n<!-- /wp:image -->`;
}

function paragraphBlock(inner: string): string {
  return `<!-- wp:paragraph -->\n<p>${inner}</p>\n<!-- /wp:paragraph -->`;
}

interface ChildResult {
  markup: string;
  clean: boolean;
}

/** Map a single child element to a core block. clean=false when downgraded. */
function emitChild($: CheerioAPI, el: Element): ChildResult {
  const tag = el.tagName?.toLowerCase() ?? '';
  const $el = $(el);

  const h = HEADING.exec(tag);
  if (h) {
    const level = Number(h[1]);
    const cls = classNameOf($el);
    const attrs = blockAttrs(level === 2 ? [] : [`"level":${level}`], cls);
    const htmlCls = ['wp-block-heading', cls].filter(Boolean).join(' ');
    const inner = inlineHtml($, el).trim();
    return {
      markup: `<!-- wp:heading${attrs} -->\n<h${level} class="${escapeHtml(htmlCls)}">${inner}</h${level}>\n<!-- /wp:heading -->`,
      clean: true,
    };
  }

  if (tag === 'p') {
    const cls = classNameOf($el);
    const attrs = blockAttrs([], cls);
    const inner = inlineHtml($, el).trim();
    const open = cls ? `<p class="${escapeHtml(cls)}">` : '<p>';
    return { markup: `<!-- wp:paragraph${attrs} -->\n${open}${inner}</p>\n<!-- /wp:paragraph -->`, clean: true };
  }

  if (tag === 'img') {
    return { markup: imageBlock($, el), clean: true };
  }

  if (tag === 'a' && /\b(button|btn)\b/i.test($el.attr('class') ?? '')) {
    const href = escapeHtml($el.attr('href') ?? '');
    // Button labels are plain text — no inline markup inside the link.
    const label = escapeHtml($el.text().trim());
    const cls = classNameOf($el);
    const buttonAttrs = blockAttrs([], cls);
    const divCls = ['wp-block-button', cls].filter(Boolean).join(' ');
    // Source classes ride on the INNER anchor too: the source styles the
    // anchor itself (a.button { … }), so carried CSS must match the real <a>.
    // (Supersedes the earlier wrapper-only rule, which was tokens-path
    // reasoning — under carry, anchor selectors are the parity mechanism.)
    const aCls = ['wp-block-button__link', 'wp-element-button', cls].filter(Boolean).join(' ');
    return {
      markup:
        `<!-- wp:buttons -->\n<div class="wp-block-buttons">` +
        `<!-- wp:button${buttonAttrs} -->\n<div class="${escapeHtml(divCls)}"><a class="${escapeHtml(aCls)}" href="${href}">${label}</a></div>\n<!-- /wp:button -->` +
        `</div>\n<!-- /wp:buttons -->`,
      clean: true,
    };
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = $el
      .children('li')
      .map((_, li) => `<!-- wp:list-item -->\n<li>${inlineHtml($, li).trim()}</li>\n<!-- /wp:list-item -->`)
      .get()
      .join('\n');
    const cls = classNameOf($el);
    const orderedPairs = tag === 'ol' ? ['"ordered":true'] : [];
    const listAttrs = blockAttrs(orderedPairs, cls);
    const ulTag = tag === 'ol' ? 'ol' : 'ul';
    const listCls = ['wp-block-list', cls].filter(Boolean).join(' ');
    return {
      markup: `<!-- wp:list${listAttrs} -->\n<${ulTag} class="${escapeHtml(listCls)}">${items}</${ulTag}>\n<!-- /wp:list -->`,
      clean: true,
    };
  }

  if (tag === 'table') {
    // core/table: rebuild thead/tbody rows with text-only cells (inline markup
    // inside cells flattens to text — matches the emitter's v1 cell model).
    // Source `table {}` / `th, td {}` element rules keep applying; the source
    // table class rides along via className.
    const cls = classNameOf($el);
    const rowHtml = (rowEl: Element): string => {
      const cells = $(rowEl)
        .children('th, td')
        .map((_, c) => {
          const cellTag = (c as Element).tagName?.toLowerCase() === 'th' ? 'th' : 'td';
          return `<${cellTag}>${escapeHtml($(c).text().trim())}</${cellTag}>`;
        })
        .get()
        .join('');
      return `<tr>${cells}</tr>`;
    };
    const headRows = $el.find('thead tr').map((_, r) => rowHtml(r as Element)).get();
    // cheerio normalizes bare <tr> children into an implicit <tbody>, so a
    // source table with no explicit <thead> lands its header row here too —
    // promote a leading all-<th> row to thead (matches WP's table block shape).
    let bodyRowEls = $el.find('tbody tr').toArray();
    if (bodyRowEls.length === 0) bodyRowEls = $el.find('tr').toArray();
    if (headRows.length === 0 && bodyRowEls.length > 0) {
      const first = bodyRowEls[0];
      const firstIsHeader = $(first).children('td').length === 0 && $(first).children('th').length > 0;
      if (firstIsHeader) {
        headRows.push(rowHtml(first as Element));
        bodyRowEls = bodyRowEls.slice(1);
      }
    }
    const bodyRows = bodyRowEls.map((r) => rowHtml(r as Element));
    const attrs = blockAttrs([], cls);
    // DELIBERATELY no wp-block-table class on the figure: block-library's
    // `.wp-block-table td/th { border/padding }` class rules out-rank the
    // source's element rules (td, th { … }) and inflate every row — there is
    // no specificity slot that beats the WP class yet defers to the source
    // element selectors. Without the class the WP table css never matches and
    // the source owns the table entirely. Editor re-save restores the class
    // (documented canonicalization drift, accepted for parity).
    const figCls = cls;
    const figAttr = figCls ? ` class="${escapeHtml(figCls)}"` : '';
    const thead = headRows.length ? `<thead>${headRows.join('')}</thead>` : '';
    const tbody = `<tbody>${bodyRows.join('')}</tbody>`;
    return {
      markup: `<!-- wp:table${attrs} -->\n<figure${figAttr}><table>${thead}${tbody}</table></figure>\n<!-- /wp:table -->`,
      clean: true,
    };
  }

  // Rescue img descendants before the catch-all downgrade — an unknown
  // wrapper (e.g. <figure>) flattened to a text paragraph would silently
  // lose its image URLs ("never lose source content").
  const imgs = $el.find('img');
  if (imgs.length > 0) {
    const imgMarkup = imgs
      .map((_, imgEl) => imageBlock($, imgEl))
      .get()
      .join('\n');
    const text = escapeHtml($el.text().trim());
    const textPara = text ? `\n${paragraphBlock(text)}` : '';
    return { markup: imgMarkup + textPara, clean: false };
  }

  // Fallback: downgrade unknown element to a paragraph of its text.
  return { markup: paragraphBlock(escapeHtml($el.text().trim())), clean: false };
}

export interface EmitSectionOpts {
  /** Wrapper element for the group. Body sections default to 'section' so
   * carried source `section { … }` rules keep matching; chrome consumers
   * (footer part) pass 'div' — a footer's content is NOT a body section and
   * must not attract section margins (walrus probe: +88px inside footer). */
  wrapper?: 'section' | 'div';
}

/**
 * B1 verbatim-wrap (tabs/slider/modal): the custom Interactivity wrapper
 * around the section's UNCONVERTED inner HTML. Root directives only —
 * view.js wires the verbatim descendants imperatively from callbacks.init
 * (the dla/sticky precedent), so no descendant directives are injected.
 * Context keys match the landed view.js reads: tabs {activeClass}, slider
 * {activeClass, intervalMs?}, modal EMPTY (no data-wp-context attribute at
 * all — native <dialog> semantics need no params).
 */
function verbatimBehaviorMarkup(
  section: Section,
  b: TabsBehavior | SliderBehavior | ModalBehavior,
  rawInner: string,
): string {
  const cls = (section.classes ?? []).join(' ');
  // Fail-closed insurance: a verbatim HTML comment SHAPED like a block
  // delimiter would confuse the WP parser (pair form throws at the roundtrip
  // gate; void form silently re-parents). Strip just those; plain comments
  // stay (realistic exposure ~0, research-verified).
  const inner = rawInner.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '');
  const pairs = [`"anchor":${attrJson(section.id)}`];
  const ctxPairs: string[] = [];
  if (b.kind === 'tabs' || b.kind === 'slider') {
    pairs.push(`"activeClass":${attrJson(b.activeClass)}`);
    ctxPairs.push(`"activeClass":${attrJson(b.activeClass)}`);
    if (b.kind === 'slider' && b.intervalMs !== undefined) {
      pairs.push(`"intervalMs":${JSON.stringify(b.intervalMs)}`);
      ctxPairs.push(`"intervalMs":${JSON.stringify(b.intervalMs)}`);
    }
  }
  const attrs = blockAttrs(pairs, cls);
  // The context JSON sits in a single-quoted HTML attribute: attrJson covers
  // the kses '--' trap; the ' escape is belt-and-braces (classes are
  // capture-constrained upstream) — mirrors the sticky state block.
  const ctx = ctxPairs.length ? `{${ctxPairs.join(',')}}`.replace(/'/g, '\\u0027') : '';
  const ctxAttr = ctx ? ` data-wp-context='${ctx}'` : '';
  const wrapCls = [`wp-block-dla-${b.kind}`, cls].filter(Boolean).join(' ');
  return (
    `<!-- wp:dla/${b.kind}${attrs} -->\n` +
    `<section id="${escapeHtml(section.id)}" class="${escapeHtml(wrapCls)}"` +
    ` data-wp-interactive="dla/${b.kind}"${ctxAttr} data-wp-init="callbacks.init">${inner}</section>\n` +
    `<!-- /wp:dla/${b.kind} -->`
  );
}

export function emitSectionBlocks(section: Section, opts: EmitSectionOpts = {}): { markup: string; confidence: number } {
  const $ = cheerio.load(section.html);
  // Include 'main' so that segmentPage's main-fallback case (which emits a
  // <main> outerHTML as one Section) resolves its container correctly.
  // DEVIATION from plan: plan's selector was 'section, article, div' — that
  // misses <main>, causing the fallback section to hit $('body') and then
  // emitChild on the whole <main> element, which downgrades to a paragraph.
  const root = $('section, article, main, div').first();
  const container = root.length ? root : $('body');

  // B1 verbatim-wrap: a tabs/slider/modal section SKIPS the emitChild
  // conversion entirely — interactive scaffolding (role/aria attrs, buttons,
  // panels, slides) must survive byte-true so source CSS and the imperative
  // view.js keep matching; the conversion pipeline would downgrade it
  // ("never lose source content"). confidence 1: nothing is converted, so
  // nothing can degrade. Editor shows the accepted missing-block placeholder
  // either way (B2). Like the reveal branch, opts.wrapper is deliberately
  // ignored (behavior tags only arrive on body sections).
  if (section.behavior && section.behavior.kind !== 'reveal') {
    return {
      markup: verbatimBehaviorMarkup(section, section.behavior, container.html() ?? ''),
      confidence: 1,
    };
  }

  const childMarkup: string[] = [];
  let downgrades = 0;
  let total = 0;

  // Iterate contents() (not children()) so loose text nodes at the section
  // root survive as paragraphs instead of being silently dropped.
  for (const node of container.contents().get()) {
    if (isTag(node)) {
      total += 1;
      const res = emitChild($, node);
      if (!res.clean) downgrades += 1;
      childMarkup.push(res.markup);
    } else if (isText(node)) {
      const text = node.data.trim();
      if (!text) continue;
      total += 1;
      childMarkup.push(paragraphBlock(escapeHtml(text)));
    }
  }

  const inner = childMarkup.join('\n');
  const cls = (section.classes ?? []).join(' ');
  const confidence = total === 0 ? 0 : 1 - downgrades / total;

  // nativeBehaviors: a tagged section swaps core/group for the custom
  // Interactivity wrapper. SAME inner markup, same semantic <section> +
  // identity classes (carried css keeps matching, stage 1d constraints:
  // NO layout attribute, tagName stays section). Behavior params ride
  // data-wp-context (runtime) + inline custom properties (css animation),
  // both per-site; the plugin files (src/blocks/) are static. Deliberately
  // ignores opts.wrapper — behavior tags only arrive on body sections, which
  // use the default <section> wrapper (chrome consumers never tag).
  if (section.behavior?.kind === 'reveal') {
    const b = section.behavior;
    const pairs = [
      `"anchor":${attrJson(section.id)}`,
      `"threshold":${JSON.stringify(b.threshold)}`,
      `"translateY":${attrJson(b.translateY)}`,
      `"durationMs":${JSON.stringify(b.durationMs)}`,
    ];
    const attrs = blockAttrs(pairs, cls);
    // The context JSON sits in a single-quoted HTML attribute: numbers and
    // booleans only, so no single quote can break out; the '--' escape mirrors
    // attrJson (kses -- trap) — a number cannot contain '--' today, but the
    // contract is enforced here so a future string key cannot regress it.
    const ctx = `{"visible":false,"threshold":${JSON.stringify(b.threshold)}}`.replace(
      /--/g,
      '\\u002d\\u002d',
    );
    const wrapCls = ['wp-block-dla-reveal', cls].filter(Boolean).join(' ');
    const markup =
      `<!-- wp:dla/reveal${attrs} -->\n` +
      `<section id="${escapeHtml(section.id)}" class="${escapeHtml(wrapCls)}"` +
      ` style="--dla-reveal-y:${escapeHtml(b.translateY)};--dla-reveal-ms:${b.durationMs}ms"` +
      ` data-wp-interactive="dla/reveal" data-wp-context='${ctx}'` +
      ` data-wp-init="callbacks.init" data-wp-class--is-visible="context.visible">${inner}</section>\n` +
      `<!-- /wp:dla/reveal -->`;
    return { markup, confidence };
  }

  const anchorPair = `"anchor":${attrJson(section.id)}`;
  // tagName:section so carried source CSS element-selectors (section { … })
  // keep matching the block DOM — core/group supports semantic tagNames and
  // serializes <section class="wp-block-group …"> (stage 1d parity).
  const tagPair = '"tagName":"section"';
  // NO layout attribute at all: any layout type (constrained OR flow) makes WP
  // emit per-container css — child max-widths, margin zeroing, blockGap — that
  // fights the carried source rhythm (probe: replica h1 margin-bottom forced to
  // 0, uniform 24px gaps replacing the source's 16px/1.5em cadence). Without
  // the attr there is no is-layout-* class and no injected rules; the source
  // stylesheet owns spacing entirely.
  const wrapper = opts.wrapper ?? 'section';
  const wrapperPairs = wrapper === 'section' ? [anchorPair, tagPair] : [anchorPair];
  const attrs = blockAttrs(wrapperPairs, cls);
  const divCls = ['wp-block-group', cls].filter(Boolean).join(' ');
  const markup =
    `<!-- wp:group${attrs} -->\n` +
    `<${wrapper} id="${escapeHtml(section.id)}" class="${escapeHtml(divCls)}">${inner}</${wrapper}>\n` +
    `<!-- /wp:group -->`;
  return { markup, confidence };
}
