//
// Deterministic theme scaffold
// =============================
// Maps a `design-foundation.json` to a complete-and-activatable WordPress
// block-theme bundle:
//
//   style.css            — Theme Name header + theme metadata
//   theme.json           — settings.color.palette + fontFamilies + layout
//                          + styles.blocks.core/* component overrides
//   functions.php        — basic theme setup, font enqueue, blocks/* loader
//   templates/index.html — homepage shell (header part → post-content → footer part)
//   parts/header.html    — site-title + page-list navigation
//   parts/footer.html    — copyright + site-tagline
//
// Per-archetype templates (page.html, single.html, single-product.html,
// etc.) and patterns are NOT emitted here — they're added later by
// archetype-template ticks invoking the `replicate` skill, which can
// focus on per-archetype layout decisions instead of regenerating the
// whole theme bundle on every tick.
//
// All mappings are deterministic — no agent involvement required. The
// streaming watch loop calls this immediately after a successful
// foundation-rev tick so the running Studio site activates the replica
// theme without waiting on the agent.
//

import type { ReplicaFile } from '../preview/types.js';
import type { ThemeChromeEvidence, ThemeChromeLink } from './source-chrome.js';
import {
  buildFontFaceCss,
  buildThemeFontFamilies,
  matchCapturedFamily,
  consolidateFontFaces,
  type LocalFontFace,
} from './font-capture.js';
import { assertNoInjection } from './validate-artifacts.js';

export interface ThemeScaffoldOpts {
  /** Required — the parsed design-foundation.json. */
  foundation: DesignFoundation;
  /** Theme directory slug. Conventionally `<siteSlug>-replica`. */
  themeSlug: string;
  /** Display name of the theme. Defaults to `themeSlug`. */
  themeName?: string;
  /** WordPress site title — used in style.css `Description` and parts/header.html fallback. */
  siteTitle?: string;
  /** Optional theme description; falls back to a generic line. */
  themeDescription?: string;
  /** Optional source-derived header/footer evidence from captured homepage HTML. */
  sourceChrome?: ThemeChromeEvidence;
  /**
   * Self-hosted fonts captured from the source site's `@font-face` rules and
   * already downloaded into the theme's `assets/fonts/`. When present, the
   * scaffold:
   *   - appends `@font-face` rules (local paths) to style.css,
   *   - adds the captured families to theme.json `settings.typography.fontFamilies`,
   *   - rebinds the body / heading (display) families to the matching captured
   *     family when the foundation's family token matches by name.
   */
  capturedFonts?: LocalFontFace[];
  /**
   * Theme-relative path to a LOCALIZED header logo (e.g. "assets/snooz-logo.png")
   * downloaded from the source CDN into the theme. When set, the header `<img>`
   * references it via `/wp-content/themes/<themeSlug>/<path>` instead of
   * hot-linking the source CDN — offline-durable. Falls back to the captured
   * `sourceChrome.header.logoUrl` (CDN) when absent.
   */
  localLogoPath?: string;
  /**
   * Per-heading line-heights from typography.json (e.g. `{ h1: "1.1", h2: "1.2" }`).
   * Bogus `0` / `0px` values are sanitized to a sensible default before emit.
   */
  headingLineHeights?: Record<string, string>;
  /**
   * Observed heading font stack from typography.json (e.g. "Larsseit, sans-serif").
   * Used to rebind the display family to a captured/self-hosted font even when
   * the design foundation substituted a different family for the headings.
   */
  headingFamily?: string;
  /** Observed body font stack from typography.json (e.g. "quasimoda, sans-serif"). */
  bodyFamily?: string;
  /**
   * Free family name substituted for an UNHOSTABLE body font (e.g. Typekit
   * `quasimoda` → `Hanken Grotesk`). When set, the body family is bound to this
   * (self-hosted) family instead of the bare declared stack. Its `@font-face`
   * faces must already be present in `capturedFonts` (downloaded by the handler).
   */
  bodySubstituteFamily?: string;
  /** Free family substituted for an unhostable DISPLAY font (rare — usually self-hosted). */
  displaySubstituteFamily?: string;
  /**
   * Source-path → local-WP-permalink map, built from redirect-map.json
   * (`{ from: "/pages/about-us", to: "/about-us/" }`). When present, every
   * SAME-SITE primary-nav (and footer) href is rewritten to its local permalink
   * so the menu resolves instead of 404ing on the source path. External links
   * (`link.external`) are left unchanged.
   *
   * A same-site nav href with NO entry in this map points at a page that was
   * not imported — `onUnmappedNavLink` decides what happens ('drop' by default,
   * never a dead local 404).
   */
  navHrefMap?: Record<string, string>;
  /**
   * What to do with a same-site primary-nav link whose target page is NOT in
   * `navHrefMap` (not imported locally):
   *   - 'drop'  (default): omit the link — never emit a dead local 404.
   *   - 'keep': emit the original source path unchanged (last resort).
   */
  onUnmappedNavLink?: 'drop' | 'keep';
  /**
   * Optional out-param. When provided, `buildThemeScaffold` populates it with
   * the count of same-site nav/footer links that were DROPPED during remapping
   * (unmapped target page → not imported). Surfaces a silent menu-loss so the
   * handler can report `droppedNavLinks` instead of the menu just missing items.
   */
  stats?: { droppedNavLinks?: number };
  /**
   * Block-reconstructed pages. Each entry binds a page's WP slug (source-faithful,
   * from `pageSlugFromUrl`) to the theme pattern that holds its reconstructed
   * section blocks (e.g. `{ slug: 'about-us', patternSlug: 'getsnooz-com-replica/page-about-us' }`).
   *
   * For each entry, the scaffold emits `templates/page-<slug>.html` — a slug-specific
   * WP block-theme page template that renders header → the page's reconstructed
   * pattern → footer, INSTEAD of letting the generic `page.html` fall through to
   * raw `wp:post-content` (which would display the source platform's carried
   * Replo/Shopify HTML). This is the same mechanism the homepage uses
   * (`front-page.html` → homepage pattern), generalized to every content page.
   *
   * The pattern FILES themselves (the reconstructed block markup) are produced by
   * the replicate skill's compose/generate step and added to `themeFiles[]`
   * separately; this opt only emits the deterministic template WIRING that points
   * each page at its pattern. When the array is empty/absent, no per-page templates
   * are emitted and pages render via `page.html` (carried-HTML fallback) as before.
   *
   * Set `isHome: true` on the homepage entry to additionally emit `templates/front-page.html`
   * (WP serves it at the site root when the page is the static front page).
   */
  reconstructedPages?: ReconstructedPage[];
}

