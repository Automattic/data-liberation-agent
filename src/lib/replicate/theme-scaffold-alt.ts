//
// Alt theme scaffold (carry-and-scope path)
// ==========================================
// Emits the minimal file set for a WordPress block theme whose sole job is
// to stay out of the way and let carried source HTML + scoped source CSS
// render faithfully.
//
// Intentionally minimal — no patterns, no archetypes beyond header/footer
// parts and per-page templates.  No agent involvement required; pure
// deterministic mapping of AltThemeInput → ThemeFile[].
//
// Body-class scoping strategy:
//   - `lib-alt-site` — applied site-wide via body_class filter
//   - `lib-alt-page-<slug>` — applied per page via body_class filter
//
// CSS loading strategy:
//   - assets/css/site.css — enqueued globally
//   - assets/css/page-<slug>.css — enqueued conditionally via wp_enqueue_scripts
//

import type { AltScaffold } from './page-reconstruct-alt.js';

export interface AltPage {
  /** URL-safe slug (kebab-case, produced by slugify — no quotes or special chars). */
  slug: string;
  /** True for the site front page — maps template to front-page.html and uses is_front_page(). */
  isHome?: boolean;
  /**
   * Which distinct chrome variant ([[ChromeVariant.key]]) this page renders. Pages
   * with identical header+footer DOM share a key (and thus one part pair), so a
   * site with a transparent-overlay home header and a solid interior header emits
   * exactly two header parts, not one-per-page.
   */
  chromeKey: string;
  /**
   * WP object type the slug resolves to. `'post'` scopes via `is_single()` and
   * renders through a shared `single.html` (posts share one template); anything
   * else (default `'page'`) scopes via `is_page()` and gets its own
   * `page-<slug>.html`. Front page (`isHome`) ignores this and uses
   * `is_front_page()` + `front-page.html`.
   */
  postType?: 'page' | 'post';
  /** Scoped CSS for this page (already scoped under `body.lib-alt-page-<slug>`). */
  pageCss: string;
  /**
   * Per-page wrapper-scaffold chunks. When present, the page template carries the
   * scaffold + chrome parts and renders `post_content` (content sections only)
   * between them — the editable-content architecture. Absent → legacy template.
   */
  scaffold?: AltScaffold;
}

/** body_class / enqueue conditional for a page (front page → single → page). */
function pageCondition(p: AltPage): string {
  if (p.isHome) return 'is_front_page()';
  if (p.postType === 'post') return `is_single( '${p.slug}' )`;
  return `is_page( '${p.slug}' )`;
}

/**
 * A distinct header+footer pair. The assembler dedupes pages by chrome content,
 * so one variant covers every page whose chrome DOM is identical. The variant
 * order matters: the FIRST variant (conventionally the home page's) becomes the
 * canonical `header`/`footer` parts; subsequent variants get `-2`, `-3`, … slugs.
 */
export interface ChromeVariant {
  /** Stable key referenced by [[AltPage.chromeKey]]. */
  key: string;
  /** Block markup for this variant's header template part. */
  headerIsland: string;
  /** Block markup for this variant's footer template part. */
  footerIsland: string;
}

export interface AltThemeInput {
  /** Display name that appears in WP's theme list (required by WordPress). */
  themeName: string;
  /** Distinct chrome variants (home first). Each emits its own header/footer parts. */
  chromeVariants: ChromeVariant[];
  /**
   * Site-wide CSS (already scoped under `body.lib-alt-site`). Holds EVERY variant's
   * chrome CSS concatenated — safe because each variant's rules key off the source's
   * per-header comp-ids, so a variant's rules match nothing on a page using another.
   */
  siteCss: string;
  /**
   * Classes from the source `<body>` to replicate on the WP body (via body_class).
   * Carried CSS folds the source's `body` selector onto the scope, so rules keyed
   * on body state — e.g. Wix's `body.responsive` / `body:not(.responsive)` that
   * gate the entire responsive (mobile-reflow) layout — only behave correctly when
   * the WP body carries the same classes. Without this the alt is stuck in the
   * desktop layout on mobile.
   */
  bodyClasses?: string[];
  /** One entry per page that needs a template + per-page CSS file. */
  pages: AltPage[];
}

/** Header/footer template-part slugs for a chrome variant by its position. */
interface ChromeSlugs {
  header: string;
  footer: string;
}

/** Variant 0 → canonical `header`/`footer`; later variants → `header-2`, … */
function chromeSlugsForIndex(index: number): ChromeSlugs {
  const suffix = index === 0 ? '' : `-${index + 1}`;
  return { header: `header${suffix}`, footer: `footer${suffix}` };
}

