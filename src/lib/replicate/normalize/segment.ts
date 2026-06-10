// src/lib/replicate/normalize/segment.ts
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { Section, SectionRole } from '../local-site/types.js';

/** Slugify a short text run for use in an id. */
function textSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Stable id: existing id → heading-text slug → first class → content hash.
 * Heading slug beats class so utility-first markup (class="flex mt-8") yields
 * a meaningful, collision-resistant id instead of "flex".
 */
function stableId($: CheerioAPI, el: Element, ordinal: number): string {
  const $el = $(el);
  const existing = $el.attr('id');
  if (existing) return existing;
  const heading = $el.find('h1,h2,h3').first().text();
  const slug = heading.trim() ? textSlug(heading) : '';
  if (slug) return slug;
  const cls = ($el.attr('class') ?? '').split(/\s+/).filter(Boolean)[0];
  if (cls) return cls;
  const hash = createHash('sha1')
    .update($.html(el) ?? '')
    .digest('hex')
    .slice(0, 8);
  return `section-${hash}-${ordinal}`;
}

export function segmentPage(html: string): Section[] {
  const $ = cheerio.load(html);
  const sections: Section[] = [];

  const pushChrome = (selector: string, role: SectionRole): void => {
    const el = $(selector).first();
    if (el.length) sections.push({ id: role, role, html: $.html(el) ?? '' });
  };
  // Strict body-direct landmarks only. A comma-fallback (bare `header`) would
  // grab nested landmarks — e.g. an <article>'s own <header> — misclassifying
  // them as page chrome AND double-capturing them inside the body section.
  // Missing chrome = emit nothing. A nav INSIDE the header stays embedded in
  // the header's html (not captured separately).
  pushChrome('body > header', 'header');
  pushChrome('body > nav', 'nav');
  pushChrome('body > footer', 'footer');

  const main = $('main').first();
  const container = main.length ? main : $('body');
  let ordinal = 0;
  container.children('section, article, div').each((_, el) => {
    sections.push({ id: stableId($, el as Element, ordinal), role: 'body', html: $.html(el) ?? '' });
    ordinal += 1;
  });

  // No-silent-content-loss fallback: a <main> whose children are all loose
  // content (h1/p/img — no section/article/div wrappers) matched nothing
  // above. Emit <main> itself as ONE body section rather than dropping the
  // page body. Only the main-exists case; a wrapper-less <body> stays as-is.
  if (ordinal === 0 && main.length && container.children().length > 0) {
    sections.push({ id: stableId($, main.get(0) as Element, 0), role: 'body', html: $.html(main) ?? '' });
  }

  // Dedup duplicate body-section ids with ordinal suffixes (deterministic,
  // DOM order — matches the media filename-collision convention). Two
  // class="card" sections are normal; a silent pageContent[id] overwrite
  // downstream is not.
  const seen = new Map<string, number>();
  for (const s of sections) {
    if (s.role !== 'body') continue;
    const count = (seen.get(s.id) ?? 0) + 1;
    seen.set(s.id, count);
    if (count > 1) s.id = `${s.id}-${count}`;
  }

  return sections;
}
