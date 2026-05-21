import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { extractNav, NAV_EXTRACT_FACTORY_SOURCE } from './nav-extract.js';
import type { ExtractedNav } from './nav-extract.js';

// Fixture: a realistic header with logo img, 4 nav links, a button-styled CTA.
const FIXTURE_HEADER = `<!DOCTYPE html><html><head>
  <style>
    header { display: flex; width: 100%; height: 64px; background: rgb(30, 30, 30); align-items: center; padding: 0 24px; }
    nav { display: flex; gap: 24px; }
    nav a { color: rgb(255, 255, 255); text-decoration: none; font-family: 'Inter'; }
    .cta-btn { background: rgb(0, 122, 255); color: rgb(255, 255, 255); border-radius: 6px; padding: 8px 16px; text-decoration: none; font-family: 'Inter'; }
    img { height: 40px; }
    main { padding: 40px; }
    footer { height: 60px; background: #111; }
  </style>
</head><body style="margin:0">
  <header>
    <img src="https://example.com/logo.svg" alt="Acme Corp">
    <nav>
      <a href="/about">About</a>
      <a href="/services">Services</a>
      <a href="/portfolio">Portfolio</a>
      <a href="/blog">Blog</a>
    </nav>
    <a href="/contact" class="cta-btn">Contact Us</a>
  </header>
  <main><h1>Welcome</h1><p>Lorem ipsum dolor sit amet consectetur adipiscing elit.</p></main>
  <footer><p>&copy; 2025 Acme Corp</p></footer>
</body></html>`;

