// src/lib/replicate/normalize/emit-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { emitSectionBlocks, escapeHtml } from './emit-blocks.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<script>a & b</script>')).toBe('&lt;script&gt;a &amp; b&lt;/script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
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

  it('emits core/image for a bare img child with escaped attributes', () => {
    const section = { id: 's', role: 'body' as const, html: '<section><img src="x.png" alt="A & B"></section>' };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:image');
    expect(markup).toContain('src="x.png"');
    expect(markup).toContain('alt="A &amp; B"');
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('prevents attribute breakout when src contains a double quote', () => {
    // Single-quoted source attr smuggles a double quote into the value.
    const section = {
      id: 's',
      role: 'body' as const,
      html: `<section><img src='x" onerror="alert(1)' alt=""></section>`,
    };
    const { markup } = emitSectionBlocks(section);
    expect(markup).toContain('&quot;');
    expect(markup).not.toContain('" onerror="');
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('rescues img descendants of an unknown wrapper instead of dropping them', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      html: '<section><figure><img src="pic.png"/><figcaption>Cap text</figcaption></figure></section>',
    };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:image');
    expect(markup).toContain('pic.png');
    expect(markup).toContain('Cap text');
    expect(confidence).toBeLessThan(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('preserves inline links and emphasis in paragraphs', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      html: '<section><p>Contact <a href="/contact.html">us</a> <strong>now</strong></p></section>',
    };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<a href="/contact.html">us</a>');
    expect(markup).toContain('<strong>now</strong>');
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('uses <main> as the container root (segmentPage main-fallback sections)', () => {
    const section = { id: 'm', role: 'body' as const, html: '<main><h1>T</h1><p>Body</p></main>' };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:heading');
    expect(markup).toContain('<h1>T</h1>');
    expect(markup).toContain('<p>Body</p>');
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('emits list shapes for ul and ol', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      html: '<section><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol></section>',
    };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:list -->');
    expect(markup).toContain('<!-- wp:list {"ordered":true} -->');
    expect(markup).toContain('<ul class="wp-block-list">');
    expect(markup).toContain('<ol class="wp-block-list">');
    expect((markup.match(/<!-- wp:list-item -->/g) ?? []).length).toBe(3);
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('emits level attr for non-h2 headings only', () => {
    const section = { id: 's', role: 'body' as const, html: '<section><h3>Three</h3><h2>Two</h2></section>' };
    const { markup } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:heading {"level":3} -->');
    expect(markup).toContain('<!-- wp:heading -->');
    expect(markup).toContain('<h3>Three</h3>');
    expect(markup).toContain('<h2>Two</h2>');
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('preserves loose text nodes at the section root as paragraphs', () => {
    const section = { id: 's', role: 'body' as const, html: '<section>Hello<p>x</p></section>' };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<p>Hello</p>');
    expect(markup).toContain('<p>x</p>');
    expect((markup.match(/<!-- wp:paragraph -->/g) ?? []).length).toBe(2);
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });
});
