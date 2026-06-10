import { posix } from 'node:path';
import * as cheerio from 'cheerio';
import { slugFromRelPath } from './ingest.js';
import type { LocalSite, NavLink } from './types.js';

/** True for hrefs that point outside the local site (absolute URL, mailto, anchor). */
function isExternal(href: string): boolean {
  return /^[a-z]+:/i.test(href) || href.startsWith('//') || href.startsWith('#');
}

/** Resolve a raw internal href against the linking page's relPath → site-root-relative path. */
function resolveHrefToRelPath(href: string, fromRelPath: string): string {
  const cleaned = href.split(/[?#]/)[0];
  if (!cleaned || cleaned === '/') return 'index.html';
  if (cleaned.startsWith('/')) return cleaned.slice(1); // root-relative
  // Relative href: resolve against the linking page's directory. Paths that
  // escape the site root keep a leading ".." after normalize and simply won't
  // match any known slug downstream — dropped, which is the right outcome.
  return posix.normalize(posix.join(posix.dirname(fromRelPath), cleaned));
}

export function buildNavGraph(site: LocalSite): NavLink[] {
  const knownSlugs = new Set(site.pages.map((p) => p.slug));
  const links: NavLink[] = [];
  for (const page of site.pages) {
    const $ = cheerio.load(page.html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href || isExternal(href)) return;
      const toSlug = slugFromRelPath(resolveHrefToRelPath(href, page.relPath));
      if (!knownSlugs.has(toSlug)) return;
      links.push({ fromSlug: page.slug, toSlug, label: $(el).text().trim() });
    });
  }
  return links;
}
