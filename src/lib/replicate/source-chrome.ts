import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

export interface ThemeChromeLink {
  label: string;
  href: string;
  external: boolean;
}

export interface ThemeChromeEvidence {
  header?: {
    logoUrl?: string;
    logoAlt?: string;
    links: ThemeChromeLink[];
  };
  footer?: {
    text: string[];
    links: ThemeChromeLink[];
  };
}

const IGNORE_LINK_LABELS = new Set(['', 'menu', 'scroll', 'top of page', 'skip to main content']);

export function extractThemeChromeFromHtml(html: string, sourceUrl: string): ThemeChromeEvidence {
  if (!html.trim()) return {};

  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const $header = firstUseful($, [
    'header',
    '[role="banner"]',
    '.wixui-header',
    '[data-testid="header"]',
    '#header',
    '.site-header',
  ]);
  const $footer = firstUseful($, [
    'footer',
    '[role="contentinfo"]',
    '.wixui-footer',
    '[data-testid="footer"]',
    '#footer',
    '.site-footer',
  ]);

  const out: ThemeChromeEvidence = {};
  if ($header.length > 0) {
    const logo = extractLogo($, $header, sourceUrl);
    out.header = {
      ...logo,
      links: extractLinks($, $header, sourceUrl, 10),
    };
  }
  if ($footer.length > 0) {
    out.footer = {
      text: extractFooterText($, $footer),
      links: extractLinks($, $footer, sourceUrl, 12),
    };
  }

  return out;
}

function firstUseful($: cheerio.CheerioAPI, selectors: string[]): cheerio.Cheerio<AnyNode> {
  for (const selector of selectors) {
    const $match = $(selector).first();
    if ($match.length > 0 && normalizeText($match.text()).length > 0) {
      return $match;
    }
  }
  return $([]);
}

function extractLogo(
  $: cheerio.CheerioAPI,
  $root: cheerio.Cheerio<AnyNode>,
  sourceUrl: string,
): { logoUrl?: string; logoAlt?: string } {
  const images = $root.find('img').toArray();
  const scored = images
    .map((el) => {
      const $img = $(el);
      const alt = normalizeText($img.attr('alt') ?? '');
      const src = $img.attr('src') ?? '';
      const parentHref = $img.closest('a').attr('href') ?? '';
      let score = 0;
      if (/logo/i.test(alt) || /logo/i.test(src)) score += 4;
      if (isHomeHref(parentHref, sourceUrl)) score += 2;
      if ($img.attr('fetchpriority') === 'high') score += 1;
      return { src, alt, score };
    })
    .filter((item) => item.src && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const logo = scored[0];
  if (!logo) return {};
  return {
    logoUrl: absolutizeUrl(logo.src, sourceUrl),
    logoAlt: logo.alt || 'Site logo',
  };
}

function extractLinks(
  $: cheerio.CheerioAPI,
  $root: cheerio.Cheerio<AnyNode>,
  sourceUrl: string,
  limit: number,
): ThemeChromeLink[] {
  const origin = safeUrl(sourceUrl)?.origin;
  const seen = new Set<string>();
  const links: ThemeChromeLink[] = [];

  $root.find('nav a, a[data-part="menu-item-link"], a').each((_, el) => {
    const $link = $(el);
    const label = normalizeText($link.text());
    if (IGNORE_LINK_LABELS.has(label.toLowerCase())) return;
    const rawHref = $link.attr('href') ?? '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) return;

    const absolute = absolutizeUrl(rawHref, sourceUrl);
    if (!absolute) return;
    const parsed = safeUrl(absolute);
    if (!parsed) return;
    const external = origin ? parsed.origin !== origin : /^https?:\/\//i.test(absolute);
    const href = external ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
    const key = `${label.toLowerCase()} ${href}`;
    if (seen.has(key)) return;
    seen.add(key);

    links.push({ label, href: href === '' ? '/' : href, external });
  });

  return links.slice(0, limit);
}

function extractFooterText($: cheerio.CheerioAPI, $footer: cheerio.Cheerio<AnyNode>): string[] {
  const seen = new Set<string>();
  const linkLabels = new Set<string>();
  $footer.find('a').each((_, el) => {
    const text = normalizeText($(el).text());
    if (text) linkLabels.add(text.toLowerCase());
  });
  const chunks: string[] = [];
  $footer.find('p,h1,h2,h3,h4,h5,h6,li').each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text || text.length < 3) return;
    if (IGNORE_LINK_LABELS.has(text.toLowerCase())) return;
    if (linkLabels.has(text.toLowerCase())) return;
    if (seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    chunks.push(text);
  });
  if (chunks.length > 0) return chunks.slice(0, 8);

  const fallback = normalizeText($footer.text());
  return fallback ? [fallback.slice(0, 240)] : [];
}

function isHomeHref(href: string, sourceUrl: string): boolean {
  const parsed = safeUrl(absolutizeUrl(href, sourceUrl));
  const source = safeUrl(sourceUrl);
  if (!parsed || !source) return false;
  return parsed.origin === source.origin && (parsed.pathname === '/' || parsed.pathname === '');
}

function absolutizeUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