/** A block-reconstructed page: its WP slug + the pattern holding its section blocks. */
export interface ReconstructedPage {
  /** Source-faithful WP page slug (last path segment), e.g. `about-us`. */
  slug: string;
  /** Fully-qualified theme pattern slug, e.g. `getsnooz-com-replica/page-about-us`. */
  patternSlug: string;
  /** When true, also emit `templates/front-page.html` (homepage / static front page). */
  isHome?: boolean;
}

/** Extremely loose type — mirrors what design-foundation.json actually contains. */
interface FoundationRoleValue {
  value?: string | null;
}
interface DesignFoundation {
  color?: {
    surface?: { base?: FoundationRoleValue; raised?: FoundationRoleValue; inverse?: FoundationRoleValue };
    text?: { default?: FoundationRoleValue; muted?: FoundationRoleValue; subtle?: FoundationRoleValue; inverse?: FoundationRoleValue };
    accent?: {
      primary?: FoundationRoleValue;
      primaryAlt?: FoundationRoleValue;
      warning?: FoundationRoleValue;
      warm?: FoundationRoleValue;
      highlight?: FoundationRoleValue;
    };
    border?: { default?: FoundationRoleValue; subtle?: FoundationRoleValue };
  };
  typography?: {
    families?: {
      body?: FoundationRoleValue;
      display?: FoundationRoleValue;
      mono?: FoundationRoleValue;
    };
    scale?: Record<string, unknown>;
    weights?: Record<string, unknown>;
  };
  breakpoints?: {
    sm?: string;
    md?: string;
    lg?: string;
    xl?: string;
  };
  radius?: { sm?: string; base?: string; lg?: string };
  spacing?: { sections?: { padX?: string; padY?: string; contentMaxWidth?: string } };
  components?: {
    button?: { background?: string; text?: string; radius?: string; padding?: string; fontWeight?: number | string };
  };
}

/** Build the in-memory ReplicaFile[] for a complete activatable bundle. */
export function buildThemeScaffold(opts: ThemeScaffoldOpts): ReplicaFile[] {
  const { foundation, themeSlug } = opts;
  const themeName = opts.themeName ?? themeSlug;
  const themeDescription =
    opts.themeDescription ?? `Replica theme generated by data-liberation. Tokens derived from ${opts.siteTitle ?? 'the source site'}.`;

  // Collapse weight/style variants that foundries declare as separate family
  // names (e.g. "Larsseit", "Larsseit Bold", "Larsseit-Bold") into one family.
  const capturedFonts = consolidateFontFaces(opts.capturedFonts ?? []);

  // Rewrite captured source nav/footer hrefs to local WP permalinks using the
  // redirect map. Same-site links resolve to `/slug/`; external links and
  // already-local links pass through; unmapped same-site links are dropped
  // (default) so the menu never points at an uncaptured 404.
  const remap = makeNavHrefRemapper(opts.navHrefMap, opts.onUnmappedNavLink ?? 'drop');
  let droppedNavLinks = 0;
  let remappedHeader = opts.sourceChrome?.header;
  if (opts.sourceChrome?.header) {
    const r = remapLinks(opts.sourceChrome.header.links, remap);
    droppedNavLinks += r.dropped;
    remappedHeader = { ...opts.sourceChrome.header, links: r.links };
  }
  let remappedFooter = opts.sourceChrome?.footer;
  if (opts.sourceChrome?.footer) {
    const r = remapLinks(opts.sourceChrome.footer.links, remap);
    droppedNavLinks += r.dropped;
    remappedFooter = { ...opts.sourceChrome.footer, links: r.links };
  }
  if (opts.stats) opts.stats.droppedNavLinks = droppedNavLinks;

  // Header/footer parts carry source-derived nav labels + hrefs (attacker-
  // controlled) and are written to disk WITHOUT going through validateArtifacts.
  // Gate them through the SAME injection scan so a malicious nav label/href
  // gets the `<script>`/`on*=`/`<?php` protection the pattern validator applies.
  const headerHtml = buildHeaderPart({
    themeSlug,
    chrome: remappedHeader,
    localLogoUrl: opts.localLogoPath ? `/wp-content/themes/${themeSlug}/${opts.localLogoPath.replace(/^\/+/, '')}` : undefined,
  });
  assertNoInjection(headerHtml, 'parts/header.html');
  const footerHtml = buildFooterPart({ siteTitle: opts.siteTitle ?? themeName, chrome: remappedFooter });
  assertNoInjection(footerHtml, 'parts/footer.html');

  // Per-page templates wiring each block-reconstructed page to its pattern. The
  // homepage proved this path (front-page.html → homepage pattern); we generalize
  // it to every content page so they render reconstructed section blocks instead
  // of falling through page.html to raw carried `wp:post-content`.
  const pageTemplates = buildReconstructedPageTemplates(opts.reconstructedPages ?? []);

  return [
    { relativePath: 'style.css', content: buildStyleCss({ themeName, themeSlug, themeDescription, capturedFonts }) },
    { relativePath: 'theme.json', content: buildThemeJson(foundation, { capturedFonts, headingLineHeights: opts.headingLineHeights, headingFamily: opts.headingFamily, bodyFamily: opts.bodyFamily, bodySubstituteFamily: opts.bodySubstituteFamily, displaySubstituteFamily: opts.displaySubstituteFamily }) },
    { relativePath: 'functions.php', content: buildFunctionsPhp({ themeSlug }) },
    { relativePath: 'templates/index.html', content: buildIndexTemplate() },
    { relativePath: 'parts/header.html', content: headerHtml },
    { relativePath: 'parts/footer.html', content: footerHtml },
    // Header utility-icon SVG assets (shipped as files; referenced via core/image
    // in the header — wp:html is banned, so glyphs can't be inlined).
    ...buildHeaderIconAssets(),
    ...pageTemplates,
  ];
}

