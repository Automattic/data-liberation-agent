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
    expect(markup).toContain('<h1 class="wp-block-heading">Welcome</h1>');
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

  it('unwraps non-allowlisted inline wrappers, preserving nested links', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      html: '<section><p>Visit <span><a href="/shop.html">the shop</a></span> today</p></section>',
    };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('Visit <a href="/shop.html">the shop</a> today');
    expect(confidence).toBe(1);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('uses <main> as the container root (segmentPage main-fallback sections)', () => {
    const section = { id: 'm', role: 'body' as const, html: '<main><h1>T</h1><p>Body</p></main>' };
    const { markup, confidence } = emitSectionBlocks(section);
    expect(markup).toContain('<!-- wp:heading');
    expect(markup).toContain('<h1 class="wp-block-heading">T</h1>');
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
    expect(markup).toContain('<h3 class="wp-block-heading">Three</h3>');
    expect(markup).toContain('<h2 class="wp-block-heading">Two</h2>');
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

  it('preserves section id and classes on the group wrapper', () => {
    const section = {
      id: 'hero',
      role: 'body' as const,
      classes: ['hero', 'splash'],
      html: '<section id="hero" class="hero splash"><h1>Welcome</h1></section>',
    };
    const { markup } = emitSectionBlocks(section);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
    expect(markup).toContain('"className":"hero splash"');
    expect(markup).toContain('"anchor":"hero"');
    expect(markup).toContain('class="wp-block-group hero splash"');
    expect(markup).toContain('id="hero"');
  });

  it('preserves child element classes on emitted blocks', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      classes: [],
      html: '<section><h2 class="section-title">T</h2><p class="lede">x</p><img class="pic" src="a.png" alt=""/><ul class="list-x"><li>i</li></ul><a class="button cta" href="/x/">Go</a></section>',
    };
    const { markup } = emitSectionBlocks(section);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
    expect(markup).toContain('"className":"section-title"');
    expect(markup).toContain('class="wp-block-heading section-title"');
    expect(markup).toContain('"className":"lede"');
    expect(markup).toContain('"className":"pic"');
    expect(markup).toContain('"className":"list-x"');
    expect(markup).toContain('"className":"button cta"');     // on wp:button
    // Stage 1d: source classes ride the INNER anchor too — the source styles
    // a.button{…} directly, so carried CSS must match the real <a>. WP's own
    // classes stay first (serializer shape).
    expect(markup).toContain('class="wp-block-button__link wp-element-button button cta" href');
  });

  it('escapes double quotes in class attrs landing in HTML', () => {
    const section = {
      id: 's',
      role: 'body' as const,
      classes: [],
      html: `<section><p class='a"b'>x</p></section>`,
    };
    const { markup } = emitSectionBlocks(section);
    expect(markup).toContain('class="a&quot;b"');
    expect(markup).not.toContain('class="a"b"');
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  });

  it('keeps class on allowed inline tags', () => {
    const section = {
      id: 's', role: 'body' as const, classes: [],
      html: '<section><p>see <a class="inline-link" href="/a/">it</a> <strong class="hot">now</strong></p></section>',
    };
    const { markup } = emitSectionBlocks(section);
    expect(markup).toContain('<a class="inline-link" href="/a/">it</a>');
    expect(markup).toContain('<strong class="hot">now</strong>');
  });

  it('escapes -- in class names for block-comment safety', () => {
    const section = { id: 's', role: 'body' as const, classes: ['mod--wide'], html: '<section class="mod--wide"><p>x</p></section>' };
    const { markup } = emitSectionBlocks(section);
    expect(blockMarkupRoundtrips(markup).ok).toBe(true);
    expect(markup).toContain('\\u002d\\u002d');           // attr JSON escaped
    expect(markup).toContain('class="wp-block-group mod--wide"'); // literal in HTML (safe outside comments)
  });
});

it('emits the section wrapper as a semantic <section> with tagName attr (carry parity)', () => {
  const section = { id: 'hero', role: 'body' as const, classes: ['hero'], html: '<section id="hero" class="hero"><h1>Hi</h1></section>' };
  const { markup } = emitSectionBlocks(section);
  expect(markup).toContain('"tagName":"section"');
  expect(markup).toContain('<section id="hero" class="wp-block-group hero">');
  expect(markup).toContain('</section>');
  expect(blockMarkupRoundtrips(markup).ok).toBe(true);
});

it('emits source tables as core/table preserving rows, header, and class', () => {
  const section = {
    id: 'prices', role: 'body' as const, classes: [],
    html: '<section><table class="price-table"><tr><th>Service</th><th>Price</th></tr><tr><td>Quick Splash</td><td>45 clams</td></tr><tr><td>Glacier Glow</td><td>150 clams</td></tr></table></section>',
  };
  const { markup, confidence } = emitSectionBlocks(section);
  expect(blockMarkupRoundtrips(markup).ok).toBe(true);
  expect(markup).toContain('<!-- wp:table');
  expect(markup).toContain('"className":"price-table"');
  expect(markup).toContain('<thead><tr><th>Service</th><th>Price</th></tr></thead>');
  expect(markup).toContain('<td>Quick Splash</td><td>45 clams</td>');
  expect(markup).toContain('<td>Glacier Glow</td>');
  expect(markup).toContain('<figure class="price-table"><table>'); // classless of wp-block-table: block-library td/th rules would out-rank source element rules
  expect(confidence).toBe(1); // native mapping, no downgrade
});
