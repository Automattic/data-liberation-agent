// src/lib/replicate/reconstruct-pages.ts
//
// Deterministic per-PAGE reconstruction core. Given a page's captured section
// specs, produce the theme files that render it as block sections: a pattern
// (`patterns/page-<slug>.php`), a template that wires header→pattern→footer
// (`templates/page-<slug>.html`, plus `front-page.html` for the home page), and
// the pattern's icon SVG assets — all gated through validate_artifacts.
//
// WHY THIS EXISTS
// The /liberate→replicate flow historically reconstructed only ONE representative
// per layout cluster and rendered every other page through page.html with carried
// source HTML (raw Wix/Shopify markup) — which looks drastically different from
// the source. This module reconstructs EVERY page from ITS OWN specs (no shared
// cluster skeleton, no carried-HTML fallback), the same path proven on getsnooz.
// The MCP handler (liberate_reconstruct_pages) composes this with extraction,
// media install, and the Studio write/flush; this part is pure + unit-tested.

import { reconstructPagePattern } from './page-reconstruct.js';
import { validateArtifacts, type ValidationReport } from './validate-artifacts.js';
import type { SectionSpec } from './section-extract.js';
import type { PaletteToken } from './footer-color.js';

/** A theme file to write, path relative to the theme root. */
export interface ReconstructedFile {
  path: string;
  content: string;
}

export interface PageReconstructionResult {
  slug: string;
  patternSlug: string;
  /** pattern php + per-page template(s) + icon SVG assets, theme-root-relative. */
  files: ReconstructedFile[];
  /** validate_artifacts report for the pattern — caller MUST NOT install when !ok. */
  gate: ValidationReport;
  expectedAssets: string[];
  provenanceFlags: string[];
  sectionsRendered: number;
  iconAssetCount: number;
}

// WP slug guard for filenames + block-attribute pattern slugs (mirrors the
// theme-scaffold check; sanitize_title-shaped).
const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A page template shell: header part → reconstructed pattern → footer part. */
function buildPageTemplate(patternSlug: string): string {
  return `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->

<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
<!-- wp:pattern {"slug":"${patternSlug}"} /-->
</main>
<!-- /wp:group -->

<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->
`;
}

/**
 * Build all theme files for one reconstructed page from its section specs.
 * Pure: specs in, files + gate report out. The caller installs the files ONLY
 * when `gate.ok` (a failing gate means escaping/injection/provenance violated —
 * never ship it). Throws on an unsafe slug rather than emitting a bad path.
 */
export function buildPageReconstruction(
  sections: SectionSpec[],
  opts: { slug: string; title: string; themeSlug: string; isHome?: boolean; paletteTokens?: PaletteToken[] },
): PageReconstructionResult {
  if (!SAFE_SLUG.test(opts.slug)) throw new Error(`unsafe page slug: "${opts.slug}"`);
  if (!SAFE_SLUG.test(opts.themeSlug)) throw new Error(`unsafe theme slug: "${opts.themeSlug}"`);

  const patternSlug = `${opts.themeSlug}/page-${opts.slug}`;
  const r = reconstructPagePattern(sections, { patternSlug, title: opts.title, paletteTokens: opts.paletteTokens });

  // The provenance/injection/escaping gate. The reconstruct output is validated
  // against its OWN captured corpus (expectedText ∪ bodyText) — this catches
  // escaping/injection and that emitted copy traces to captured source text.
  const gate = validateArtifacts({
    patterns: [
      {
        slug: patternSlug,
        php: r.php,
        spec: {
          interactionModel: 'static',
          expectedText: r.expectedText,
          bodyText: r.bodyText,
          expectedAssets: r.expectedAssets,
        },
      },
    ],
  });

  const template = buildPageTemplate(patternSlug);
  const files: ReconstructedFile[] = [
    { path: `patterns/page-${opts.slug}.php`, content: r.php },
    { path: `templates/page-${opts.slug}.html`, content: template },
    ...r.iconAssets.map((a) => ({ path: a.path, content: a.svg })),
  ];
  if (opts.isHome) {
    files.push({ path: 'templates/front-page.html', content: template });
  }

  return {
    slug: opts.slug,
    patternSlug,
    files,
    gate,
    expectedAssets: r.expectedAssets,
    provenanceFlags: r.provenanceFlags,
    sectionsRendered: r.sectionsRendered,
    iconAssetCount: r.iconAssets.length,
  };
}
