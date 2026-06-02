//
// Shared page-body internal-link map builder
// ==========================================
// Both reconstruct paths (block `reconstruct-pages` and carry-and-scope
// `reconstruct-pages-alt`) rewrite source hrefs in page bodies / nav parts to
// the imported WordPress permalinks. They build the rewrite map the SAME way —
// from `<outputDir>/redirect-map.json` (the canonical source-path → local
// permalink map the nav/footer rewrite also consumes), seeded with the page
// origins so ABSOLUTE same-site hrefs match too.
//
// Extracted here so the two handlers share one implementation instead of each
// carrying a private copy. Pure except for the single redirect-map read.
//

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildInternalLinkMap,
  type InternalLinkMap,
  type RedirectMapEntry,
} from '../streaming/internal-link-rewrite.js';

/**
 * Build the page-body link map from `<outputDir>/redirect-map.json` plus the
 * hostnames of the supplied page source URLs (so absolute same-site hrefs
 * match). Best-effort: a missing/corrupt map yields a root-only map and links
 * simply pass through unrewritten.
 *
 * @param outputDir       Liberation output directory containing redirect-map.json.
 * @param pageSourceUrls  Source URLs of the pages being reconstructed — their
 *                        hostnames seed the absolute-href (host+path) keys.
 */
export function buildPageLinkMap(outputDir: string, pageSourceUrls: string[]): InternalLinkMap {
  let redirectMap: RedirectMapEntry[] = [];
  try {
    const p = join(resolve(outputDir), 'redirect-map.json');
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(parsed)) redirectMap = parsed as RedirectMapEntry[];
    }
  } catch {
    /* best-effort — fall back to a root-only map */
  }
  const origins = new Set<string>();
  for (const url of pageSourceUrls) {
    try {
      origins.add(new URL(url).hostname);
    } catch {
      /* skip an unparseable source URL */
    }
  }
  return buildInternalLinkMap(redirectMap, { siteOrigins: [...origins] });
}
