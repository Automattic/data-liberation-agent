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
import { relativeLuminance, contrastTextColor } from './brand-color.js';
import { resolveNavHref } from './nav-href.js';

export interface BlockHeaderOpts {
  /** Local (uploaded) URL for the logo image, overrides nav.logoSrc when set. */
  logoLocalUrl?: string;
  /**
   * Site's brand-dark color (hex, e.g. "#175236") derived from palette.json.
   * Used as header background fallback when the extracted background is
   * transparent / indeterminate.  Text color is computed by contrast.
   */
  brandDark?: string;
  /**
   * Base URL of the source site (e.g. "https://www.swiftlumber.com").
   * When present, same-site nav hrefs are rewritten to local WordPress page
   * paths (e.g. "/about-us/") and the homepage href becomes "/".
   * External hrefs (different registrable domain) are left unchanged.
   * When absent, all hrefs are emitted as-is (back-compat).
   */
  siteUrl?: string;
}

/**
 * Build block markup for the site header template part.
 *
 * Returns a string of WP block comment grammar suitable for:
 *   - Writing to `parts/header.html` in the theme bundle.
 *   - Passing to `do_blocks()` in the classic theme PHP template.
 */
export function buildBlockHeader(nav: ExtractedNav, opts: BlockHeaderOpts = {}): string {
  const rawBg = nav.style.background;
  const bgImage = nav.style.backgroundImage;
  const fontFamily = nav.style.fontFamily
    ? `"${nav.style.fontFamily}"`
    : 'var(--wp--preset--font-family--body)';
  const logoUrl = opts.logoLocalUrl ?? nav.logoSrc;

  // ── Determine effective background ────────────────────────────────────────
  // The header is ALWAYS rendered as a transparent overlay over the hero/content.
  // The source nav background (and brandDark) are intentionally NOT used to fill
  // the header group background — this matches the source's transparent header that
  // sits over the (blue) hero, making the green CTA button visible against the hero
  // rather than invisible against a matching green header bg.
  //
  // brandDark is still used as the CTA button background color (see buildCtaBlock).
  //
  // backgroundImage (gradient/image) is preserved on the outer group when present
  // (rare — some sources bake a gradient into the header bar itself).
  const isTransparent = isTransparentBg(rawBg);
  const bg = 'transparent';

  // Nav text is always white when the header is transparent — the source pattern
  // is white text over a hero image.  If an explicit light textColor was extracted
  // we preserve it; otherwise we default to white for legibility over dark heroes.
  // (White text over a light hero is low-contrast — same behavior as the source.)
  const textColor = '#ffffff';

  // ── Logo / site title block ────────────────────────────────────────────────
  const logoBlock = buildLogoBlock(logoUrl, nav.logoAlt, nav.siteTitle, textColor);

  // ── Navigation block ───────────────────────────────────────────────────────
  const navBlock = buildNavigationBlock(nav, textColor, fontFamily, opts.siteUrl);

  // ── CTA block (optional) ───────────────────────────────────────────────────
  const ctaHref = nav.cta?.href;
  const resolvedCta = nav.cta
    ? {
        ...nav.cta,
        href: opts.siteUrl && ctaHref ? resolveNavHref(ctaHref, opts.siteUrl) : (ctaHref ?? ''),
      }
    : null;
  const ctaBlock = resolvedCta ? buildCtaBlock(resolvedCta, nav.style, opts.brandDark) : '';

  // ── Right-side group (nav + optional CTA) ─────────────────────────────────
  const rightGroup = `<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"right","verticalAlignment":"center"},"style":{"spacing":{"blockGap":"1rem"}}} -->
<div class="wp-block-group">${navBlock}${ctaBlock}</div>
<!-- /wp:group -->`;

  // ── Outer header group (full-width flex, space-between) ───────────────────
  // Background is always transparent — the header overlays the hero via
  // position:absolute in the navOverrideStyle block below.
  const outerStyle: Record<string, unknown> = {
    color: { background: bg },
    spacing: {
      padding: {
        top: '0.75rem',
        bottom: '0.75rem',
        left: '1.5rem',
        right: '1.5rem',
      },
    },
  };

  // Build the inline style string for the <header> element.
  // When backgroundImage is present, apply it alongside background-color so
  // the gradient/image is painted; header bg itself stays transparent.
  const inlineStyles: string[] = [
    `background-color:${bg}`,
    `padding-top:0.75rem`,
    `padding-right:1.5rem`,
    `padding-bottom:0.75rem`,
    `padding-left:1.5rem`,
  ];
  if (bgImage) {
    inlineStyles.splice(1, 0, `background-image:${bgImage}`);
  }
  const inlineStyle = inlineStyles.join(';');

  // ── High-specificity style block to override leaked site.css ─────────────
  // The theme enqueues the source site's CSS (e.g. Wix site.css) which contains
  // global `a` / text rules that cascade into our generated header even though
  // the header is OUTSIDE the .dla-replica content wrapper.  We defeat this by
  // emitting a scoped <style> block with !important rules that enforce the
  // captured typography and color tokens on every nav link rendered by the
  // wp:navigation block.
  // Pass brandDark as ctaBrandColor so the CTA button gets the green fill even
  // when no explicit cta.bg is captured (e.g. source uses a CSS class, not inline).
  const ctaBrandColor = opts.brandDark ?? null;
  const navOverrideStyle = buildNavOverrideStyle(textColor, nav.style, resolvedCta, ctaBrandColor);

  return `${navOverrideStyle}<!-- wp:group {"tagName":"header","align":"full","style":${JSON.stringify(outerStyle)},"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
<header class="wp-block-group alignfull" style="${inlineStyle}">${logoBlock}${rightGroup}</header>
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
  siteUrl?: string,
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
      // Wide inter-item gap matches source's evenly spaced nav (2.25rem ≈ 36px).
      spacing: { blockGap: '2.25rem' },
    },
  };

  const links = nav.items.map((item) => {
    const resolvedHref = siteUrl ? resolveNavHref(item.href, siteUrl) : item.href;
    const attrs = JSON.stringify({ label: item.label, url: resolvedHref });
    return `<!-- wp:navigation-link ${attrs} /-->`;
  }).join('\n');

  return `<!-- wp:navigation ${JSON.stringify(navAttrs)} -->
${links}
<!-- /wp:navigation -->`;
}

/**
 * Emit a <style> block with high-specificity !important rules scoped to the
 * generated header.  This defeats global CSS from the source site's stylesheet
 * (e.g. Wix's site.css) which the theme enqueues and which can override the
 * header's intended nav typography and color.
 *
 * The rules target the WP Navigation block selectors used at runtime so the
 * override is precise and doesn't bleed outside the header.
 *
 * Key overlay rules:
 *   - header.wp-block-group is positioned absolute over the hero (position:absolute,
 *     top:0, left:0, right:0, z-index:1000) with a transparent background so the
 *     hero's color/image shows through — this is why the green CTA pops (hero is
 *     blue, not green) and matches the source's transparent-overlay nav pattern.
 *   - Nav container gets a wide flex gap (2.25rem) so items are evenly spaced.
 */
function buildNavOverrideStyle(
  textColor: string,
  style: ExtractedNav['style'],
  cta: { label: string; href: string; bg?: string; color?: string } | null,
  ctaBrandColor: string | null,
): string {
  const fontFamily = style.fontFamily ? `"${style.fontFamily}"` : null;
  const rules: string[] = [];

  // ── Transparent absolute overlay on the header group ─────────────────────
  // Position the header over the first content section (the hero) so the hero
  // background bleeds through behind the nav — matching the source's behavior
  // where the header is "transparent over the blue hero".
  rules.push(
    `header.wp-block-group{ position:absolute !important; top:0; left:0; right:0; z-index:1000; background:transparent !important; background-color:transparent !important; }`,
  );

  // ── Wide inter-item spacing on the navigation container ──────────────────
  // The source nav links are evenly spaced with large gaps; reinforce via CSS
  // in addition to the blockGap block attribute so cascaded CSS can't override.
  rules.push(
    `header.wp-block-group .wp-block-navigation__container,\nheader.wp-block-group .wp-block-navigation{ gap:2.25rem !important; }`,
  );

  // ── Nav link typography + color ──────────────────────────────────────────
  const navProps: string[] = [];
  navProps.push(`color:${textColor} !important`);
  if (style.fontSize) navProps.push(`font-size:${style.fontSize} !important`);
  if (style.fontWeight) navProps.push(`font-weight:${style.fontWeight} !important`);
  if (style.letterSpacing) navProps.push(`letter-spacing:${style.letterSpacing} !important`);
  if (style.textTransform) navProps.push(`text-transform:${style.textTransform} !important`);
  if (fontFamily) navProps.push(`font-family:${fontFamily} !important`);

  if (navProps.length > 0) {
    const decls = navProps.join(';');
    rules.push(
      `header.wp-block-group .wp-block-navigation a,\nheader.wp-block-group .wp-block-navigation .wp-block-navigation-item__content { ${decls}; }`,
    );
  }

  // ── CTA button: green pill with white text ────────────────────────────────
  // The CTA button gets a visible green background (brandDark / extracted ctaBg)
  // with white text and a pill border-radius.  It contrasts against the (blue)
  // hero behind the transparent header — unlike a solid green header where the
  // green button would be invisible.
  if (cta) {
    // Prefer explicit cta.bg, then style.ctaBackground, then brandDark fallback.
    const ctaBg = cta.bg ?? style.ctaBackground ?? ctaBrandColor ?? null;
    // Prefer explicit cta.color, then style.ctaTextColor; default white for contrast.
    const ctaColor = cta.color ?? style.ctaTextColor ?? '#ffffff';
    const ctaProps: string[] = [];
    if (ctaBg) ctaProps.push(`background-color:${ctaBg} !important`, `background:${ctaBg} !important`);
    ctaProps.push(`color:${ctaColor} !important`);
    // Pill shape for the CTA — matches the source's rounded "CALL US" button.
    ctaProps.push(`border-radius:9999px !important`);
    ctaProps.push(`padding-left:1.5rem !important`, `padding-right:1.5rem !important`);
    rules.push(
      `header.wp-block-group .wp-block-button__link { ${ctaProps.join(';')}; }`,
    );
  }

  if (rules.length === 0) return '';
  return `<style>\n${rules.join('\n')}\n</style>\n`;
}

function buildCtaBlock(
  cta: { label: string; href: string; bg?: string; color?: string },
  style: ExtractedNav['style'],
  ctaBrandColor?: string | null,
): string {
  // CTA background: prefer explicit cta.bg, then style.ctaBackground, then brandDark.
  // Default to black only as last resort.
  const bg = cta.bg ?? style.ctaBackground ?? ctaBrandColor ?? style.textColor ?? '#000000';
  // CTA text: prefer explicit, then extracted; always default to white for contrast
  // (the CTA sits over the transparent header which shows the hero behind it).
  const color = cta.color ?? style.ctaTextColor ?? '#ffffff';
  // Pill border-radius to match source's rounded "CALL US" button style.
  const borderRadius = '9999px';
  const btnAttrs = JSON.stringify({
    url: cta.href,
    text: cta.label,
    style: {
      color: { background: bg, text: color },
      border: { radius: borderRadius },
    },
    className: 'is-style-fill',
  });
  return `<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button ${btnAttrs} -->
<div class="wp-block-button is-style-fill"><a class="wp-block-button__link wp-element-button" href="${esc(cta.href)}" style="background-color:${bg};color:${color};border-radius:${borderRadius}">${esc(cta.label)}</a></div>
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

// ── Color utilities (internal) ───────────────────────────────────────────────

/**
 * Return true when the CSS background value is transparent / indeterminate:
 *   - falsy / empty string
 *   - the keyword "transparent"
 *   - rgba(…,0) / rgba(0,0,0,0) — zero-alpha
 */
function isTransparentBg(bg: string | null | undefined): boolean {
  if (!bg) return true;
  const v = bg.trim().toLowerCase();
  if (v === 'transparent') return true;
  // rgba(r,g,b,0) or rgba(r,g,b,0.0) — match alpha component at the end
  const rgbaMatch = /rgba\s*\([^)]+,\s*([\d.]+)\s*\)/.exec(v);
  if (rgbaMatch) {
    return parseFloat(rgbaMatch[1]) === 0;
  }
  return false;
}

/**
 * Attempt to parse a CSS color value and return its relative luminance.
 * Handles:
 *   - #rrggbb hex (delegates to relativeLuminance from brand-color)
 *   - rgb(r, g, b) / rgba(r, g, b, a)
 * Returns null when the input can't be parsed (CSS variable, keyword, etc.).
 */
function parseCssColorLuminance(css: string): number | null {
  const s = css.trim();
  // #rrggbb hex — use the shared relativeLuminance helper
  if (/^#[0-9a-f]{6}$/i.test(s)) {
    return relativeLuminance(s);
  }
  // rgb(r, g, b) or rgba(r, g, b, a)
  const m = /rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)/i.exec(s);
  if (m) {
    const r = parseFloat(m[1]) / 255;
    const g = parseFloat(m[2]) / 255;
    const b = parseFloat(m[3]) / 255;
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  return null;
}
