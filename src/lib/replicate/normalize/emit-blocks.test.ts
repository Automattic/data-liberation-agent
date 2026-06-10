// src/lib/replicate/normalize/emit-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { emitSectionBlocks, escapeHtml } from './emit-blocks.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<script>a & b</script>')).toBe('&lt;script&gt;a &amp; b&lt;/script&gt;');
  });
});

describe('emitSectionBlocks', () => {
  it('emits a group of core blocks that round-trips', () => {
    const section = {
      id: 'hero',
      role: 'body' as const,
      html: '<section><h1>Welcome</h1><p>Hello there</p><a class="button" href="/x.html">Go</a></section>',
    };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
    expect(markup).toContain('<!-- wp:heading');
    expect(markup).toContain('<h1>Welcome</h1>');
    expect(markup).toContain('<!-- wp:paragraph');
    expect(markup).toContain('<!-- wp:buttons');
    expect(confidence).toBe(1);
  });

  it('does not inject raw script tags from text content', () => {
    // cheerio .text() on <p><script>x</script></p> returns "x" (strips tags).
    // So no <script> tag survives into output, and escapeHtml has nothing to
    // escape — the paragraph renders as <p>x</p>.
    // DEVIATION from plan: plan asserted toContain('&lt;script&gt;') but
    // cheerio strips the script element, returning only its text child "x".
    // Correct intent: raw <script>x</script> never appears in the markup.
    const section = { id: 's', role: 'body' as const, html: '<section><p><script>x</script></p></section>' };
    const { markup } = emitSectionBlocks(section);
    expect(markup).not.toContain('<script>x</script>');
    expect(markup).toContain('<p>x</p>');
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('flags confidence < 1 when an unrecognized child is downgraded to a paragraph', () => {
    const section = { id: 's', role: 'body' as const, html: '<section><figure>weird</figure></section>' };
    const { confidence } = emitSectionBlocks(section);
    expect(confidence).toBeLessThan(1);
  });
});
