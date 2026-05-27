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

import { reconstructPagePattern, type FontFamilyToken } from './page-reconstruct.js';
import { validateArtifacts, type ValidationReport } from './validate-artifacts.js';
import { rewriteInternalLinks, type InternalLinkMap } from '../streaming/internal-link-rewrite.js';
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
  /** The page's post_content: the reconstructed block markup with literal
   *  theme-asset URLs (no PHP) — written into the WP post so it's a real, editable
   *  block page (not a Classic block wrapping carried HTML). */
  postContent: string;
  /** validate_artifacts report for the pattern — caller MUST NOT install when !ok. */
  gate: ValidationReport;
  expectedAssets: string[];
  provenanceFlags: string[];
  sectionsRendered: number;
  iconAssetCount: number;
}

/** Swap the pattern's `get_theme_file_uri()` PHP asset refs for literal
 *  theme-relative URLs, so the block markup is valid in post_content (which is
 *  NOT PHP-evaluated — the PHP would otherwise render as literal text). */
function toPostContent(body: string, themeSlug: string): string {
  return body.replace(
    /<\?php echo esc_url\(get_theme_file_uri\('([^']+)'\)\); \?>/g,
    (_m, rel: string) => `/wp-content/themes/${themeSlug}/${rel}`,
  );
}

// WP slug guard for filenames + block-attribute pattern slugs (mirrors the
// theme-scaffold check; sanitize_title-shaped).
const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * A page template shell: header part → reconstructed pattern → footer part.
 * When the page's hero is a full-bleed cover, the header template-part is tagged
 * with the `site-header-overlay` class so the theme renders it as a transparent
 * overlay on the hero (white nav over the photo). Other pages get the solid
 * header. The header distinction lives HERE, in the template — not in a global
 * `.home:has(cover)` CSS override.
 */
function buildPageTemplate(overlayHeader = false, fullWidth = false): string {
  const headerPart = overlayHeader
    ? `<!-- wp:template-part {"slug":"header","tagName":"header","className":"site-header-overlay"} /-->`
    : `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->`;
  // Full-width vs constrained DEFERS TO THE SOURCE (fullWidth): a source page with
  // full-bleed sections renders full-width so the hero + alignfull bands stretch
  // edge-to-edge (a `constrained` main/post-content would box them to ~content
  // width — the regression where the hero rendered ~1000px); each section still
  // constrains its OWN inner content. A source page with boxed content stays
  // constrained. An overlay-header page also zeroes the main top margin/padding so
  // the hero is flush with the page top (the absolute header floats above it).
  const layoutType = fullWidth ? 'default' : 'constrained';
  const mainAttrs = overlayHeader
    ? `"style":{"spacing":{"margin":{"top":"0px"},"padding":{"top":"0px"}}},"layout":{"type":"${layoutType}"}`
    : `"layout":{"type":"${layoutType}"}`;
  const topZeroStyle = overlayHeader ? ' style="margin-top:0px;padding-top:0px"' : '';
  const mainGroup = `<!-- wp:group {"tagName":"main",${mainAttrs}} -->
<main class="wp-block-group"${topZeroStyle}>`;
  const postContent = `<!-- wp:post-content {"layout":{"type":"${layoutType}"}} /-->`;
  // Render the PAGE's post_content (which the reconstruction writes as block
  // markup) — so the page is a real, editable block page. The theme still ships
  // the reconstructed pattern as a library entry.
  return `${headerPart}

${mainGroup}
${postContent}
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
  opts: {
    slug: string;
    title: string;
    themeSlug: string;
    isHome?: boolean;
    paletteTokens?: PaletteToken[];
    fontFamilies?: FontFamilyToken[];
    /**
     * Source-path → local-permalink map (built from `redirect-map.json` via
     * `buildInternalLinkMap`). When supplied, page-body links (inline + CTA
     * hrefs) are rewritten to their imported permalinks — the same map the
     * nav/footer rewrite consumes, so body links agree with the menu. Absent →
     * links pass through unchanged (back-compat).
     */
    linkMap?: InternalLinkMap;
  },
): PageReconstructionResult {
  if (!SAFE_SLUG.test(opts.slug)) throw new Error(`unsafe page slug: "${opts.slug}"`);
  if (!SAFE_SLUG.test(opts.themeSlug)) throw new Error(`unsafe theme slug: "${opts.themeSlug}"`);

  const patternSlug = `${opts.themeSlug}/page-${opts.slug}`;
  const r = reconstructPagePattern(sections, {
    patternSlug,
    title: opts.title,
    paletteTokens: opts.paletteTokens,
    fontFamilies: opts.fontFamilies,
  });

  // Rewrite same-site body links to local permalinks BEFORE the gate, so the
  // gate validates the final shipped markup. Only href attribute values change;
  // text/assets are untouched, so provenance still holds.
  const php = opts.linkMap ? rewriteInternalLinks(r.php, opts.linkMap) : r.php;
  const body = opts.linkMap ? rewriteInternalLinks(r.body, opts.linkMap) : r.body;

  // The provenance/injection/escaping gate. The reconstruct output is validated
  // against its OWN captured corpus (expectedText ∪ bodyText) — this catches
  // escaping/injection and that emitted copy traces to captured source text.
  const gate = validateArtifacts({
    patterns: [
      {
        slug: patternSlug,
        php,
        spec: {
          interactionModel: 'static',
          expectedText: r.expectedText,
          bodyText: r.bodyText,
          expectedAssets: r.expectedAssets,
        },
      },
    ],
  });

  // Full-width vs constrained DEFERS TO THE SOURCE: a page with a full-bleed
  // section (edge-to-edge hero/media in the source) renders full-width; a page
  // whose content is boxed renders constrained. Chrome sections are excluded.
  const fullWidth = sections.some(
    (s) => s.fullBleed && s.interactionModel !== 'footer' && s.interactionModel !== 'nav',
  );
  // A cover-hero page wires the transparent overlay header; others the solid one
  // (independent of the width decision). The template renders the PAGE's
  // post_content (real editable block page); the theme keeps the pattern as a lib.
  const template = buildPageTemplate(r.heroIsCover, fullWidth);
  const files: ReconstructedFile[] = [
    { path: `patterns/page-${opts.slug}.php`, content: php },
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
    postContent: toPostContent(body, opts.themeSlug),
    gate,
    expectedAssets: r.expectedAssets,
    provenanceFlags: r.provenanceFlags,
    sectionsRendered: r.sectionsRendered,
    iconAssetCount: r.iconAssets.length,
  };
}