export interface ThemeFile {
  /** Theme-relative path, e.g. "templates/index.html". */
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function styleCssHeader(name: string): string {
  const textDomain = name.toLowerCase().replace(/\s+/g, '-');
  return `/*\nTheme Name: ${name}\nVersion: 1.0.0\nText Domain: ${textDomain}\n*/\n`;
}

/**
 * Standard page template: header part → main post-content island → footer part.
 * Used for every page template including the required index.html fallback.
 */
function pageTemplate(slugs: ChromeSlugs): string {
  return [
    `<!-- wp:template-part {"slug":"${slugs.header}","tagName":"header"} /-->`,
    '<!-- wp:group {"tagName":"main"} -->',
    '<main class="wp-block-group"><!-- wp:post-content /--></main>',
    '<!-- /wp:group -->',
    `<!-- wp:template-part {"slug":"${slugs.footer}","tagName":"footer"} /-->`,
    '',
  ].join('\n');
}

/** Wrap raw HTML in a core/html block, or '' when empty. */
function htmlBlock(html: string): string {
  return html ? `<!-- wp:html -->\n${html}\n<!-- /wp:html -->` : '';
}

/**
 * Scaffolded template for the editable-content architecture: the wrapper chunks
 * ride in the template as core/html, the chrome as template parts (rendered with
 * a `tagName:div` wrapper that `display:contents` makes box-less so the carried
 * chrome lands in its exact DOM position), and `post_content` (content sections
 * only) sits between them. Concatenated, the stream rebuilds the source DOM.
 */
function scaffoldedTemplate(s: AltScaffold, slugs: ChromeSlugs): string {
  return [
    htmlBlock(s.openWrap),
    `<!-- wp:template-part {"slug":"${slugs.header}","tagName":"div"} /-->`,
    htmlBlock(s.midBefore),
    '<!-- wp:post-content /-->',
    htmlBlock(s.midAfter),
    `<!-- wp:template-part {"slug":"${slugs.footer}","tagName":"div"} /-->`,
    htmlBlock(s.closeWrap),
  ]
    .filter(Boolean)
    .join('\n');
}

/** The right template body for a page: scaffolded when it has a scaffold, else legacy. */
function templateFor(p: AltPage, slugs: ChromeSlugs): string {
  return p.scaffold ? scaffoldedTemplate(p.scaffold, slugs) : pageTemplate(slugs);
}

/** Valid, safe CSS class token (no quotes/spaces); excludes WP-reserved-ish noise. */
function sanitizeBodyClass(cls: string): string | null {
  return /^[a-zA-Z][\w-]{0,60}$/.test(cls) ? cls : null;
}

function functionsPhp(pages: AltPage[], bodyClasses: string[]): string {
  // body_class filter: always add lib-alt-site; replicate the source body classes
  // (so body-state-gated carried rules behave like the source); add per-page class.
  const sourceBodyCases = bodyClasses
    .map(sanitizeBodyClass)
    .filter((c): c is string => c !== null)
    .map((c) => `    $classes[] = '${c}';`)
    .join('\n');
  const bodyCases = pages
    .map((p) => `    if ( ${pageCondition(p)} ) { $classes[] = 'lib-alt-page-${p.slug}'; }`)
    .join('\n');

  // wp_enqueue_scripts: enqueue site.css globally; page CSS conditionally.
  const enqueue = pages
    .map(
      (p) =>
        `    if ( ${pageCondition(p)} ) { wp_enqueue_style( 'lib-alt-page-${p.slug}', get_stylesheet_directory_uri() . '/assets/css/page-${p.slug}.css', array( 'lib-alt-site' ), '1.0.0' ); }`,
    )
    .join('\n');

  return `<?php
add_filter( 'body_class', function( $classes ) {
    $classes[] = 'lib-alt-site';
${sourceBodyCases ? sourceBodyCases + '\n' : ''}${bodyCases}
    return $classes;
} );

add_action( 'wp_enqueue_scripts', function() {
    wp_enqueue_style( 'lib-alt-site', get_stylesheet_directory_uri() . '/assets/css/site.css', array(), '1.0.0' );
${enqueue}
} );
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the complete file set for the alt (carry-and-scope) block theme.
 * Returns an array of `{path, content}` — the caller writes them to disk.
 */
export function buildAltThemeFiles(input: AltThemeInput): ThemeFile[] {
  // Block themes do NOT auto-enqueue style.css on the front end — it's only the
  // theme-header file. So the reset must ride the enqueued site.css instead, and
  // it goes FIRST so the carried source CSS overrides it (the reset must lose the
  // cascade to the source's own rules).
  //
  // `all:revert` reverts the body to the UA stylesheet, which REINTRODUCES the
  // default `<body>` margin (8px) — and the carried `body{margin:0}` reset is now
  // `:where(body.lib-alt-site){margin:0}` (zero specificity), so it can't override
  // it. That 8px shifts the whole carried layout down vs the source. Zero
  // margin/padding explicitly (same rule, after `all:revert`, so it wins).
  const RESET =
    'body.lib-alt-site{all:revert;margin:0;padding:0}\nbody.lib-alt-site *{box-sizing:border-box}\n';

  // When the page templates carry the wrapper scaffold + chrome parts, the
  // template-part wrapper element (`<div class="wp-block-template-part">`) would
  // otherwise become a grid/flex item of the source layout and displace the
  // carried chrome. `display:contents` makes that wrapper box-less so the real
  // <header>/<footer> stay where the source put them. (No-op when no parts.)
  const usesScaffold = input.pages.some((p) => p.scaffold);
  const CHROME_RESCUE = usesScaffold ? '.wp-block-template-part{display:contents}\n' : '';

  // Wix pro-galleries lay their items out with JS-computed ABSOLUTE coordinates
  // frozen at the desktop capture (a multi-column grid). The carry has no JS to
  // re-pack them for narrow viewports, so on mobile only the leftmost column is on
  // screen and the rest overflow off the right. Re-flow them into a single stacked
  // column at mobile widths — static position, full-width column — which matches
  // the source's mobile gallery far better than the frozen desktop grid. Mobile-
  // gated so the desktop absolute grid (which IS correct) is untouched.
  const GALLERY_REFLOW =
    '@media screen and (max-width:750px){' +
    'body.lib-alt-site [class*="pro-gallery"]{height:auto!important;display:flex!important;flex-direction:column!important;align-items:center}' +
    'body.lib-alt-site [class*="pro-gallery"] [class*="gallery-column"]{width:100%!important}' +
    'body.lib-alt-site [class*="pro-gallery"] [class*="gallery-item-container"]{position:relative!important;inset:auto!important;left:auto!important;top:auto!important;transform:none!important;margin:4px 0!important}' +
    '}\n';

  // Map each distinct chrome variant to its part slugs (variant 0 → header/footer).
  const slugsByKey = new Map<string, ChromeSlugs>();
  input.chromeVariants.forEach((v, i) => slugsByKey.set(v.key, chromeSlugsForIndex(i)));
  // Fallback for pages whose chromeKey somehow isn't in the variant list (defensive).
  const slugsFor = (key: string): ChromeSlugs =>
    slugsByKey.get(key) ?? chromeSlugsForIndex(0);

  const themeJson: Record<string, unknown> = {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings: { layout: { contentSize: '100%', wideSize: '100%' } },
  };
  // Declare every variant's chrome areas so the Site Editor treats each header/
  // footer as a first-class, synced region.
  const hasChrome = input.chromeVariants.some((v) => v.headerIsland || v.footerIsland);
  if (hasChrome) {
    themeJson.templateParts = input.chromeVariants.flatMap((v, i) => {
      const s = chromeSlugsForIndex(i);
      const suffix = i === 0 ? '' : ` ${i + 1}`;
      return [
        { name: s.header, title: `Header${suffix}`, area: 'header' },
        { name: s.footer, title: `Footer${suffix}`, area: 'footer' },
      ];
    });
  }

  // index.html (required fallback) reuses the home page's scaffold + chrome so it
  // renders correctly; falls back to the legacy shell when no scaffold exists.
  const homePage = input.pages.find((p) => p.isHome);
  const homeSlugs = slugsFor(homePage?.chromeKey ?? input.chromeVariants[0]?.key ?? '');
  const indexTemplate = homePage?.scaffold
    ? scaffoldedTemplate(homePage.scaffold, homeSlugs)
    : pageTemplate(homeSlugs);

  const files: ThemeFile[] = [
    { path: 'style.css', content: styleCssHeader(input.themeName) },
    { path: 'theme.json', content: JSON.stringify(themeJson, null, 2) },
    { path: 'functions.php', content: functionsPhp(input.pages, input.bodyClasses ?? []) },
    // Site-wide CSS — reset first (so source rules win the cascade), then the
    // chrome-wrapper rescue, then EVERY variant's carried chrome CSS (concatenated
    // upstream into siteCss; comp-id-scoped so variants never collide).
    { path: 'assets/css/site.css', content: RESET + CHROME_RESCUE + GALLERY_REFLOW + input.siteCss },
    { path: 'templates/index.html', content: indexTemplate },
  ];

  // One header/footer part pair per DISTINCT chrome variant.
  input.chromeVariants.forEach((v, i) => {
    const s = chromeSlugsForIndex(i);
    files.push({ path: `parts/${s.header}.html`, content: v.headerIsland + '\n' });
    files.push({ path: `parts/${s.footer}.html`, content: v.footerIsland + '\n' });
  });

  // Per-page CSS + template files. Posts share ONE single.html; the per-post body
  // class + enqueued page-<slug>.css still scope each post's carried CSS.
  let emittedSingle = false;
  for (const p of input.pages) {
    files.push({ path: `assets/css/page-${p.slug}.css`, content: p.pageCss });
    const slugs = slugsFor(p.chromeKey);
    if (p.isHome) {
      files.push({ path: 'templates/front-page.html', content: templateFor(p, slugs) });
    } else if (p.postType === 'post') {
      if (!emittedSingle) {
        files.push({ path: 'templates/single.html', content: templateFor(p, slugs) });
        emittedSingle = true;
      }
    } else {
      files.push({ path: `templates/page-${p.slug}.html`, content: templateFor(p, slugs) });
    }
  }

  return files;
}
