import * as cheerio from 'cheerio';
import { slugFromRelPath } from './ingest.js';
import type { LocalSite, NavLink } from './types.js';

/** True for hrefs that point outside the local site (absolute URL, mailto, anchor). */
function isExternal(href: string): boolean {
  return /^[a-z]+:/i.test(href) || href.startsWith('//') || href.startsWith('#');
}

export function buildNavGraph(site: LocalSite): NavLink[] {
  const knownSlugs = new Set(site.pages.map((p) => p.slug));
  const links: NavLink[] = [];
  for (const page of site.pages) {
    const $ = cheerio.load(page.html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href || isExternal(href)) return;
      const toSlug = slugFromRelPath(href.split(/[?#]/)[0]);
      if (!knownSlugs.has(toSlug)) return;
      links.push({ fromSlug: page.slug, toSlug, label: $(el).text().trim() });
    });
  }
  return links;
}
