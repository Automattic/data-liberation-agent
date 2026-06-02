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

export interface AltPage {
  /** URL-safe slug (kebab-case, produced by slugify — no quotes or special chars). */
  slug: string;
  /** True for the site front page — maps template to front-page.html and uses is_front_page(). */
  isHome?: boolean;
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
}

/** body_class / enqueue conditional for a page (front page → single → page). */
function pageCondition(p: AltPage): string {
  if (p.isHome) return 'is_front_page()';
  if (p.postType === 'post') return `is_single( '${p.slug}' )`;
  return `is_page( '${p.slug}' )`;
}

export interface AltThemeInput {
  /** Display name that appears in WP's theme list (required by WordPress). */
  themeName: string;
  /** Block markup for the header template part. */
  headerIsland: string;
  /** Block markup for the footer template part. */
  footerIsland: string;
  /** Site-wide CSS (already scoped under `body.lib-alt-site`). */
  siteCss: string;
  /** One entry per page that needs a template + per-page CSS file. */
  pages: AltPage[];
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
function pageTemplate(): string {
  return [
    '<!-- wp:template-part {"slug":"header","tagName":"header"} /-->',
    '<!-- wp:group {"tagName":"main"} -->',
    '<main class="wp-block-group"><!-- wp:post-content /--></main>',
    '<!-- /wp:group -->',
    '<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->',
    '',
  ].join('\n');
}

function functionsPhp(pages: AltPage[]): string {
  // body_class filter: always add lib-alt-site; conditionally add per-page class.
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
${bodyCases}
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
  const RESET =
    'body.lib-alt-site{all:revert}\nbody.lib-alt-site *{box-sizing:border-box}\n';

  const files: ThemeFile[] = [
    // Required by WordPress to recognise the theme — header metadata only.
    {
      path: 'style.css',
      content: styleCssHeader(input.themeName),
    },
    // theme.json: full-width layout so carried HTML fills the viewport.
    {
      path: 'theme.json',
      content: JSON.stringify(
        {
          $schema: 'https://schemas.wp.org/trunk/theme.json',
          version: 3,
          settings: {
            layout: { contentSize: '100%', wideSize: '100%' },
          },
        },
        null,
        2,
      ),
    },
    { path: 'functions.php', content: functionsPhp(input.pages) },
    // Template parts.
    { path: 'parts/header.html', content: input.headerIsland + '\n' },
    { path: 'parts/footer.html', content: input.footerIsland + '\n' },
    // Site-wide CSS — reset first (so source rules win the cascade), then carried CSS.
    { path: 'assets/css/site.css', content: RESET + input.siteCss },
    // templates/index.html is REQUIRED by WordPress for a block theme to be
    // activatable — without it the theme won't appear in the admin or will
    // throw a "missing required files" error.  It uses the same
    // header→main→footer shell as every other template.
    { path: 'templates/index.html', content: pageTemplate() },
  ];

  // Per-page CSS + template files. Posts share ONE single.html (the template
  // hierarchy routes every post through it); the per-post body class + enqueued
  // page-<slug>.css still scope each post's carried CSS individually.
  let emittedSingle = false;
  for (const p of input.pages) {
    files.push({ path: `assets/css/page-${p.slug}.css`, content: p.pageCss });
    if (p.isHome) {
      files.push({ path: 'templates/front-page.html', content: pageTemplate() });
    } else if (p.postType === 'post') {
      if (!emittedSingle) {
        files.push({ path: 'templates/single.html', content: pageTemplate() });
        emittedSingle = true;
      }
    } else {
      files.push({ path: `templates/page-${p.slug}.html`, content: pageTemplate() });
    }
  }

  return files;
}