// -- per-page reconstructed templates -----------------------------------------

/**
 * WP slug guard for `templates/page-<slug>.html` filenames and pattern-slug
 * references. WP page slugs are already `sanitize_title`-shaped (lowercase,
 * hyphen-joined, ASCII), but defend against a malformed slug reaching a file
 * path or block-comment attribute.
 */
function isSafeWpSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/**
 * Emit per-page block-theme templates for each reconstructed page. Each template
 * renders header part → the page's reconstructed pattern → footer part, replacing
 * the generic `page.html` → `wp:post-content` carried-HTML fallback for that slug.
 * The homepage entry (`isHome`) additionally emits `front-page.html`.
 *
 * Malformed slugs / pattern slugs are skipped (never written to a file path or a
 * block attribute) rather than emitted unsafely.
 */
function buildReconstructedPageTemplates(pages: ReconstructedPage[]): ReplicaFile[] {
  const files: ReplicaFile[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const slug = (page.slug ?? '').trim();
    const patternSlug = (page.patternSlug ?? '').trim();
    if (!isSafeWpSlug(slug)) continue;
    // Pattern slug is `namespace/name`; both segments must be slug-safe.
    const parts = patternSlug.split('/');
    if (parts.length !== 2 || !isSafeWpSlug(parts[0]) || !isSafeWpSlug(parts[1])) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const content = buildPageTemplate(patternSlug);
    files.push({ relativePath: `templates/page-${slug}.html`, content });
    if (page.isHome) {
      files.push({ relativePath: 'templates/front-page.html', content });
    }
  }
  return files;
}

/** A single page-template shell: header part → reconstructed pattern → footer part. */
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

// -- style.css ---------------------------------------------------------------

function buildStyleCss(args: { themeName: string; themeSlug: string; themeDescription: string; capturedFonts?: LocalFontFace[] }): string {
  // Self-hosted source fonts (captured @font-face rules → local assets/fonts/).
  const fontFaceCss = buildFontFaceCss(args.capturedFonts ?? []);
  // Standard WordPress theme header; required keys: Theme Name, Version, Text Domain.
  return `/*
Theme Name: ${args.themeName}
Theme URI: https://github.com/Automattic/data-liberation-agent
Author: data-liberation
Description: ${args.themeDescription}
Version: 0.1.0
Requires at least: 6.5
Tested up to: 6.5
Requires PHP: 8.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html
Text Domain: ${args.themeSlug}
Tags: block-theme, full-site-editing
*/

/*
 * Responsive-content guard. Imported page/post content (carried from the
 * source platform — Shopify/Replo, Wix, Squarespace, etc.) frequently ships its
 * OWN inline <style> with high-specificity rules that pin media to fixed pixel
 * widths (e.g. Replo's .r-* classes sizing <picture>/<img> at 820px). Those
 * overflow the viewport on mobile and break the 390px responsiveness gate.
 *
 * We clamp replaced/embedded content to the container width. !important is
 * required to win against the carried inline stylesheet's specificity — this is
 * lossless (the asset just scales down to fit) and does not change desktop
 * layout, where the container is already wider than the media.
 */
.wp-block-post-content img,
.wp-block-post-content picture,
.wp-block-post-content picture img,
.wp-block-post-content video,
.wp-block-post-content iframe,
.wp-block-post-content embed,
.wp-block-post-content object,
.wp-block-post-content svg,
.wp-block-post-content table,
.entry-content img,
.entry-content picture,
.entry-content picture img,
.entry-content video,
.entry-content iframe,
.entry-content embed,
.entry-content object,
.entry-content svg,
.entry-content table {
	max-width: 100% !important;
	height: auto !important;
}

.wp-block-post-content picture,
.entry-content picture {
	display: block !important;
}

/* Final-resort clamp: the imported content tree must never establish a
 * scroll-width wider than the viewport on small screens. Applied only to the
 * migrated content container so it can't affect the reconstructed theme
 * layout (header/footer/patterns). */
@media (max-width: 781px) {
	.wp-block-post-content,
	.entry-content {
		overflow-x: clip;
	}
}
${fontFaceCss}`;
}

// -- theme.json --------------------------------------------------------------

