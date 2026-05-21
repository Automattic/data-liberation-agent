// src/lib/preview/blank-theme.ts
//
// Generates a minimal "blank" WordPress theme that gets out of the way so the
// carried site.css fully controls the look. Enqueues site.css (front-end +
// editor), optionally site.js (footer) + an enforced CSP, re-links CDN fonts,
// and renders the_content() with NO header/footer/sidebar chrome.
//
import { LIBRARY_CDN_ALLOWLIST } from '../screenshot/js-aggregator.js';
import type { ReplicaFile } from './types.js';

export interface BlankThemeOpts {
  themeSlug: string;
  hasJs: boolean;
  headLinks: string[]; // CDN/cross-origin stylesheet hrefs to re-link (e.g. Google Fonts)
  /** Sanitized site header HTML to emit as a real theme chrome element. */
  headerHtml?: string;
  /** Sanitized site footer HTML to emit as a real theme chrome element. */
  footerHtml?: string;
}

export function buildBlankTheme(opts: BlankThemeOpts): ReplicaFile[] {
  const { themeSlug, hasJs, headLinks, headerHtml, footerHtml } = opts;

  const styleCss = `/*
Theme Name: DLA Replica (${themeSlug})
Description: Blank companion theme for html-first design replication. Carried CSS lives in site.css.
Version: 1.0.0
*/
`;

  const fontEnqueues = headLinks
    .map((href, i) => `  wp_enqueue_style('dla-font-${i}', ${phpString(href)}, array(), null);`)
    .join('\n');

  const jsEnqueue = hasJs
    ? `  wp_enqueue_script('dla-site', get_stylesheet_directory_uri() . '/site.js', array(), null, true);`
    : '';

  const cspHosts = ["'self'", ...LIBRARY_CDN_ALLOWLIST].join(' ');
  const cspBlock = hasJs
    ? `
add_action('send_headers', function () {
  header("Content-Security-Policy: default-src 'self' data: https:; script-src ${cspHosts}; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:;");
});`
    : '';

  const functionsPhp = `<?php
// The carried fragment is raw HTML — prevent WordPress content filters from
// mangling it. wpautop inserts stray <p> tags; wptexturize alters quotes/dashes.
remove_filter('the_content', 'wpautop');
remove_filter('the_content', 'wptexturize');

add_action('wp_enqueue_scripts', function () {
  wp_enqueue_style('dla-site', get_stylesheet_directory_uri() . '/site.css', array(), null);
${fontEnqueues}
${jsEnqueue}
});
add_action('after_setup_theme', function () {
  add_editor_style('site.css');
});${cspBlock}
`;

  // Build the chrome sections. The bake step in collectBodyAndChrome already
  // set position:static on fixed/sticky elements; this CSS is a safety net so
  // the wrapper blocks flow correctly even if residual position styles survive.
  const chromeSafetyCss = (headerHtml || footerHtml)
    ? `\n<style>.dla-site-header,.dla-site-footer{position:relative;width:100%;}</style>`
    : '';

  // Escape any literal </script> inside the baked chrome HTML so it cannot
  // break out of a surrounding <script> block (defense-in-depth; sanitize
  // already strips <script> tags, but fragment strings get baked inline here).
  const safeHtml = (html: string): string => html.replace(/<\/script/gi, '<\\/script');

  const headerBlock = headerHtml
    ? `<header class="dla-site-header">${safeHtml(headerHtml)}</header>\n`
    : '';
  const footerBlock = footerHtml
    ? `\n<footer class="dla-site-footer">${safeHtml(footerHtml)}</footer>`
    : '';

  const template = `<?php
/* Blank template — carried CSS owns the look; chrome baked from live capture when available. */
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>${chromeSafetyCss}
</head>
<body <?php body_class('dla-replica'); ?>>
${headerBlock}<main><?php if (have_posts()) { while (have_posts()) { the_post(); the_content(); } } ?></main>${footerBlock}
<?php wp_footer(); ?>
</body>
</html>
`;

  return [
    { relativePath: 'style.css', content: styleCss },
    { relativePath: 'functions.php', content: functionsPhp },
    { relativePath: 'index.php', content: template },
    { relativePath: 'page.php', content: template },
    { relativePath: 'singular.php', content: template },
  ];
}

function phpString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
