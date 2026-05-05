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
