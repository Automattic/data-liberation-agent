import { describe, expect, it } from 'vitest';
import { extractThemeChromeFromHtml } from './source-chrome.js';

describe('extractThemeChromeFromHtml', () => {
  it('extracts source header logo and deduped navigation links', () => {
    const html = `
      <header class="wixui-header">
        <a href="https://example.com"><img src="/media/logo.png" alt="Example logo"></a>
        <nav aria-label="Site">
          <a href="https://example.com">HOME</a>
          <a href="https://example.com/products">PRODUCTS</a>
          <a href="https://example.com/products">PRODUCTS</a>
          <a href="https://jobs.example.com/posting">JOBS</a>
          <button>Menu</button>
        </nav>
      </header>
    `;

    const chrome = extractThemeChromeFromHtml(html, 'https://example.com/');

    expect(chrome.header?.logoUrl).toBe('https://example.com/media/logo.png');
    expect(chrome.header?.links).toEqual([
      { label: 'HOME', href: '/', external: false },
      { label: 'PRODUCTS', href: '/products', external: false },
      { label: 'JOBS', href: 'https://jobs.example.com/posting', external: true },
    ]);
  });

  it('captures only the top-level primary menu from a Shopify-style header', () => {
    // Mirrors getsnooz.com: an inline desktop menu with mega-menu sub-links,
    // a duplicate mobile drawer copy, social icons, and account/cart links.
    const html = `
      <header class="header">
        <header-drawer>
          <nav class="menu-drawer__navigation">
            <ul class="menu-drawer__menu">
              <li><a href="/pages/sleep-bundle">Bundle + Save</a></li>
              <li><a href="/pages/shop-all">Shop All</a></li>
            </ul>
          </nav>
        </header-drawer>
        <h1 class="header__heading"><a href="/" class="header__heading-link"><img src="//getsnooz.com/cdn/shop/files/SNOOZ-Logo-PNG.png?v=1" alt="SNOOZ"></a></h1>
        <nav class="header__inline-menu">
          <ul class="list-menu list-menu--inline">
            <li>
              <a href="/pages/shop-all"><span class="header__top-level-link">Shop</span></a>
              <ul class="mega-menu__list">
                <li><a href="/products/snooz-white-noise-machine">SNOOZ Original</a></li>
                <li><a href="/products/snooz-pro-white-noise-machine">SNOOZ Pro</a></li>
              </ul>
            </li>
            <li><a href="/pages/sleep-bundle"><span class="header__top-level-link">Bundle &amp; Save</span></a></li>
            <li><a href="/pages/about-us"><span class="header__top-level-link">About</span></a></li>
          </ul>
        </nav>
        <div class="header__icons">
          <a href="https://www.instagram.com/snooz/">Instagram</a>
          <a href="/customer_authentication/redirect">Log in</a>
          <a href="/cart">Cart</a>
        </div>
      </header>
    `;

    const chrome = extractThemeChromeFromHtml(html, 'https://getsnooz.com/');

    expect(chrome.header?.logoUrl).toBe('https://getsnooz.com/cdn/shop/files/SNOOZ-Logo-PNG.png?v=1');
    expect(chrome.header?.logoAlt).toBe('SNOOZ');
    // Exactly the three real top-level items — no mega-menu sublinks, no
    // drawer duplicate, no social/account/cart junk.
    expect(chrome.header?.links).toEqual([
      { label: 'Shop', href: '/pages/shop-all', external: false },
      { label: 'Bundle & Save', href: '/pages/sleep-bundle', external: false },
      { label: 'About', href: '/pages/about-us', external: false },
    ]);
    // White Shopify header → light tone (default).
    expect(chrome.header?.tone).toBe('light');
  });

  it('infers a dark header tone from a dark inline background', () => {
    const html = `
      <header style="background-color:#1a1a1a">
        <a href="/"><img src="/logo.png" alt="Brand logo"></a>
        <nav><ul><li><a href="/about">About</a></li></ul></nav>
      </header>
    `;
    const chrome = extractThemeChromeFromHtml(html, 'https://example.com/');
    expect(chrome.header?.tone).toBe('dark');
  });

  it('extracts footer text and links from the source footer', () => {
    const html = `
      <footer class="wixui-footer">
        <h4>Swift Lumber</h4>
        <p>1450 Swift Mill Rd, Atmore, AL</p>
        <p>251-446-4123</p>
        <nav>
          <a href="/privacy-policy">Privacy Policy</a>
          <a href="/accessibility-statement">Accessibility Statement</a>
        </nav>
      </footer>
    `;

    const chrome = extractThemeChromeFromHtml(html, 'https://www.swiftlumber.com/');

    expect(chrome.footer?.text).toContain('Swift Lumber');
    expect(chrome.footer?.text).toContain('1450 Swift Mill Rd, Atmore, AL');
    expect(chrome.footer?.links).toEqual([
      { label: 'Privacy Policy', href: '/privacy-policy', external: false },
      { label: 'Accessibility Statement', href: '/accessibility-statement', external: false },
    ]);
  });
});
