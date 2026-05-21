/**
 * src/lib/screenshot/nav-extract.ts
 * ===================================
 * Modular, source-agnostic nav extraction from a live JS-rendered header element.
 *
 * `extractNav` is designed to run INSIDE the browser via `page.evaluate`.
 * It returns a structured `ExtractedNav` from the first argument (a detected
 * `header` / `[role="banner"]` element) — completely decoupled from any
 * particular platform (Wix today; any tomorrow).
 *
 * Heuristics used (documented so they can be tuned per-platform if needed):
 *
 * Logo detection
 * ──────────────
 * 1. First `<img>` whose alt, src, or parent class/id contains "logo" (case-
 *    insensitive). Falls back to the first `<img>` in the header.
 * 2. logoSrc is the RAW attribute value (not resolved via `currentSrc`) so it
 *    threads through the same media rewrite pipeline as other images.
 * 3. siteTitle falls back to the visible `<a>` text near the root of the header
 *    when no img is found.
 *
 * Nav links
 * ─────────
 * 1. All `<a>` elements inside the first `<nav>` (or, if no `<nav>`, all `<a>`
 *    elements in the header). Only links with non-empty trimmed text AND a non-
 *    trivial href (not null, not pure "#", not "javascript:") are kept.
 * 2. Deduped by label+href. Capped at MAX_NAV_ITEMS=8 to match typical nav sizes.
 * 3. Pure in-page anchor links (href === "#") are skipped.
 *
 * CTA detection
 * ─────────────
 * A link qualifies as CTA when ANY of:
 *   - computed background-color is not transparent / rgba(0,0,0,0)
 *   - computed border-radius > 0
 *   - class or id contains "button", "btn", "cta" (case-insensitive)
 * The LAST qualifying link in document order wins (CTAs tend to appear at the
 * end of the nav). If the CTA is the only nav item it is not extracted as CTA
 * (we keep it in items instead).
 *
 * Style
 * ─────
 * - background: getComputedStyle of the header. When transparent, walks the
 *   nearest opaque ancestor up to <body> (depth ≤ 5).
 * - textColor: getComputedStyle.color of a representative nav link (first <a>
 *   that has non-empty trimmed text inside the detected nav scope).
 * - fontFamily: same representative link; trimmed to the first family name.
 * - ctaBackground / ctaTextColor: from the CTA element when present.
 * - height: header.getBoundingClientRect().height.
 *
 * The returned logoSrc must flow through the existing media pipeline.
 * Nav item hrefs are kept as-is (a TODO to map them to local page slugs later).
 */

export interface ExtractedNav {
  /** First img in header with logo-like hints; raw attribute src (not resolved). */
  logoSrc: string | null;
  logoAlt: string | null;
  /** Text fallback when no logo img found. */
  siteTitle: string | null;
  /** Top-level nav links; deduped, capped at 8, no pure anchors. */
  items: { label: string; href: string }[];
  /** A button-styled link (bg / border-radius / class hint), or null. */
  cta: { label: string; href: string } | null;
  style: {
    /** Header background-color (rgba string). May be 'transparent' or 'rgba(0,0,0,0)' when indeterminate. */
    background: string;
    /** Color of a representative nav link. */
    textColor: string;
    /** CTA background-color, or null. */
    ctaBackground: string | null;
    /** CTA text color, or null. */
    ctaTextColor: string | null;
    /** First font-family in the computed stack for nav links. */
    fontFamily: string;
    /** Header element height in px. */
    height: number;
  };
}

const MAX_NAV_ITEMS = 8;

/**
 * Extract structured nav data from a header element.
 *
 * Designed to run inside the browser (page.evaluate).
 * Source-agnostic — works on Wix, Shopify, Webflow, etc.
 *
 * @param headerEl - The detected site header element.
 */
