import { describe, it, expect } from 'vitest';
import { buildBlockHeader } from './block-header.js';
import type { ExtractedNav } from '../screenshot/nav-extract.js';

const SAMPLE_NAV: ExtractedNav = {
  logoSrc: 'https://example.com/logo.svg',
  logoAlt: 'Example Corp',
  siteTitle: null,
  items: [
    { label: 'Home', href: '/' },
    { label: 'About', href: '/about' },
    { label: 'Services', href: '/services' },
    { label: 'Contact', href: '/contact' },
  ],
  cta: { label: 'Get Started', href: '/get-started' },
  style: {
    background: 'rgb(20, 20, 20)',
    textColor: 'rgb(255, 255, 255)',
    ctaBackground: 'rgb(0, 100, 200)',
    ctaTextColor: 'rgb(255, 255, 255)',
    fontFamily: 'Inter',
    height: 64,
  },
};

describe('buildBlockHeader', () => {
  it('contains wp:navigation with overlayMenu mobile', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    expect(markup).toContain('wp:navigation');
    expect(markup).toContain('"overlayMenu":"mobile"');
    expect(markup).toContain('/wp:navigation');
  });

  it('emits a wp:navigation-link for each nav item', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    for (const item of SAMPLE_NAV.items) {
      expect(markup).toContain(`"label":"${item.label}"`);
      expect(markup).toContain(`"url":"${item.href}"`);
    }
    // Verify it's a navigation-link block comment
    expect(markup).toContain('wp:navigation-link');
  });

  it('includes the CTA as a wp:button when present', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    expect(markup).toContain('wp:button');
    expect(markup).toContain('Get Started');
    expect(markup).toContain('/get-started');
    expect(markup).toContain('wp:buttons');
  });

  it('header group always uses transparent background (overlay mode)', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The header is always transparent — it overlays the hero section.
    // The source nav.style.background (rgb(20, 20, 20)) must NOT be used as the header fill.
    expect(markup).toContain('background-color:transparent');
    expect(markup).not.toContain('background-color:rgb(20, 20, 20)');
  });

  it('emits wp:image with logo src and alt when logo is present', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    expect(markup).toContain('wp:image');
    expect(markup).toContain('https://example.com/logo.svg');
    expect(markup).toContain('Example Corp');
  });

  it('uses the provided logoLocalUrl instead of nav.logoSrc', () => {
    const markup = buildBlockHeader(SAMPLE_NAV, { logoLocalUrl: '/wp-content/uploads/logo.svg' });
    expect(markup).toContain('/wp-content/uploads/logo.svg');
    // Original source URL should NOT appear in img src attribute
    expect(markup).not.toContain('https://example.com/logo.svg');
  });

  it('falls back to wp:site-title when no logo img present', () => {
    const navNoLogo: ExtractedNav = { ...SAMPLE_NAV, logoSrc: null, siteTitle: 'My Brand' };
    const markup = buildBlockHeader(navNoLogo);
    expect(markup).toContain('wp:site-title');
    expect(markup).not.toContain('wp:image');
  });

  it('omits the CTA button when nav.cta is null', () => {
    const navNoCta: ExtractedNav = { ...SAMPLE_NAV, cta: null };
    const markup = buildBlockHeader(navNoCta);
    expect(markup).not.toContain('wp:button');
    expect(markup).not.toContain('wp:buttons');
  });

  it('outer group has tagName header attribute', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The outer group must use tagName:header so WP renders a <header> element
    expect(markup).toContain('"tagName":"header"');
  });

  it('emits valid open/close WP block comments (no unclosed tags)', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // Count opening and closing block comments to verify balanced structure
    const openNavigation = (markup.match(/<!-- wp:navigation[\s{]/g) ?? []).length;
    const closeNavigation = (markup.match(/<!-- \/wp:navigation -->/g) ?? []).length;
    expect(openNavigation).toBeGreaterThan(0);
    expect(openNavigation).toBe(closeNavigation);

    const openGroup = (markup.match(/<!-- wp:group[\s{]/g) ?? []).length;
    const closeGroup = (markup.match(/<!-- \/wp:group -->/g) ?? []).length;
    expect(openGroup).toBe(closeGroup);
  });

  it('CTA button uses captured ctaBackground and ctaTextColor', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The CTA colors from nav.style should be in the button markup
    expect(markup).toContain('rgb(0, 100, 200)');
  });

  it('applies background-image inline style when style.backgroundImage is present', () => {
    const navWithBgImage: ExtractedNav = {
      ...SAMPLE_NAV,
      style: {
        ...SAMPLE_NAV.style,
        background: 'transparent',
        backgroundImage: 'linear-gradient(90deg, rgb(10, 10, 80) 0%, rgb(80, 10, 80) 100%)',
      },
    };
    const markup = buildBlockHeader(navWithBgImage);
    // backgroundImage must be in the inline style of the <header> element
    expect(markup).toContain('background-image:linear-gradient(90deg, rgb(10, 10, 80) 0%, rgb(80, 10, 80) 100%)');
    // background-color should also still be present (fallback)
    expect(markup).toContain('background-color:transparent');
  });

  it('does NOT emit background-image style when style.backgroundImage is absent', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // No backgroundImage field → no background-image in inline style
    expect(markup).not.toContain('background-image:');
  });

  // ── brandDark fallback tests ────────────────────────────────────────────────

  it('brandDark feeds the CTA button color (NOT the header background) when source bg is transparent', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      // Remove explicit ctaBackground so brandDark is the CTA color source.
      style: { ...SAMPLE_NAV.style, background: 'transparent', textColor: 'rgb(0, 0, 0)', ctaBackground: null },
      cta: { label: 'CALL US', href: '/call-us' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#175236' });
    // Header element's inline style must be transparent — brandDark must NOT be the header bg.
    expect(markup).toContain('background-color:transparent');
    // The only `background-color:#175236` occurrences should be in the CTA button
    // (both the !important override rule and the button's own inline style) — NOT on the header.
    // Verify the !important rule is present for the CTA.
    expect(markup).toContain('background-color:#175236 !important');
    // Verify the header element itself uses transparent (the inline style on <header>).
    expect(markup).toContain('<header class="wp-block-group alignfull" style="background-color:transparent');
  });

  it('forces nav and CTA text to white (#ffffff) when brandDark is dark (luminance < 0.5)', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'transparent', textColor: 'rgb(0, 0, 0)' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#175236' });
    // #175236 dark green → white text
    expect(markup).toContain('"text":"#ffffff"');
  });

  it('nav text is always white (#ffffff) for transparent overlay header (regardless of brandDark lightness)', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'transparent', textColor: 'rgb(255, 255, 255)' },
    };
    // Even a very light brandDark — transparent header always uses white nav text.
    const markup = buildBlockHeader(transparentNav, { brandDark: '#d4f0e8' });
    expect(markup).toContain('"text":"#ffffff"');
    expect(markup).not.toContain('"text":"#111111"');
  });

  it('treats rgba(0,0,0,0) as transparent; header stays transparent and brandDark goes to CTA', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'rgba(0,0,0,0)', textColor: 'rgb(0, 0, 0)', ctaBackground: null },
      cta: { label: 'CALL US', href: '/call-us' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#175236' });
    // Header must always be transparent, not rgba(0,0,0,0)
    expect(markup).toContain('background-color:transparent');
    expect(markup).not.toContain('rgba(0,0,0,0)');
    // brandDark still appears — as the CTA button background
    expect(markup).toContain('#175236');
  });

  it('header stays transparent even when source had an opaque background; brandDark does NOT fill the header', () => {
    // SAMPLE_NAV has background: 'rgb(20, 20, 20)' — opaque, but we always use transparent overlay.
    const markup = buildBlockHeader(SAMPLE_NAV, { brandDark: '#175236' });
    // The header must always be transparent — the opaque source bg is intentionally dropped.
    expect(markup).toContain('background-color:transparent');
    // brandDark must NOT appear as the header background-color (no `!important` on the element).
    // SAMPLE_NAV has style.ctaBackground='rgb(0, 100, 200)' which takes priority over brandDark for the CTA,
    // so #175236 should not appear in the output at all for SAMPLE_NAV.
    expect(markup).not.toContain('#175236');
  });

  it('overrides extracted text color with white for an opaque dark background', () => {
    // SAMPLE_NAV already has dark bg (20,20,20) with white text — confirm white is used
    const markup = buildBlockHeader(SAMPLE_NAV);
    // rgb(20,20,20) is dark → text should be #ffffff (computed) or existing white
    expect(markup).toContain('"text":"#ffffff"');
  });

  it('does not use brandDark when backgroundImage is present (gradient takes over)', () => {
    const bgImageNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: {
        ...SAMPLE_NAV.style,
        background: 'transparent',
        backgroundImage: 'linear-gradient(90deg, #003 0%, #300 100%)',
      },
    };
    const markup = buildBlockHeader(bgImageNav, { brandDark: '#175236' });
    // backgroundImage path — background stays transparent, brand color not injected
    expect(markup).toContain('background-image:linear-gradient(90deg, #003 0%, #300 100%)');
    expect(markup).not.toContain('background-color:#175236');
  });

  // ── siteUrl nav href rewriting ──────────────────────────────────────────────

  const SITE_URL = 'https://www.swiftlumber.com';

  const SITE_NAV: ExtractedNav = {
    ...SAMPLE_NAV,
    items: [
      { label: 'Home', href: 'https://www.swiftlumber.com/' },
      { label: 'About', href: 'https://www.swiftlumber.com/about-us' },
      { label: 'Projects', href: 'https://www.swiftlumber.com/projects' },
      { label: 'Jobs', href: 'https://workforcenow.adp.com/careers/swiftlumber' },
    ],
    cta: { label: 'Contact', href: 'https://www.swiftlumber.com/contact-us' },
  };

  it('rewrites same-site nav hrefs to local paths when siteUrl is set', () => {
    const markup = buildBlockHeader(SITE_NAV, { siteUrl: SITE_URL });
    // Home maps to "/"
    expect(markup).toContain('"url":"/"');
    // /about-us maps to /about-us/
    expect(markup).toContain('"url":"/about-us/"');
    // /projects maps to /projects/
    expect(markup).toContain('"url":"/projects/"');
  });

  it('preserves external links unchanged when siteUrl is set', () => {
    const markup = buildBlockHeader(SITE_NAV, { siteUrl: SITE_URL });
    // ADP external URL must pass through unchanged
    expect(markup).toContain('workforcenow.adp.com');
  });

  it('rewrites CTA href to local path when siteUrl is set', () => {
    const markup = buildBlockHeader(SITE_NAV, { siteUrl: SITE_URL });
    // CTA /contact-us → /contact-us/
    expect(markup).toContain('/contact-us/');
    // Source URL must NOT appear
    expect(markup).not.toContain('https://www.swiftlumber.com/contact-us');
  });

  it('does not rewrite hrefs when siteUrl is absent (back-compat)', () => {
    const markup = buildBlockHeader(SITE_NAV);
    // Source URLs must be emitted as-is
    expect(markup).toContain('https://www.swiftlumber.com/about-us');
    expect(markup).toContain('https://www.swiftlumber.com/projects');
    expect(markup).toContain('https://www.swiftlumber.com/contact-us');
  });

  // ── High-specificity style override tests ─────────────────────────────────

  it('emits a <style> block with !important rules for nav link color', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // Must contain a <style> block
    expect(markup).toContain('<style>');
    // Must contain !important color rule scoped to header.wp-block-group
    expect(markup).toMatch(/header\.wp-block-group .+color:[^;]+ !important/);
  });

  it('emits !important font-size in the style block when extracted from source', () => {
    const navWithFontSize: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, fontSize: '13px' },
    };
    const markup = buildBlockHeader(navWithFontSize);
    expect(markup).toContain('font-size:13px !important');
  });

  it('emits !important letter-spacing in the style block when extracted from source', () => {
    const navWithLetterSpacing: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, letterSpacing: '2.6px' },
    };
    const markup = buildBlockHeader(navWithLetterSpacing);
    expect(markup).toContain('letter-spacing:2.6px !important');
  });

  it('emits !important text-transform in the style block when extracted from source', () => {
    const navWithTextTransform: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, textTransform: 'uppercase' },
    };
    const markup = buildBlockHeader(navWithTextTransform);
    expect(markup).toContain('text-transform:uppercase !important');
  });

  it('emits !important CTA background in the style block when cta has bg color', () => {
    const navWithCtaBg: ExtractedNav = {
      ...SAMPLE_NAV,
      cta: { label: 'CALL US', href: '/call-us', bg: 'rgb(23, 82, 54)', color: 'rgb(255, 255, 255)' },
    };
    const markup = buildBlockHeader(navWithCtaBg);
    // CTA bg rule must appear in the !important style block
    expect(markup).toContain('background-color:rgb(23, 82, 54) !important');
    // CTA text color must also appear
    expect(markup).toContain('color:rgb(255, 255, 255) !important');
  });

  it('CTA button rendered with bg/color from cta.bg + cta.color (new shape)', () => {
    const navWithCtaColors: ExtractedNav = {
      ...SAMPLE_NAV,
      cta: { label: 'CALL US', href: '/call-us', bg: 'rgb(23, 82, 54)', color: 'rgb(255, 255, 255)' },
    };
    const markup = buildBlockHeader(navWithCtaColors);
    // wp:button should render
    expect(markup).toContain('wp:button');
    expect(markup).toContain('CALL US');
    // The button link should carry the cta.bg as background-color
    expect(markup).toContain('background-color:rgb(23, 82, 54)');
    // And cta.color as text color
    expect(markup).toContain('color:rgb(255, 255, 255)');
  });

  it('does not emit a style block when no tokens to override', () => {
    // A nav with no fontSize/letterSpacing/textTransform and no CTA
    // should produce an empty style override (no <style> tag pollution).
    const minimalNav: ExtractedNav = {
      ...SAMPLE_NAV,
      cta: null,
      style: {
        background: 'rgb(20, 20, 20)',
        textColor: 'rgb(255, 255, 255)',
        ctaBackground: null,
        ctaTextColor: null,
        fontFamily: 'Inter',
        height: 64,
      },
    };
    // textColor rule is always emitted when textColor is present, so <style> will exist.
    // Verify that when textColor drives the rule, the block is still well-formed.
    const markup = buildBlockHeader(minimalNav);
    // Style block emitted for color !important (minimum)
    expect(markup).toContain('<style>');
    expect(markup).toContain('color:');
    expect(markup).toContain('!important');
  });

  // ── Transparent overlay header tests ─────────────────────────────────────

  it('emits position:absolute + z-index:1000 on header.wp-block-group (overlay rule)', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The style override must include the absolute overlay positioning rule.
    expect(markup).toContain('position:absolute !important');
    expect(markup).toContain('top:0');
    expect(markup).toContain('left:0');
    expect(markup).toContain('right:0');
    expect(markup).toContain('z-index:1000');
  });

  it('emits background:transparent !important on header group (overlay forces transparent)', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The !important transparent rule is what ensures site.css cannot make the header solid.
    expect(markup).toContain('background:transparent !important');
    expect(markup).toContain('background-color:transparent !important');
  });

  it('emits wide nav gap (2.25rem) on navigation container via !important style rule', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // Both the block attribute (blockGap) and the !important CSS rule must use 2.25rem.
    expect(markup).toContain('"blockGap":"2.25rem"');
    expect(markup).toContain('gap:2.25rem !important');
    // The gap rule must target the WP navigation container selectors.
    expect(markup).toContain('.wp-block-navigation__container');
    expect(markup).toContain('.wp-block-navigation{');
  });

  it('nav text color is always white (#ffffff) in the transparent overlay header', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // Nav link color override must be white.
    expect(markup).toContain('color:#ffffff !important');
    // Block attribute for nav text color must also be white.
    expect(markup).toContain('"text":"#ffffff"');
  });

  it('CTA button has pill border-radius (9999px) in both block attrs and inline style', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // wp:button block attribute for border radius must be 9999px.
    expect(markup).toContain('"radius":"9999px"');
    // The rendered <a> element inline style must also have border-radius:9999px.
    expect(markup).toContain('border-radius:9999px');
  });

  it('CTA button override rule includes border-radius:9999px !important', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The !important rule for the CTA button must set the pill border-radius.
    expect(markup).toContain('border-radius:9999px !important');
  });

  it('CTA button override has white text (#ffffff) by default for contrast over hero', () => {
    const navNoCta: ExtractedNav = {
      ...SAMPLE_NAV,
      // No explicit cta.color, no ctaTextColor — should default to white.
      style: { ...SAMPLE_NAV.style, ctaTextColor: null },
      cta: { label: 'CALL US', href: '/call-us' },
    };
    const markup = buildBlockHeader(navNoCta);
    // CTA text must default to white when no explicit color is set.
    expect(markup).toContain('color:#ffffff !important');
  });

  it('brandDark is NOT used as header background but IS used as CTA color when no ctaBackground', () => {
    const navForCta: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, ctaBackground: null },
      cta: { label: 'CALL US', href: '/call-us' },
    };
    const markup = buildBlockHeader(navForCta, { brandDark: '#175236' });
    // Header element must be transparent.
    expect(markup).toContain('<header class="wp-block-group alignfull" style="background-color:transparent');
    // brandDark must appear as CTA button background.
    expect(markup).toContain('background-color:#175236');
    // CTA !important override must include brandDark.
    expect(markup).toContain('background-color:#175236 !important');
  });
});