interface ThemeJsonOpts {
  capturedFonts?: LocalFontFace[];
  headingLineHeights?: Record<string, string>;
  headingFamily?: string;
  bodyFamily?: string;
  bodySubstituteFamily?: string;
  displaySubstituteFamily?: string;
}

function buildThemeJson(f: DesignFoundation, opts: ThemeJsonOpts = {}): string {
  const captured = opts.capturedFonts ?? [];
  const palette = buildPalette(f);
  const fontFamilies = buildFontFamilies(f, captured, {
    headingFamily: opts.headingFamily,
    bodyFamily: opts.bodyFamily,
    bodySubstituteFamily: opts.bodySubstituteFamily,
    displaySubstituteFamily: opts.displaySubstituteFamily,
  });
  const breakpoints = buildBreakpoints(f);
  const blockOverrides = buildBlockOverrides(f);
  const elements = buildElementStyles(f, fontFamilies, opts.headingLineHeights);

  const themeJson: Record<string, unknown> = {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings: {
      appearanceTools: true,
      color: {
        custom: false,
        defaultPalette: false,
        palette,
      },
      typography: {
        customFontSize: false,
        defaultFontSizes: false,
        fluid: true,
        fontFamilies,
      },
      layout: breakpoints,
      spacing: {
        units: ['px', 'em', 'rem', '%', 'vh', 'vw'],
      },
    },
    styles: {
      color: {
        background: 'var(--wp--preset--color--surface-base)',
        text: 'var(--wp--preset--color--text-default)',
      },
      typography: fontFamilies.length > 0
        ? { fontFamily: `var(--wp--preset--font-family--${bodyFamilySlug(fontFamilies)})` }
        : undefined,
      elements,
      blocks: blockOverrides,
    },
  };

  return JSON.stringify(themeJson, null, 2) + '\n';
}

interface PaletteEntry { name: string; slug: string; color: string }

function buildPalette(f: DesignFoundation): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const push = (slug: string, name: string, hex: string | null | undefined): void => {
    if (typeof hex === 'string' && hex.trim()) {
      out.push({ name, slug, color: hex.trim() });
    }
  };
  push('surface-base', 'Surface — base', f.color?.surface?.base?.value);
  push('surface-raised', 'Surface — raised', f.color?.surface?.raised?.value);
  push('surface-inverse', 'Surface — inverse', f.color?.surface?.inverse?.value);
  push('text-default', 'Text — default', f.color?.text?.default?.value);
  push('text-muted', 'Text — muted', f.color?.text?.muted?.value);
  push('text-subtle', 'Text — subtle', f.color?.text?.subtle?.value);
  push('text-inverse', 'Text — inverse', f.color?.text?.inverse?.value);
  push('accent-primary', 'Accent — primary', f.color?.accent?.primary?.value);
  push('accent-primary-alt', 'Accent — primary alt', f.color?.accent?.primaryAlt?.value);
  push('accent-warning', 'Accent — warning', f.color?.accent?.warning?.value);
  push('accent-warm', 'Accent — warm', f.color?.accent?.warm?.value);
  push('accent-highlight', 'Accent — highlight', f.color?.accent?.highlight?.value);
  push('border-default', 'Border — default', f.color?.border?.default?.value);
  push('border-subtle', 'Border — subtle', f.color?.border?.subtle?.value);
  return out;
}

interface FontFamilyEntry {
  fontFamily: string;
  name: string;
  slug: string;
  fontFace?: Array<{ fontFamily: string; fontWeight: string; fontStyle: string; src: string[] }>;
}

/**
 * Build theme.json fontFamilies, merging in self-hosted captured fonts.
 *
 * When the foundation's body/display family token matches a captured family by
 * name (e.g. foundation display "Larsseit, sans-serif" matches the captured
 * "Larsseit" face), the entry is REBOUND to the captured family — including its
 * `fontFace[]` so the real woff renders — instead of the (possibly substituted)
 * foundation value. This is how a substituted "Poppins" gets corrected back to
 * the genuine self-hosted "Larsseit".
 */
