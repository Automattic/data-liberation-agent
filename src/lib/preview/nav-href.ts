/**
 * src/lib/preview/nav-href.ts
 * ============================
 * Resolves a source-site nav href to its local imported page path.
 *
 * Rules:
 *   - Unparseable href (relative, anchor, mailto:, tel:) → returned unchanged.
 *   - Different registrable domain (eTLD+1) → EXTERNAL → returned unchanged.
 *   - Same site, pathname is `/` or empty → `/` (WP front page).
 *   - Same site, any other pathname → `/<slugify(href)>/`
 *     where slugify strips the leading `/` and converts interior `/` to `--`,
 *     matching exactly how imported pages get their slugs (src/adapters/shared.ts).
 */

import { registrableDomain } from '../screenshot/first-party.js';
import { slugify } from '../../adapters/shared.js';

/**
 * Map a source nav href to the corresponding local WordPress page path.
 *
 * @param href    - The href value from the extracted nav item (may be absolute,
 *                  relative, anchor, mailto:, etc.)
 * @param siteUrl - The base URL of the source site (e.g. "https://www.swiftlumber.com").
 *                  Used to determine whether `href` is first-party.
 * @returns The local path (e.g. `/about-us/`, `/`) for same-site pages, or
 *          the original href unchanged for external / relative / non-HTTP links.
 */
export function resolveNavHref(href: string, siteUrl: string): string {
  // Reject obviously non-absolute-URL values before attempting URL parsing:
  // relative paths, pure anchors, mailto:, tel:, javascript:, etc.
  // We only rewrite fully-qualified http(s) URLs.
  if (!href.startsWith('http://') && !href.startsWith('https://')) {
    return href;
  }

  let parsed: URL;
  let base: URL;

  try {
    parsed = new URL(href);
  } catch {
    return href;
  }

  try {
    base = new URL(siteUrl);
  } catch {
    // Can't parse siteUrl — can't determine first-party, leave href unchanged.
    return href;
  }

  // Different registrable domain → external link, keep unchanged.
  if (registrableDomain(parsed.hostname) !== registrableDomain(base.hostname)) {
    return href;
  }

  // Same site: check if it's the home page (root path).
  // Normalize by stripping trailing slashes from the pathname, then check
  // whether what remains is empty (meaning it was "/" or "").
  const rawPath = parsed.pathname;
  const stripped = rawPath.replace(/\/+$/, '');

  if (!stripped) {
    // Pathname is "/" or "" → front page.
    return '/';
  }

  // Non-root same-site URL: build a normalized URL with the trailing slash
  // removed (preserving origin) so slugify produces the same slug as the
  // imported page, which is slugify(canonicalUrl) without trailing slash.
  // Example: "https://example.com/about-us/" → strip trailing "/" from
  // pathname → "https://example.com/about-us" → slugify → "about-us".
  const normalized = new URL(parsed.href);
  normalized.pathname = stripped;
  normalized.search = '';
  normalized.hash = '';
  return `/${slugify(normalized.href)}/`;
}