// Fixture: header with no logo (site title only), no explicit CTA
const FIXTURE_NO_LOGO = `<!DOCTYPE html><html><head>
  <style>
    header { display: flex; width: 100%; height: 56px; background: rgb(255, 255, 255); align-items: center; padding: 0 24px; }
    a { color: rgb(20, 20, 20); font-family: Georgia, serif; }
    main { padding: 40px; }
    footer { height: 40px; background: #eee; }
  </style>
</head><body style="margin:0">
  <header>
    <a href="/" style="font-weight:bold;font-size:1.5rem">My Site</a>
    <nav>
      <a href="/about">About</a>
      <a href="/work">Work</a>
      <a href="/contact">Contact</a>
    </nav>
  </header>
  <main><h1>Hello</h1><p>Content here that is long enough to pass size checks in other tests.</p></main>
  <footer><p>Footer here</p></footer>
</body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

/** Run extractNav inside the browser against a given fixture, returning ExtractedNav. */
async function runExtractNav(fixture: string): Promise<ExtractedNav | null> {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const navFactorySrc = NAV_EXTRACT_FACTORY_SOURCE.factorySrc;
    return await page.evaluate(({ navFactorySrc }: { navFactorySrc: string }) => {
      // eslint-disable-next-line no-new-func
      const { extractNav } = (new Function('return (' + navFactorySrc + ')')()() as {
        extractNav: (el: Element) => ExtractedNav;
      });
      const header = document.querySelector('header, [role="banner"]');
      if (!header) return null;
      return extractNav(header);
    }, { navFactorySrc });
  } finally {
    await page.close();
  }
}

describe('extractNav (browser fixture)', () => {
  it('extracts logo src, alt, and 4 nav items from the fixture header', async () => {
    const nav = await runExtractNav(FIXTURE_HEADER);
    expect(nav).not.toBeNull();
    expect(nav!.logoSrc).toBe('https://example.com/logo.svg');
    expect(nav!.logoAlt).toBe('Acme Corp');
    expect(nav!.items).toHaveLength(4);
    expect(nav!.items[0]).toEqual({ label: 'About', href: '/about' });
    expect(nav!.items[1]).toEqual({ label: 'Services', href: '/services' });
    expect(nav!.items[2]).toEqual({ label: 'Portfolio', href: '/portfolio' });
    expect(nav!.items[3]).toEqual({ label: 'Blog', href: '/blog' });
  });

  it('detects the button-styled CTA link separately from nav items', async () => {
    const nav = await runExtractNav(FIXTURE_HEADER);
    expect(nav).not.toBeNull();
    expect(nav!.cta).not.toBeNull();
    expect(nav!.cta!.label).toBe('Contact Us');
    expect(nav!.cta!.href).toBe('/contact');
    // CTA should NOT also appear in items
    expect(nav!.items.every((item) => item.label !== 'Contact Us')).toBe(true);
  });

  it('captures style tokens: background, textColor, fontFamily, height', async () => {
    const nav = await runExtractNav(FIXTURE_HEADER);
    expect(nav).not.toBeNull();
    // Background = rgb(30, 30, 30) from header CSS
    expect(nav!.style.background).toMatch(/rgb\(30,\s*30,\s*30\)/);
    // textColor from nav <a> = rgb(255, 255, 255)
    expect(nav!.style.textColor).toMatch(/rgb\(255,\s*255,\s*255\)/);
    // fontFamily = Inter (first family from the stack)
    expect(nav!.style.fontFamily.toLowerCase()).toContain('inter');
    // height = 64px
    expect(nav!.style.height).toBeGreaterThan(0);
    // CTA colors extracted
    expect(nav!.style.ctaBackground).toMatch(/rgb\(0,\s*122,\s*255\)/);
    expect(nav!.style.ctaTextColor).toMatch(/rgb\(255,\s*255,\s*255\)/);
  });

  it('falls back to siteTitle when no logo img present', async () => {
    const nav = await runExtractNav(FIXTURE_NO_LOGO);
    expect(nav).not.toBeNull();
    expect(nav!.logoSrc).toBeNull();
    expect(nav!.siteTitle).toBeTruthy();
    // 3 nav items
    expect(nav!.items).toHaveLength(3);
    expect(nav!.items.some((i) => i.label === 'About')).toBe(true);
    // No CTA (no button-styled link)
    expect(nav!.cta).toBeNull();
  });

  it('skips pure # anchors and dedupes label+href', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!DOCTYPE html><html><head>
  <style>header{display:flex;width:100%;height:60px;background:#fff;}nav a{color:#000;}</style>
</head><body>
  <header>
    <nav>
      <a href="#">Skip me</a>
      <a href="/page1">Page 1</a>
      <a href="/page1">Page 1</a>
      <a href="/page2">Page 2</a>
    </nav>
  </header>
  <main><p>content here content here content here content here content here</p></main>
  <footer><p>footer</p></footer>
</body></html>`);
      const navFactorySrc = NAV_EXTRACT_FACTORY_SOURCE.factorySrc;
      const nav = await page.evaluate(({ navFactorySrc }: { navFactorySrc: string }) => {
        // eslint-disable-next-line no-new-func
        const { extractNav } = (new Function('return (' + navFactorySrc + ')')()() as { extractNav: (el: Element) => ExtractedNav });
        const header = document.querySelector('header');
        return header ? extractNav(header) : null;
      }, { navFactorySrc });
      expect(nav).not.toBeNull();
      // # link skipped; page1 deduped to 1
      expect(nav!.items).toHaveLength(2);
      expect(nav!.items[0].label).toBe('Page 1');
      expect(nav!.items[1].label).toBe('Page 2');
      expect(nav!.items.some((i) => i.label === 'Skip me')).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('caps nav items at 8', async () => {
    const page = await browser.newPage();
    try {
      const links = Array.from({ length: 12 }, (_, i) => `<a href="/page${i}">Page ${i}</a>`).join('\n');
      await page.setContent(`<!DOCTYPE html><html><head>
  <style>header{display:flex;width:100%;height:60px;background:#fff;}nav a{color:#000;}</style>
</head><body><header><nav>${links}</nav></header><main><p>body</p></main><footer><p>ft</p></footer></body></html>`);
      const navFactorySrc = NAV_EXTRACT_FACTORY_SOURCE.factorySrc;
      const nav = await page.evaluate(({ navFactorySrc }: { navFactorySrc: string }) => {
        // eslint-disable-next-line no-new-func
        const { extractNav } = (new Function('return (' + navFactorySrc + ')')()() as { extractNav: (el: Element) => ExtractedNav });
        const header = document.querySelector('header');
        return header ? extractNav(header) : null;
      }, { navFactorySrc });
      expect(nav).not.toBeNull();
      expect(nav!.items.length).toBeLessThanOrEqual(8);
    } finally {
      await page.close();
    }
  });
});

describe('extractNav (Node unit test via source string)', () => {
  it('NAV_EXTRACT_FACTORY_SOURCE.factorySrc is a non-empty string', () => {
    expect(typeof NAV_EXTRACT_FACTORY_SOURCE.factorySrc).toBe('string');
    expect(NAV_EXTRACT_FACTORY_SOURCE.factorySrc.length).toBeGreaterThan(0);
    expect(NAV_EXTRACT_FACTORY_SOURCE.factorySrc).toContain('extractNav');
  });

  it('extractNav function is exported and callable', () => {
    // Smoke test: the function exists and is callable (node does not have DOM so
    // we just verify the export shape, not browser behavior)
    expect(typeof extractNav).toBe('function');
  });
});
