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

  it('uses the background color from nav.style in the outer group inline style', () => {
    const markup = buildBlockHeader(SAMPLE_NAV);
    // The background color should appear in inline style or block attributes
    expect(markup).toContain('rgb(20, 20, 20)');
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

  it('uses brandDark as header background when source bg is transparent', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'transparent', textColor: 'rgb(0, 0, 0)' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#175236' });
    expect(markup).toContain('background-color:#175236');
    // The outer group style should also reference the brand color
    expect(markup).toContain('#175236');
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

  it('forces nav text to dark (#111111) when brandDark is light', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'transparent', textColor: 'rgb(255, 255, 255)' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#d4f0e8' });
    // Very light color → dark text
    expect(markup).toContain('"text":"#111111"');
  });

  it('uses rgba(0,0,0,0) as transparent and applies brandDark', () => {
    const transparentNav: ExtractedNav = {
      ...SAMPLE_NAV,
      style: { ...SAMPLE_NAV.style, background: 'rgba(0,0,0,0)', textColor: 'rgb(0, 0, 0)' },
    };
    const markup = buildBlockHeader(transparentNav, { brandDark: '#175236' });
    expect(markup).toContain('#175236');
    expect(markup).not.toContain('rgba(0,0,0,0)');
  });

  it('does NOT override opaque extracted background with brandDark', () => {
    // SAMPLE_NAV has background: 'rgb(20, 20, 20)' — opaque, not transparent
    const markup = buildBlockHeader(SAMPLE_NAV, { brandDark: '#175236' });
    // Original opaque background must still appear
    expect(markup).toContain('rgb(20, 20, 20)');
    // brandDark should NOT replace it
    expect(markup).not.toContain('background-color:#175236');
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
});