function buildFontFamilies(
  f: DesignFoundation,
  capturedFonts: LocalFontFace[] = [],
  hints: { headingFamily?: string; bodyFamily?: string; bodySubstituteFamily?: string; displaySubstituteFamily?: string } = {},
): FontFamilyEntry[] {
  const fams = f.typography?.families ?? {};
  const out: FontFamilyEntry[] = [];
  const capturedEntries = buildThemeFontFamilies(capturedFonts);
  const capturedBySlug = new Map(capturedEntries.map((e) => [e.slug, e]));

  // ── Body (primary) ────────────────────────────────────────────────────────
  // Priority: (1) a self-hosted FREE substitute for an unhostable body font
  // (e.g. Typekit quasimoda → Hanken Grotesk — its faces are in capturedFonts),
  // (2) a captured family matching the foundation body token, (3) the observed
  // body stack hint. A substitute beats the bare declared stack so body copy
  // renders in a real web font instead of a CSS-generic fallback.
  const body = fams.body?.value;
  const bodySubMatch = matchCapturedFamily(hints.bodySubstituteFamily, capturedFonts);
  const bodyMatch =
    bodySubMatch ??
    matchCapturedFamily(typeof body === 'string' ? body : null, capturedFonts) ??
    matchCapturedFamily(hints.bodyFamily, capturedFonts);
  if (bodyMatch) {
    const e = capturedBySlug.get(slugify(bodyMatch));
    if (e) out.push({ ...e, slug: 'body', name: 'Body' });
  }
  if (out.length === 0) {
    out.push({
      fontFamily: typeof body === 'string' && body.trim()
        ? body
        : 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
      name: 'Body',
      slug: 'body',
    });
  }

  // ── Display (headings) ──────────────────────────────────────────────────────
  // Prefer a captured family that matches the display token OR the observed
  // heading stack hint; this corrects a SUBSTITUTED family (e.g. foundation
  // picked Poppins as an "open substitute for Larsseit") back to the real
  // self-hosted typeface when it's available.
  const display = fams.display?.value;
  const displayMatch =
    matchCapturedFamily(hints.headingFamily, capturedFonts) ??
    matchCapturedFamily(typeof display === 'string' ? display : null, capturedFonts) ??
    matchCapturedFamily(hints.displaySubstituteFamily, capturedFonts);
  if (displayMatch) {
    const e = capturedBySlug.get(slugify(displayMatch));
    if (e) out.push({ ...e, slug: 'display', name: 'Display' });
  } else if (typeof display === 'string' && display.trim() && display !== 'serif') {
    out.push({ fontFamily: display, name: 'Display', slug: 'display' });
  }

  const mono = fams.mono?.value;
  if (typeof mono === 'string' && mono.trim() && mono.toLowerCase() !== 'monospace') {
    out.push({ fontFamily: mono, name: 'Mono', slug: 'mono' });
  }

  // ── Any captured families not yet bound to body/display ─────────────────────
  // Register them too so their @font-face resolves and patterns can reference
  // them by slug. Skip families whose fontFamily stack is ALREADY represented
  // by a body/display entry (e.g. display was rebound to the captured Larsseit —
  // don't also emit a duplicate `larsseit` family for the same font).
  const boundSlugs = new Set(out.flatMap((e) => [e.slug, slugify(e.name)]));
  const boundFamilies = new Set(out.map((e) => e.fontFamily.toLowerCase()));
  for (const e of capturedEntries) {
    if (boundFamilies.has(e.fontFamily.toLowerCase())) continue;
    if (!boundSlugs.has(e.slug)) {
      out.push(e);
      boundSlugs.add(e.slug);
    }
  }

  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Slug of the body family entry (first entry conventionally has slug "body"). */
function bodyFamilySlug(fams: FontFamilyEntry[]): string {
  const body = fams.find((e) => e.slug === 'body');
  return body?.slug ?? fams[0].slug;
}

const DEFAULT_HEADING_LINE_HEIGHT = '1.2';

/**
 * Build `styles.elements` for headings: bind h1–h6 to the display family (when
 * one exists) and apply sanitized line-heights. A captured `0` / `0px`
 * line-height is bogus (headless capture artifact) and is replaced by a
 * sensible default so headings don't collapse.
 */
function buildElementStyles(
  f: DesignFoundation,
  fontFamilies: FontFamilyEntry[],
  headingLineHeights: Record<string, string> = {},
): Record<string, unknown> | undefined {
  const display = fontFamilies.find((e) => e.slug === 'display');
  if (!display) return undefined;

  const displayVar = `var(--wp--preset--font-family--${display.slug})`;
  const elements: Record<string, unknown> = {};
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const lh = sanitizeLineHeight(headingLineHeights[tag]);
    elements[tag] = {
      typography: {
        fontFamily: displayVar,
        lineHeight: lh,
      },
    };
  }
  return elements;
}

/**
 * Sanitize a captured line-height. `0`, `0px`, empty, `normal`, and unparseable
 * values fall back to a sensible default. Numeric px values are converted to a
 * unitless ratio when a font-size is unknown is not needed here — px values are
 * passed through (still valid), only the bogus zero is corrected.
 */
function sanitizeLineHeight(raw: string | undefined): string {
  if (!raw) return DEFAULT_HEADING_LINE_HEIGHT;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'normal') return DEFAULT_HEADING_LINE_HEIGHT;
  const num = parseFloat(v);
  if (!Number.isFinite(num) || num === 0) return DEFAULT_HEADING_LINE_HEIGHT;
  return raw.trim();
}

function buildBreakpoints(f: DesignFoundation): { contentSize: string; wideSize: string } {
  const lg = f.breakpoints?.lg ?? '900px';
  // No `xl` in the foundation → derive a reasonable wide size from sections.contentMaxWidth.
  const xl = f.breakpoints?.xl ?? f.spacing?.sections?.contentMaxWidth ?? '1280px';
  return { contentSize: lg, wideSize: xl };
}

interface BlockOverride { color?: { background?: string; text?: string }; spacing?: { padding?: { top?: string; right?: string; bottom?: string; left?: string } }; border?: { radius?: string } }

function buildBlockOverrides(f: DesignFoundation): Record<string, BlockOverride> {
  const blocks: Record<string, BlockOverride> = {};
  const btn = f.components?.button;
  if (btn) {
    const radius = lookupTokenValue(btn.radius, f) ?? '8px';
    blocks['core/button'] = {
      color: {
        background: 'var(--wp--preset--color--accent-primary)',
        text: 'var(--wp--preset--color--text-inverse)',
      },
      border: { radius },
    };
  }
  return blocks;
}

/**
 * Resolve a foundation token reference like `radius.lg` or
 * `color.accent.primary` to the actual literal value. When the reference
 * doesn't resolve, returns null and the caller falls back to a sensible
 * default.
 */
