// src/lib/replicate/normalize/emit-blocks.ts
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { Section } from '../local-site/types.js';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const HEADING = /^h([1-6])$/;

interface ChildResult {
  markup: string;
  clean: boolean;
}

/** Map a single child element to a core block. clean=false when downgraded. */
function emitChild($: CheerioAPI, el: Element): ChildResult {
  const tag = el.tagName?.toLowerCase() ?? '';
  const $el = $(el);
  const text = escapeHtml($el.text().trim());

  const h = HEADING.exec(tag);
  if (h) {
    const level = Number(h[1]);
    const attrs = level === 2 ? '' : ` {"level":${level}}`;
    return {
      markup: `<!-- wp:heading${attrs} -->\n<h${level}>${text}</h${level}>\n<!-- /wp:heading -->`,
      clean: true,
    };
  }

  if (tag === 'p') {
    return {
      markup: `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`,
      clean: true,
    };
  }

  if (tag === 'img') {
    const src = escapeHtml($el.attr('src') ?? '');
    const alt = escapeHtml($el.attr('alt') ?? '');
    return {
      markup: `<!-- wp:image -->\n<figure class="wp-block-image"><img src="${src}" alt="${alt}"/></figure>\n<!-- /wp:image -->`,
      clean: true,
    };
  }

  if (tag === 'a' && /\b(button|btn)\b/i.test($el.attr('class') ?? '')) {
    const href = escapeHtml($el.attr('href') ?? '');
    return {
      markup:
        `<!-- wp:buttons -->\n<div class="wp-block-buttons">` +
        `<!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${href}">${text}</a></div>\n<!-- /wp:button -->` +
        `</div>\n<!-- /wp:buttons -->`,
      clean: true,
    };
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = $el
      .children('li')
      .map((_, li) => `<!-- wp:list-item -->\n<li>${escapeHtml($(li).text().trim())}</li>\n<!-- /wp:list-item -->`)
      .get()
      .join('\n');
    const ordered = tag === 'ol' ? ' {"ordered":true}' : '';
    const ulTag = tag === 'ol' ? 'ol' : 'ul';
    return {
      markup: `<!-- wp:list${ordered} -->\n<${ulTag} class="wp-block-list">${items}</${ulTag}>\n<!-- /wp:list -->`,
      clean: true,
    };
  }

  // Fallback: downgrade unknown element to a paragraph of its text.
  return {
    markup: `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`,
    clean: false,
  };
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

  container.children().each((_, el) => {
    total += 1;
    const res = emitChild($, el as Element);
    if (!res.clean) downgrades += 1;
    childMarkup.push(res.markup);
  });

  const inner = childMarkup.join('\n');
  const markup =
    `<!-- wp:group {"layout":{"type":"constrained"}} -->\n` +
    `<div class="wp-block-group">${inner}</div>\n` +
    `<!-- /wp:group -->`;
  const confidence = total === 0 ? 0 : 1 - downgrades / total;
  return { markup, confidence };
}
