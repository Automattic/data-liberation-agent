import { describe, it, expect } from 'vitest';
import { genericBlockCatalog } from './generic-block-catalog.js';
import { validateBlockMarkup } from './validate-block-markup.js';

const run = (html: string) => genericBlockCatalog.htmlToBlocks!(html, { url: 'https://x.test/p' });

describe('generic-block-catalog: guards', () => {
  it('returns null when no known wrapper is present (lets caller own it)', () => {
    expect(run('<p>just a paragraph</p><h2>and a heading</h2>')).toBeNull();
  });

  it('returns null on already-blockified input (idempotency guard)', () => {
    expect(run('<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->')).toBeNull();
  });

  it('emits valid block markup for a recognized wrapper', () => {
    const out = run('<details><summary>Q</summary><p>A</p></details>');
    expect(out).not.toBeNull();
    expect(validateBlockMarkup(out!)).toEqual([]);
  });
});

describe('generic-block-catalog: callout', () => {
  it('wraps a .callout in core/group, preserving the class and recursing inner', () => {
    const out = run('<div class="callout"><h3>Note</h3><p>body</p></div>');
    expect(out).not.toBeNull();
    expect(out!).toContain('<!-- wp:group');
    expect(out!).toContain('wp-block-group');
    expect(out!).toContain('callout');
    expect(validateBlockMarkup(out!)).toEqual([]);
  });
});

describe('generic-block-catalog: pullquote', () => {
  it('converts blockquote.pullquote to core/pullquote', () => {
    const out = run('<blockquote class="pullquote"><p>Big idea</p><cite>Me</cite></blockquote>');
    expect(out).not.toBeNull();
    expect(out!).toContain('<!-- wp:pullquote -->');
    expect(out!).toContain('Big idea');
    expect(validateBlockMarkup(out!)).toEqual([]);
  });
});

describe('generic-block-catalog: buttons', () => {
  it('converts a wrapper of button links to core/buttons', () => {
    const out = run('<div class="btn-group"><a class="button" href="/x">Go</a><a class="btn" href="/y">More</a></div>');
    expect(out).not.toBeNull();
    expect(out!).toContain('<!-- wp:buttons -->');
    expect(out!).toContain('<!-- wp:button -->');
    expect(out!).toContain('href="/x"');
    expect(validateBlockMarkup(out!)).toEqual([]);
  });

  it('converts a single standalone button link', () => {
    const out = run('<a class="button" href="/x">Go</a>');
    expect(out).not.toBeNull();
    expect(out!).toContain('<!-- wp:buttons -->');
  });
});

describe('generic-block-catalog: media-text', () => {
  it('converts an image + adjacent text wrapper to core/media-text', () => {
    const out = run(
      '<div class="media-text"><figure><img src="https://cdn.test/a.jpg" alt="A"/></figure><div><h3>Title</h3><p>copy</p></div></div>',
    );
    expect(out).not.toBeNull();
    expect(out!).toContain('<!-- wp:media-text');
    expect(out!).toContain('https://cdn.test/a.jpg');
    expect(out!).toContain('Title');
    expect(validateBlockMarkup(out!)).toEqual([]);
  });

  it('rewrites the image src via ctx.mediaMap', () => {
    const out = genericBlockCatalog.htmlToBlocks!(
      '<div class="media-text"><img src="https://cdn.test/a.jpg" alt="A"/><div><p>copy</p></div></div>',
      { url: 'https://x.test/p', mediaMap: { 'https://cdn.test/a.jpg': '/wp-content/uploads/a.jpg' } },
    );
    expect(out!).toContain('/wp-content/uploads/a.jpg');
    expect(out!).not.toContain('cdn.test');
  });
});

describe('generic-block-catalog: lossless mixed content', () => {
  it('converts known wrappers and keeps unknown siblings as core/html islands', () => {
    const html =
      '<details><summary>Q</summary><p>A</p></details>' +
      '<div class="weird-widget" data-x="1"><span>keep me</span></div>';
    const out = run(html)!;
    expect(out).toContain('<!-- wp:details -->');
    expect(out).toContain('<!-- wp:html -->'); // the unknown widget survives losslessly
    expect(out).toContain('keep me');
    expect(validateBlockMarkup(out)).toEqual([]);
  });

  it('is idempotent: re-running over its own output is a no-op (null)', () => {
    const once = run('<details><summary>Q</summary><p>A</p></details>')!;
    expect(run(once)).toBeNull();
  });
});