function lookupTokenValue(ref: unknown, f: DesignFoundation): string | null {
  if (typeof ref !== 'string' || !ref.includes('.')) return null;
  const parts = ref.split('.');
  let cursor: unknown = f as unknown as Record<string, unknown>;
  for (const part of parts) {
    if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  if (typeof cursor === 'string') return cursor;
  if (cursor && typeof cursor === 'object' && 'value' in (cursor as Record<string, unknown>)) {
    const inner = (cursor as Record<string, unknown>).value;
    if (typeof inner === 'string') return inner;
  }
  return null;
}

// -- functions.php -----------------------------------------------------------

function buildFunctionsPhp(args: { themeSlug: string }): string {
  // Theme setup hook + register custom block types from blocks/*/build.
  // Font families live in theme.json's settings.typography.fontFamilies — no
  // wp_enqueue_style needed for system fonts. Custom hosted fonts get added
  // by the agent in a follow-up theme.json edit.
  return `<?php
/**
 * ${args.themeSlug} — replica theme functions.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!function_exists('${slugToPhp(args.themeSlug)}_setup')) {
    function ${slugToPhp(args.themeSlug)}_setup() {
        add_theme_support('automatic-feed-links');
        add_theme_support('title-tag');
        add_theme_support('post-thumbnails');
        add_theme_support('html5', array(
            'search-form',
            'comment-form',
            'comment-list',
            'gallery',
            'caption',
            'style',
            'script',
        ));
        add_theme_support('responsive-embeds');
        add_theme_support('editor-styles');
        add_theme_support('wp-block-styles');
    }
}
add_action('after_setup_theme', '${slugToPhp(args.themeSlug)}_setup');

/**
 * Enqueue the theme stylesheet on the front end. Block themes do NOT load the
 * root style.css automatically (unlike classic themes — for block themes
 * style.css is only the theme header), so any rules it carries (e.g. the
 * responsive-content guard that clamps imported media on mobile) are dead
 * unless explicitly enqueued. Versioned by file mtime for cache-busting.
 */
add_action('wp_enqueue_scripts', function () {
    $style_path = get_stylesheet_directory() . '/style.css';
    $version = file_exists($style_path) ? (string) filemtime($style_path) : '0.1.0';
    wp_enqueue_style(
        '${args.themeSlug}-style',
        get_stylesheet_uri(),
        array(),
        $version
    );
});

/**
 * Register theme-embedded custom blocks. Each block lives at
 * blocks/<slug>/{src,build}/. The agent emits pre-built artifacts in
 * build/ since the streaming flow has no wp-scripts step. Skipped
 * silently when the directory is empty.
 */
add_action('init', function () {
    foreach ((array) glob(get_theme_file_path('blocks/*/build')) as $build_dir) {
        if ($build_dir && file_exists(trailingslashit($build_dir) . 'block.json')) {
            register_block_type($build_dir);
        }
    }
});
`;
}

function slugToPhp(slug: string): string {
  return slug.replace(/-/g, '_');
}

// -- templates/index.html ----------------------------------------------------

function buildIndexTemplate(): string {
  // Minimal homepage shell: header part → post-content → footer part. The
  // archetype-template tick can replace this with a richer composition once
  // the homepage has been observed.
  return `<!-- wp:template-part {"slug":"header","tagName":"header"} /-->

<!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
<main class="wp-block-group">
<!-- wp:post-content {"layout":{"type":"constrained"}} /-->
</main>
<!-- /wp:group -->

<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->
`;
}

// -- parts/header.html -------------------------------------------------------

function buildHeaderPart(args: { themeSlug?: string; chrome?: NonNullable<ThemeChromeEvidence['header']>; localLogoUrl?: string } = {}): string {
  const links = args.chrome?.links ?? [];
  // Prefer a localized (theme-asset) logo over the hot-linked source CDN URL so
  // the header is offline-durable.
  const logoUrl = args.localLogoUrl ?? args.chrome?.logoUrl;
  if (links.length === 0 && !logoUrl) {
    return buildGenericHeaderPart();
  }

  // Light vs dark header treatment from the captured source header tone.
  // Default 'light' (white header + dark text) — the common storefront case
  // and a faithful match when the source header is white.
  const dark = args.chrome?.tone === 'dark';
  const bgSlug = dark ? 'surface-inverse' : 'surface-base';
  const textSlug = dark ? 'text-inverse' : 'text-default';
  const bgClass = dark ? 'has-surface-inverse-background-color' : 'has-surface-base-background-color';
  const textClass = dark ? 'has-text-inverse-color' : 'has-text-default-color';

  const brand = logoUrl
    ? `<!-- wp:image ${jsonAttr({ url: logoUrl, alt: args.chrome?.logoAlt ?? 'Site logo', width: 150, linkDestination: 'custom', href: '/' })} -->
<figure class="wp-block-image is-resized"><a href="/"><img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(args.chrome?.logoAlt ?? 'Site logo')}" style="width:150px"/></a></figure>
<!-- /wp:image -->`
    : `<!-- wp:site-title {"isLink":true,"textColor":"${textSlug}","style":{"typography":{"fontWeight":"700","textTransform":"uppercase"}}} /-->`;

  const navigation = links.length > 0
    ? links.map((link) => buildNavigationLink(link)).join('\n')
    : '<!-- wp:page-list /-->';

  // Header utility-icon cluster (search / account / cart). The source-chrome
  // extractor intentionally drops these affordances from the PRIMARY nav, but
  // a faithful storefront header still shows them on the right. `wp:html` is
  // banned project-wide, so each glyph is shipped as a theme SVG asset
  // (assets/icon-*.svg) and referenced from a `core/image` link — self-contained
  // and offline-durable.
  const icons = buildHeaderIcons({ themeSlug: args.themeSlug });

  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"18px","bottom":"18px","left":"var(--wp--preset--spacing--40)","right":"var(--wp--preset--spacing--40)"}}},"backgroundColor":"${bgSlug}","textColor":"${textSlug}"} -->
