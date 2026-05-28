import { describe, it, expect } from 'vitest';
import { buildHtmlFallbackBlock } from './html-fallback.js';
import { scanForInjection } from './validate-artifacts.js';
import { buildInternalLinkMap } from '../streaming/internal-link-rewrite.js';

describe('buildHtmlFallbackBlock', () => {
  it('wraps the sanitized section in a core/html block', () => {
    const out = buildHtmlFallbackBlock('<section><h2>Our story</h2></section>', {});
    expect(out.startsWith('<!-- wp:html -->')).toBe(true);
    expect(out.trimEnd().endsWith('<!-- /wp:html -->')).toBe(true);
    expect(out).toContain('<h2>Our story</h2>');
  });

  it('strips <script>, <style>, inline on*= handlers, and <?php so it passes the injection gate', () => {
    const dirty =
      '<section onload="track()">' +
      '<script>evil()</script>' +
      '<style>.x{color:red}</style>' +
      '<img src="/u/a.jpg" onerror="steal()"/>' +
      '<?php echo "x"; ?>' +
      '<p>Real copy</p>' +
      '</section>';
    const out = buildHtmlFallbackBlock(dirty, {});
    expect(scanForInjection(out)).toEqual([]);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/on\w+\s*=/i);
    expect(out).not.toContain('<?php');
    // Real content survives.
    expect(out).toContain('<p>Real copy</p>');
    expect(out).toContain('<img src="/u/a.jpg"');
  });

  it('rewrites source media URLs to local upload URLs', () => {
    const mediaUrlMap = new Map([['https://cdn.example.test/a.jpg', '/wp-content/uploads/a.jpg']]);
    const out = buildHtmlFallbackBlock('<img src="https://cdn.example.test/a.jpg"/>', { mediaUrlMap });
    expect(out).toContain('src="/wp-content/uploads/a.jpg"');
    expect(out).not.toContain('cdn.example.test');
  });

  it('rewrites internal page links via the #2 link map', () => {
    const linkMap = buildInternalLinkMap([{ from: '/about', to: '/about/' }], { siteOrigins: ['example.test'] });
    const out = buildHtmlFallbackBlock('<a href="/about">About</a>', { linkMap });
    expect(out).toContain('href="/about/"');
  });
});
