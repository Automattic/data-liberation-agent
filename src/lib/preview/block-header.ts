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
  // Priority:
  //   1. Extracted background is opaque (alpha > 0, not transparent keyword).
  //   2. backgroundImage present (gradient / image) → keep transparent bg, use image.
  //   3. brandDark fallback when bg is transparent/indeterminate.
  //   4. WP preset variable (last resort).
  const isTransparent = isTransparentBg(rawBg);
  let effectiveBg: string;
  let appliedFallback = false;

  if (!isTransparent) {
    // Opaque extracted color — use it directly.
    effectiveBg = rawBg || 'var(--wp--preset--color--base)';
  } else if (bgImage) {
    // Background image/gradient path — keep transparent bg, image takes over.
    effectiveBg = rawBg || 'transparent';
  } else if (opts.brandDark) {
    // Transparent header + brand-dark palette color available → use brand color.
    effectiveBg = opts.brandDark;
    appliedFallback = true;
  } else {
    effectiveBg = rawBg || 'var(--wp--preset--color--base)';
  }

  // ── Determine effective text color ────────────────────────────────────────
  // When we applied a fallback background (brandDark), or when the extracted
  // background is opaque, compute contrast-safe text color from the effective bg.
  // This overrides the (unreliable) extracted textColor in both cases.
  let textColor: string;
  if (appliedFallback) {
    // brandDark is always a hex value → contrast helper works directly.
    textColor = contrastTextColor(effectiveBg);
  } else if (!isTransparent && !bgImage) {
    // Opaque extracted bg — check contrast; override if extracted text would
    // be illegible.  Parse the extracted textColor luminance vs. bg luminance.
    const bgLum = parseCssColorLuminance(effectiveBg);
    const extractedText = nav.style.textColor || null;
    if (bgLum !== null) {
      textColor = bgLum < 0.5 ? '#ffffff' : '#111111';
    } else {
      textColor = extractedText || 'var(--wp--preset--color--contrast)';
    }
  } else {
    // backgroundImage or fallback WP var — use extracted textColor as-is.
    textColor = nav.style.textColor || 'var(--wp--preset--color--contrast)';
  }

  const bg = effectiveBg;

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
  const ctaBlock = resolvedCta ? buildCtaBlock(resolvedCta, nav.style) : '';

  // ── Right-side group (nav + optional CTA) ─────────────────────────────────
  const rightGroup = `<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"right","verticalAlignment":"center"},"style":{"spacing":{"blockGap":"1rem"}}} -->
<div class="wp-block-group">${navBlock}${ctaBlock}</div>
<!-- /wp:group -->`;

  // ── Outer header group (full-width flex, space-between) ───────────────────
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
  // the gradient/image is painted and a fallback color is still declared.
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
  const navOverrideStyle = buildNavOverrideStyle(textColor, nav.style, resolvedCta);

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
      spacing: { blockGap: '1.5rem' },
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
 */
function buildNavOverrideStyle(
  textColor: string,
  style: ExtractedNav['style'],
  cta: { label: string; href: string; bg?: string; color?: string } | null,
): string {
  const fontFamily = style.fontFamily ? `"${style.fontFamily}"` : null;
  const rules: string[] = [];

  // Build the nav-link rule.
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

  // Build the CTA button rule when a CTA is present.
  if (cta) {
    const ctaBg = cta.bg ?? style.ctaBackground ?? null;
    const ctaColor = cta.color ?? style.ctaTextColor ?? null;
    const ctaProps: string[] = [];
    if (ctaBg) ctaProps.push(`background-color:${ctaBg} !important`, `background:${ctaBg} !important`);
    if (ctaColor) ctaProps.push(`color:${ctaColor} !important`);
    if (ctaProps.length > 0) {
      rules.push(
        `header.wp-block-group .wp-block-button__link { ${ctaProps.join(';')}; }`,
      );
    }
  }

  if (rules.length === 0) return '';
  return `<style>\n${rules.join('\n')}\n</style>\n`;
}

function buildCtaBlock(
  cta: { label: string; href: string; bg?: string; color?: string },
  style: ExtractedNav['style'],
): string {
  const bg = cta.bg ?? style.ctaBackground ?? style.textColor ?? '#000000';
  const color = cta.color ?? style.ctaTextColor ?? style.background ?? '#ffffff';
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