<div class="wp-block-group alignfull ${textClass} ${bgClass} has-text-color has-background" style="padding-top:18px;padding-right:var(--wp--preset--spacing--40);padding-bottom:18px;padding-left:var(--wp--preset--spacing--40)">
<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"nowrap"}} -->
<div class="wp-block-group">
${brand}

<!-- wp:group {"layout":{"type":"flex","justifyContent":"right","flexWrap":"nowrap","verticalAlignment":"center"},"style":{"spacing":{"blockGap":"var:preset|spacing|40"}}} -->
<div class="wp-block-group">
<!-- wp:navigation {"textColor":"${textSlug}","overlayMenu":"mobile","layout":{"type":"flex","justifyContent":"right","orientation":"horizontal"},"style":{"typography":{"fontSize":"14px","fontWeight":"700","textTransform":"uppercase"}}} -->
${navigation}
<!-- /wp:navigation -->

${icons}
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
`;
}

/**
 * Stroke SVG glyphs for the header utility icons. `stroke="currentColor"` (not
 * inline-styled) lets the rendered <img> show the navy line art; sized 22px.
 * Shipped as standalone theme assets (see buildHeaderIconAssets) because
 * `wp:html` is banned — they're referenced from `core/image` blocks.
 */
const HEADER_ICON_SVGS: Record<string, string> = {
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2f394e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Search"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  account: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2f394e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Account"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  cart: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2f394e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Cart"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
};

/** Theme ReplicaFiles for the header icon SVG assets. */
function buildHeaderIconAssets(): ReplicaFile[] {
  return Object.entries(HEADER_ICON_SVGS).map(([name, svg]) => ({
    relativePath: `assets/icon-${name}.svg`,
    content: svg,
  }));
}

/**
 * Build the header's search / account / cart icon cluster as `core/image` links
 * referencing the shipped SVG assets (no `wp:html`). search → /?s= ,
 * account → /account, cart → /cart (Woo-compatible paths). Offline-durable.
 */
function buildHeaderIcons(args: { themeSlug?: string }): string {
  const slug = args.themeSlug ?? 'replica';
  const asset = (name: string): string => `/wp-content/themes/${slug}/assets/icon-${name}.svg`;

  const link = (name: string, href: string, label: string): string =>
    `<!-- wp:image {"width":"22px","height":"22px","sizeSlug":"full","linkDestination":"custom","className":"clone-header-icon"} -->
<figure class="wp-block-image size-full is-resized clone-header-icon"><a href="${href}"><img src="${asset(name)}" alt="${label}" style="width:22px;height:22px"/></a></figure>
<!-- /wp:image -->`;

  return `<!-- wp:group {"className":"clone-header-icons","layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"center"},"style":{"spacing":{"blockGap":"16px"}}} -->
<div class="wp-block-group clone-header-icons">
${link('search', '/?s=', 'Search')}
${link('account', '/account', 'Account')}
${link('cart', '/cart', 'Cart')}
</div>
<!-- /wp:group -->`;
}

function buildGenericHeaderPart(): string {
  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"var(--wp--preset--spacing--40)","bottom":"var(--wp--preset--spacing--40)","left":"var(--wp--preset--spacing--40)","right":"var(--wp--preset--spacing--40)"}}},"backgroundColor":"surface-base"} -->
<div class="wp-block-group alignfull has-surface-base-background-color has-background" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"nowrap"}} -->
<div class="wp-block-group">
<!-- wp:site-title {"isLink":true,"style":{"typography":{"fontWeight":"600"}}} /-->

<!-- wp:navigation {"overlayMenu":"mobile","layout":{"type":"flex","justifyContent":"right","orientation":"horizontal"}} -->
<!-- wp:page-list /-->
<!-- /wp:navigation -->
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
`;
}

// -- parts/footer.html -------------------------------------------------------

function buildFooterPart(args: { siteTitle: string; chrome?: NonNullable<ThemeChromeEvidence['footer']> }): string {
  const text = args.chrome?.text ?? [];
  const links = args.chrome?.links ?? [];
  if (text.length === 0 && links.length === 0) {
    return buildGenericFooterPart({ siteTitle: args.siteTitle });
  }

  const textBlocks = text.slice(0, 5).map((chunk) => `<!-- wp:paragraph -->
<p>${escapeHtml(chunk)}</p>
<!-- /wp:paragraph -->`).join('\n\n');
  const navigationItems = links.slice(0, 10).map((link) => buildNavigationLink(link)).join('\n');

  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"var(--wp--preset--spacing--60)","bottom":"var(--wp--preset--spacing--60)","left":"var(--wp--preset--spacing--40)","right":"var(--wp--preset--spacing--40)"}}},"backgroundColor":"surface-inverse","textColor":"text-inverse"} -->
