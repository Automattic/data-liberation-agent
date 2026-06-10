// src/lib/replicate/normalize/emit-blocks.ts
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { isTag, isText } from 'domhandler';
import type { Element } from 'domhandler';
import type { Section } from '../local-site/types.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HEADING = /^h([1-6])$/;

/** Inline tags preserved verbatim in rich-text content (a keeps only an escaped href). */
const INLINE_ALLOWED = new Set(['a', 'strong', 'em', 'b', 'i', 'br']);

/**
 * Serialize an element's inline content: allowed inline tags kept (anchors
 * keep only an escaped href — other attributes dropped), text nodes escaped,
 * anything else flattened to its escaped text. Links are content ("never
 * lose source content") — a paragraph's <a href> must survive emission.
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
        if (tag === 'a') {
          const href = escapeHtml($(node).attr('href') ?? '');
          out += `<a href="${href}">${inner}</a>`;
        } else {
          out += `<${tag}>${inner}</${tag}>`;
        }
      } else {
        out += escapeHtml($(node).text());
      }
    }
  }
  return out;
}

function imageBlock($: CheerioAPI, imgEl: Element): string {
  const src = escapeHtml($(imgEl).attr('src') ?? '');
  const alt = escapeHtml($(imgEl).attr('alt') ?? '');
  return `<!-- wp:image -->\n<figure class="wp-block-image"><img src="${src}" alt="${alt}"/></figure>\n<!-- /wp:image -->`;
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
    const attrs = level === 2 ? '' : ` {"level":${level}}`;
    const inner = inlineHtml($, el).trim();
    return {
      markup: `<!-- wp:heading${attrs} -->\n<h${level}>${inner}</h${level}>\n<!-- /wp:heading -->`,
      clean: true,
    };
  }

  if (tag === 'p') {
    return { markup: paragraphBlock(inlineHtml($, el).trim()), clean: true };
  }

  if (tag === 'img') {
    return { markup: imageBlock($, el), clean: true };
  }

  if (tag === 'a' && /\b(button|btn)\b/i.test($el.attr('class') ?? '')) {
    const href = escapeHtml($el.attr('href') ?? '');
    // Button labels are plain text — no inline markup inside the link.
    const label = escapeHtml($el.text().trim());
    return {
      markup:
        `<!-- wp:buttons -->\n<div class="wp-block-buttons">` +
        `<!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${href}">${label}</a></div>\n<!-- /wp:button -->` +
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
    const ordered = tag === 'ol' ? ' {"ordered":true}' : '';
    const ulTag = tag === 'ol' ? 'ol' : 'ul';
    return {
      markup: `<!-- wp:list${ordered} -->\n<${ulTag} class="wp-block-list">${items}</${ulTag}>\n<!-- /wp:list -->`,
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

export function emitSectionBlocks(section: Section): { markup: string; confidence: number } {
  const $ = cheerio.load(section.html);
  // Include 'main' so that segmentPage's main-fallback case (which emits a
  // <main> outerHTML as one Section) resolves its container correctly.
  // DEVIATION from plan: plan's selector was 'section, article, div' — that
  // misses <main>, causing the fallback section to hit $('body') and then
  // emitChild on the whole <main> element, which downgrades to a paragraph.
  const root = $('section, article, main, div').first();
  const container = root.length ? root : $('body');
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
  const markup =
    `<!-- wp:group {"layout":{"type":"constrained"}} -->\n` +
    `<div class="wp-block-group">${inner}</div>\n` +
    `<!-- /wp:group -->`;
  const confidence = total === 0 ? 0 : 1 - downgrades / total;
  return { markup, confidence };
}
