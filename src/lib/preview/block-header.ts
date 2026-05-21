/**
 * src/lib/preview/block-header.ts
 * ================================
 * Generates WP block markup for a site header template part, built from
 * source-captured `ExtractedNav` data.
 *
 * Approach
 * ────────
 * - Outer `wp:group` (tagName=header) with flex layout (space-between / center)
 *   and full-width, styled with the captured background color.
 * - Left: `wp:image` with the logo (or `wp:paragraph` with siteTitle fallback).
 * - Center/right: `wp:navigation` block with `"overlayMenu":"mobile"` so WP
 *   Core's Navigation block renders the hamburger automatically at mobile widths.
 *   Each nav item is a `wp:navigation-link` with the captured label and href.
 * - Optional CTA: `wp:button` (last item in a `wp:buttons` wrapper) when a
 *   button-like link was detected.
 * - Colors/typography from `nav.style.*` via WP block inline style attributes.
 *
 * Hamburger interactivity (the key question)
 * ──────────────────────────────────────────
 * The Navigation block's frontend JS (the hamburger toggle) ships as a WP
 * Interactivity API view module (`wp-navigation-view`). It enqueues itself when
 * `do_blocks()` processes `wp:navigation` server-side — WP 6.5+ registers the
 * asset on render. So:
 *
 *   blank-theme index.php / page.php:
 *     <?php wp_head(); ?>            ← <link> for the nav view module goes here
 *     <?php echo do_blocks($header_markup); ?>   ← renders the block, enqueues view.js
 *     <?php the_content(); ?>
 *     <?php wp_footer(); ?>          ← <script> for the view module goes here
 *
 * This is a classic (non-block) theme using `do_blocks()` to process the header
 * block markup. It is deliberately chosen over a full block theme because:
 *   1. `do_blocks()` triggers the Navigation block's server-side render, which
 *      enqueues `wp-block-navigation-view` — the Interactivity API script.
 *   2. The classic theme model lets us mix `do_blocks()` with `the_content()` and
 *      footer bake in a single template, keeping the existing footer path unchanged.
 *   3. A minimal block theme would require `theme.json`, `templates/index.html`,
 *      and parts — more complexity for the same hamburger outcome.
 *
 * The block markup is stored as `parts/header.html` inside the theme bundle so
 * theme agents can inspect and refine it as usual.
 *
 * Source-agnostic: `buildBlockHeader` takes only `ExtractedNav` and optional
 * overrides — no Wix or platform-specific logic lives here.
 */

import type { ExtractedNav } from '../screenshot/nav-extract.js';

export interface BlockHeaderOpts {
  /** Local (uploaded) URL for the logo image, overrides nav.logoSrc when set. */
  logoLocalUrl?: string;
}

/**
 * Build block markup for the site header template part.
 *
 * Returns a string of WP block comment grammar suitable for:
 *   - Writing to `parts/header.html` in the theme bundle.
 *   - Passing to `do_blocks()` in the classic theme PHP template.
 */
export function buildBlockHeader(nav: ExtractedNav, opts: BlockHeaderOpts = {}): string {
  const bg = nav.style.background || 'var(--wp--preset--color--base)';
  const textColor = nav.style.textColor || 'var(--wp--preset--color--contrast)';
  const fontFamily = nav.style.fontFamily
    ? `"${nav.style.fontFamily}"`
    : 'var(--wp--preset--font-family--body)';
  const logoUrl = opts.logoLocalUrl ?? nav.logoSrc;

  // ── Logo / site title block ────────────────────────────────────────────────
  const logoBlock = buildLogoBlock(logoUrl, nav.logoAlt, nav.siteTitle, textColor);

  // ── Navigation block ───────────────────────────────────────────────────────
  const navBlock = buildNavigationBlock(nav, textColor, fontFamily);

  // ── CTA block (optional) ───────────────────────────────────────────────────
  const ctaBlock = nav.cta ? buildCtaBlock(nav.cta, nav.style) : '';

  // ── Right-side group (nav + optional CTA) ─────────────────────────────────
  const rightGroup = `<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"right","verticalAlignment":"center"},"style":{"spacing":{"blockGap":"1rem"}}} -->
<div class="wp-block-group">${navBlock}${ctaBlock}</div>
<!-- /wp:group -->`;

  // ── Outer header group (full-width flex, space-between) ───────────────────
  const outerStyle = JSON.stringify({
    color: { background: bg },
    spacing: {
      padding: {
        top: '0.75rem',
        bottom: '0.75rem',
        left: '1.5rem',
        right: '1.5rem',
      },
    },
  });

  return `<!-- wp:group {"tagName":"header","align":"full","style":${outerStyle},"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
<header class="wp-block-group alignfull" style="background-color:${bg};padding-top:0.75rem;padding-right:1.5rem;padding-bottom:0.75rem;padding-left:1.5rem">${logoBlock}${rightGroup}</header>
<!-- /wp:group -->`;
}

// ── Internal builders ────────────────────────────────────────────────────────

function buildLogoBlock(
  logoUrl: string | null,
  logoAlt: string | null,
  siteTitle: string | null,
  textColor: string,
): string {
  if (logoUrl) {
    const alt = (logoAlt ?? '').replace(/"/g, '&quot;');
    const attrs = JSON.stringify({ sizeSlug: 'full', linkDestination: 'custom', url: logoUrl, alt });
    return `<!-- wp:image ${attrs} -->
<figure class="wp-block-image"><a href="/"><img src="${esc(logoUrl)}" alt="${alt}"/></a></figure>
<!-- /wp:image -->`;
  }

  const title = siteTitle ?? '';
  const styleAttr = JSON.stringify({ typography: { fontWeight: '700' }, color: { text: textColor } });
  if (title) {
    return `<!-- wp:site-title {"style":${styleAttr}} /-->`;
  }
  return `<!-- wp:site-title /-->`;
}

function buildNavigationBlock(
  nav: ExtractedNav,
  textColor: string,
  fontFamily: string,
): string {
  const navAttrs: Record<string, unknown> = {
    overlayMenu: 'mobile',
    layout: {
      type: 'flex',
      setCascadingProperties: true,
      justifyContent: 'right',
    },
    style: {
      typography: { fontFamily },
      color: { text: textColor },
      spacing: { blockGap: '1.5rem' },
    },
  };

  const links = nav.items.map((item) => {
    const attrs = JSON.stringify({ label: item.label, url: item.href });
    return `<!-- wp:navigation-link ${attrs} /-->`;
  }).join('\n');

  // TODO: map nav item hrefs to local page slugs (currently using source hrefs)

  return `<!-- wp:navigation ${JSON.stringify(navAttrs)} -->
${links}
<!-- /wp:navigation -->`;
}

function buildCtaBlock(
  cta: { label: string; href: string },
  style: ExtractedNav['style'],
): string {
  const bg = style.ctaBackground ?? style.textColor ?? '#000000';
  const color = style.ctaTextColor ?? style.background ?? '#ffffff';
  const btnAttrs = JSON.stringify({
    url: cta.href,
    text: cta.label,
    style: {
      color: { background: bg, text: color },
      border: { radius: '4px' },
    },
    className: 'is-style-fill',
  });
  return `<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button ${btnAttrs} -->
<div class="wp-block-button is-style-fill"><a class="wp-block-button__link wp-element-button" href="${esc(cta.href)}" style="background-color:${bg};color:${color};border-radius:4px">${esc(cta.label)}</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->`;
}

/** Minimal HTML entity escape for attribute values and text content. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
