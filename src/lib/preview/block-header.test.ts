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
});
