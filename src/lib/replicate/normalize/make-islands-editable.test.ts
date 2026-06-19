import { describe, it, expect } from 'vitest';
import { makeIslandsEditable } from './make-islands-editable.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';

describe('makeIslandsEditable', () => {
  it('converts a core/html island with text into dla/editable-html', () => {
    const input =
      '<!-- wp:group -->\n<div class="wp-block-group ticket-footer"><!-- wp:html -->\n<p>Body text</p>\n<!-- /wp:html --></div>\n<!-- /wp:group -->';
    const { content, converted } = makeIslandsEditable(input);
    expect(converted).toBe(1);
    expect(content).toContain('<!-- wp:dla/editable-html ');
    expect(content).not.toContain('<!-- wp:html -->');
    // siblings/structure preserved
    expect(content).toContain('class="wp-block-group ticket-footer"');
    expect(blockMarkupRoundtrips(content).ok).toBe(true);
  });

  it('leaves a textless (svg-only) core/html island as core/html', () => {
    const input = '<!-- wp:html -->\n<span class="icon"><svg><path d="M0 0"/></svg></span>\n<!-- /wp:html -->';
    const { content, converted } = makeIslandsEditable(input);
    expect(converted).toBe(0);
    expect(content).toBe(input);
  });

  it('does not touch non-html blocks', () => {
    const input = '<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph -->';
    expect(makeIslandsEditable(input).content).toBe(input);
  });

  it('preserves literal dollar replacement tokens in converted core/html islands', () => {
    const input = '<!-- wp:html -->\n<p>Literal $$, $&amp;, $`, and $&#39; tokens</p>\n<!-- /wp:html -->';
    const { content, converted } = makeIslandsEditable(input);

    expect(converted).toBe(1);
    expect(content).toContain('"html":"Literal $$, $&amp;, $`, and $&#39; tokens"');
    expect(content).toContain('<p>Literal $$, $&amp;, $`, and $&#39; tokens</p>');
    expect(content).not.toContain('<!-- wp:html -->');
    expect(blockMarkupRoundtrips(content).ok).toBe(true);
  });
});