export function extractNav(headerEl: Element): ExtractedNav {
  // ── Logo ──────────────────────────────────────────────────────────────────
  const allImgs = Array.from(headerEl.querySelectorAll('img'));
  const isLogoLike = (img: HTMLImageElement): boolean => {
    const hint = [img.alt, img.src, img.className, img.id,
      img.parentElement?.className ?? '', img.parentElement?.id ?? '']
      .join(' ')
      .toLowerCase();
    return /logo/.test(hint);
  };
  const logoImg = (allImgs.find((img) => isLogoLike(img as HTMLImageElement)) ?? allImgs[0] ?? null) as HTMLImageElement | null;
  const logoSrc = logoImg ? (logoImg.getAttribute('src') ?? null) : null;
  const logoAlt = logoImg ? (logoImg.getAttribute('alt') ?? null) : null;

  // ── Nav scope ─────────────────────────────────────────────────────────────
  // Primary links come from the <nav> (or [role="navigation"]) scope.
  // CTA detection also scans the full header so button-styled links outside
  // the <nav> (a common pattern: logo | nav | CTA) are captured.
  const navEl = headerEl.querySelector('nav, [role="navigation"]') ?? headerEl;

  // All valid link candidates (non-empty text, meaningful href) from the header.
  const isValidAnchor = (a: Element): boolean => {
    const href = (a as HTMLAnchorElement).getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:')) return false;
    const label = a.textContent?.trim() ?? '';
    return !!label;
  };

  // Nav-scope anchors: primary source for nav items.
  const navAnchorEls = Array.from(navEl.querySelectorAll('a')).filter(isValidAnchor) as HTMLAnchorElement[];

  // All header anchors: used for CTA scanning (includes elements outside <nav>).
  const allHeaderAnchorEls = Array.from(headerEl.querySelectorAll('a')).filter(isValidAnchor) as HTMLAnchorElement[];

  // ── CTA detection ─────────────────────────────────────────────────────────
  // Scan ALL header links for button-like appearance. Last qualifying link wins
  // (CTAs usually appear at the end — "Contact Us", "Get Started", etc).
  const isCtaLike = (a: HTMLAnchorElement): boolean => {
    const cs = getComputedStyle(a);
    const bg = cs.backgroundColor;
    const isOpaque = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const hasBorderRadius = parseFloat(cs.borderRadius) > 0;
    const classHint = /button|btn|cta/i.test(a.className + ' ' + (a.id ?? '') + ' ' + (a.parentElement?.className ?? ''));
    return !!(isOpaque || hasBorderRadius || classHint);
  };
  let ctaEl: HTMLAnchorElement | null = null;
  for (const a of allHeaderAnchorEls) {
    if (isCtaLike(a)) ctaEl = a;
  }

  // ── Nav items ─────────────────────────────────────────────────────────────
  // Use nav-scope anchors as the primary source; skip the detected CTA.
  const seen = new Set<string>();
  const items: { label: string; href: string }[] = [];
  for (const a of navAnchorEls) {
    if (a === ctaEl) continue; // skip CTA from items
    const label = (a.textContent ?? '').trim();
    const href = a.getAttribute('href') ?? '';
    const key = `${label}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ label, href });
    if (items.length >= MAX_NAV_ITEMS) break;
  }

  // If no nav-scope items but there are header-level links, fall back to those.
  if (items.length === 0) {
    for (const a of allHeaderAnchorEls) {
      if (a === ctaEl) continue;
      const label = (a.textContent ?? '').trim();
      const href = a.getAttribute('href') ?? '';
      const key = `${label}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ label, href });
      if (items.length >= MAX_NAV_ITEMS) break;
    }
  }

  // If all anchors were CTA and no items remain, put CTA back into items.
  if (items.length === 0 && ctaEl) {
    const label = (ctaEl.textContent ?? '').trim();
    const href = ctaEl.getAttribute('href') ?? '';
    items.push({ label, href });
    ctaEl = null; // no items → no CTA split makes sense
  }

  const cta = ctaEl
    ? { label: (ctaEl.textContent ?? '').trim(), href: ctaEl.getAttribute('href') ?? '' }
    : null;

  // ── Site title fallback ───────────────────────────────────────────────────
  let siteTitle: string | null = null;
  if (!logoImg) {
    // Look for a prominent text node near the root of the header
    const titleLink = (headerEl.querySelector('a') as HTMLAnchorElement | null);
    if (titleLink) {
      siteTitle = titleLink.textContent?.trim() ?? null;
    }
    if (!siteTitle) {
      // Try heading or strong
      const h = headerEl.querySelector('h1,h2,h3,strong,[class*="title"],[class*="logo"]');
      if (h) siteTitle = h.textContent?.trim() ?? null;
    }
  }

  // ── Style ─────────────────────────────────────────────────────────────────
  // Background: walk up from header to find first opaque ancestor.
  const getBackground = (): string => {
    const TRANSPARENT = ['transparent', 'rgba(0, 0, 0, 0)'];
    let el: Element | null = headerEl;
    for (let depth = 0; depth <= 5 && el; depth++) {
      const bg = getComputedStyle(el as HTMLElement).backgroundColor;
      if (bg && !TRANSPARENT.includes(bg)) return bg;
      el = el.parentElement;
    }
    return getComputedStyle(headerEl as HTMLElement).backgroundColor;
  };

  // Representative link for text/font extraction
  const repLink = (navEl.querySelector('a') as HTMLAnchorElement | null) ?? (headerEl.querySelector('a') as HTMLAnchorElement | null);
  const repCs = repLink ? getComputedStyle(repLink) : getComputedStyle(headerEl as HTMLElement);

  const textColor = repCs.color || '#000000';
  const rawFamily = repCs.fontFamily || '';
  // Trim to first family: e.g. '"Open Sans", sans-serif' → 'Open Sans'
  const fontFamily = rawFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');

  const background = getBackground();
  const height = (headerEl as HTMLElement).getBoundingClientRect().height;

  let ctaBackground: string | null = null;
  let ctaTextColor: string | null = null;
  if (ctaEl) {
    const ctaCs = getComputedStyle(ctaEl);
    const bg = ctaCs.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      ctaBackground = bg;
    }
    ctaTextColor = ctaCs.color || null;
  }

  return {
    logoSrc,
    logoAlt,
    siteTitle: siteTitle || null,
    items,
    cta,
    style: { background, textColor, ctaBackground, ctaTextColor, fontFamily, height },
  };
}

// ---------------------------------------------------------------------------
// Browser injection source string
// ---------------------------------------------------------------------------

/**
 * Self-contained factory source for the extractNav function.
 * Evaluated in the browser via:
 *   new Function('return (' + factorySrc + ')')()
 * Returns `{ extractNav }`.
 */
const _extractNavSrc = extractNav.toString();

const _navFactorySrc = `(function() {
  var MAX_NAV_ITEMS = ${MAX_NAV_ITEMS};
  var extractNav = (${_extractNavSrc});
  return { extractNav: extractNav };
})`;

export const NAV_EXTRACT_FACTORY_SOURCE: { factorySrc: string } = {
  factorySrc: _navFactorySrc,
};