<div class="wp-block-group alignfull has-text-inverse-color has-surface-inverse-background-color has-text-color has-background" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--40)">
<!-- wp:columns {"verticalAlignment":"top"} -->
<div class="wp-block-columns are-vertically-aligned-top">
<!-- wp:column {"verticalAlignment":"top","width":"60%"} -->
<div class="wp-block-column is-vertically-aligned-top" style="flex-basis:60%">
${textBlocks || '<!-- wp:site-title {"isLink":true} /-->'}
</div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"top","width":"40%"} -->
<div class="wp-block-column is-vertically-aligned-top" style="flex-basis:40%">
${navigationItems ? `<!-- wp:navigation {"overlayMenu":"never","layout":{"type":"flex","orientation":"vertical","justifyContent":"left"},"style":{"spacing":{"blockGap":"10px"}}} -->
${navigationItems}
<!-- /wp:navigation -->` : ''}
</div>
<!-- /wp:column -->
</div>
<!-- /wp:columns -->
</div>
<!-- /wp:group -->
`;
}

function buildGenericFooterPart(args: { siteTitle: string }): string {
  return `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"var(--wp--preset--spacing--60)","bottom":"var(--wp--preset--spacing--60)","left":"var(--wp--preset--spacing--40)","right":"var(--wp--preset--spacing--40)"}}},"backgroundColor":"surface-inverse","textColor":"text-inverse"} -->
<div class="wp-block-group alignfull has-text-inverse-color has-surface-inverse-background-color has-text-color has-background" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--40)">
<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","flexWrap":"wrap"}} -->
<div class="wp-block-group">
<!-- wp:site-title {"isLink":true} /-->

<!-- wp:paragraph -->
<p>&copy; ${new Date().getFullYear()} ${escapeHtml(args.siteTitle)}. All rights reserved.</p>
<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
</div>
<!-- /wp:group -->
`;
}

// -- nav href remapping (source path → local WP permalink) -------------------

type NavHrefRemap = (link: ThemeChromeLink) => ThemeChromeLink | null;

/**
 * Build a remapper that rewrites a captured nav/footer link's href to its
 * local WP permalink using the redirect map.
 *
 *   - External link (`link.external`) → unchanged.
 *   - Same-site href found in the map (by normalized source path) → rewritten
 *     to the local permalink (e.g. `/pages/about-us` → `/about-us/`).
 *   - Same-site href already pointing at a local permalink (already a `to`
 *     value, or root `/`) → unchanged.
 *   - Same-site href NOT in the map → `unmapped` policy: `drop` returns null
 *     (link omitted) or `keep` returns it unchanged.
 *
 * When no map is supplied at all, every link passes through unchanged
 * (back-compat with callers that don't thread a redirect map).
 */
function makeNavHrefRemapper(
  navHrefMap: Record<string, string> | undefined,
  unmapped: 'drop' | 'keep',
): NavHrefRemap {
  if (!navHrefMap) return (link) => link;

  // Index by normalized source path (no trailing slash, no query/hash) AND by
  // local-permalink target, so an already-local href is recognized as mapped.
  const bySource = new Map<string, string>();
  const localTargets = new Set<string>();
  for (const [from, to] of Object.entries(navHrefMap)) {
    bySource.set(normalizePath(from), to);
    localTargets.add(normalizePath(to));
  }

  return (link) => {
    if (link.external) return link;
    // Only rewrite same-site, path-style hrefs. Anchors / mailto / tel pass
    // through unchanged (they aren't local page navigations).
    const href = link.href;
    if (!href.startsWith('/')) return link;

    const key = normalizePath(href);
    if (key === '' ) return link; // root → home, leave as "/"
    const mapped = bySource.get(key);
    if (mapped) return { ...link, href: mapped };
    // Already a local permalink (matches a redirect target)?
    if (localTargets.has(key)) return link;
    // Same-site link whose target page was not imported.
    return unmapped === 'keep' ? link : null;
  };
}

/** Apply a remapper to a link list, dropping nulls. Returns kept links + drop count. */
function remapLinks(links: ThemeChromeLink[], remap: NavHrefRemap): { links: ThemeChromeLink[]; dropped: number } {
  const out: ThemeChromeLink[] = [];
  let dropped = 0;
  for (const link of links) {
    const r = remap(link);
    if (r) out.push(r);
    else dropped++;
  }
  return { links: out, dropped };
}

/** Normalize a path-style href to a bare path: strip query/hash + trailing slash. */
function normalizePath(href: string): string {
  let p = href;
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  return p.replace(/\/+$/, '');
}

/**
 * Allow only navigation hrefs whose scheme is safe to render. Source nav hrefs
 * are attacker-controlled, so a `javascript:`/`data:`/`vbscript:` href must
 * never reach the emitted markup. Relative paths, anchors, query-only,
 * `http(s):`, `mailto:`, and `tel:` are allowed; anything else is dropped to
 * `#` so the link is inert rather than an injection vector.
 */
export function safeNavHref(href: string): string {
  const h = (href ?? '').trim();
  if (h === '') return '#';
  // Relative / root-relative / anchor / query — no scheme, safe.
  if (h.startsWith('/') || h.startsWith('#') || h.startsWith('?')) return h;
  // A scheme is present only when a colon precedes the first slash/?/#.
  const schemeMatch = h.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) {
    // No scheme and not root-relative → treat as a relative path (safe).
    return h;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
    return h;
  }
  // javascript:, data:, vbscript:, file:, etc. — drop to an inert anchor.
  return '#';
}

function buildNavigationLink(link: ThemeChromeLink): string {
  const safeHref = safeNavHref(link.href);
  return `<!-- wp:navigation-link ${jsonAttr({
    // Escape the source-derived label so a `Shop --><script>` label can't break
    // out of the block-comment / inject markup. jsonAttr is JSON-only (not
    // HTML-escaped), so the escape must happen here.
    label: escapeHtml(link.label),
    url: safeHref,
    kind: 'custom',
    isTopLevelLink: true,
    opensInNewTab: link.external || undefined,
  })} /-->`;
}

function jsonAttr(input: Record<string, unknown>): string {
  const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return JSON.stringify(cleaned);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}
