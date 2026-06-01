import { describe, it, expect } from 'vitest';
import { scopeCss } from './css-scope.js';

describe('scopeCss — selectors', () => {
  it('prefixes a plain class selector with the scope', () => {
    const out = scopeCss('.hero { color: red }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site .hero');
  });

  it('prefixes each selector in a comma list', () => {
    const out = scopeCss('.a, .b { color: red }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site .a');
    expect(out).toContain('body.lib-alt-site .b');
  });

  it('folds html/body/:root onto the scope instead of nesting under it', () => {
    const out = scopeCss('body { margin: 0 } :root { --x: 1px }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site {');
    expect(out).not.toContain('body.lib-alt-site body');
    expect(out).toContain('--x: 1px');
  });
});

describe('scopeCss — at-rules', () => {
  it('preserves @media and scopes its inner rules', () => {
    const out = scopeCss('@media (max-width: 600px){ .hero { color: red } }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('@media (max-width: 600px)');
    expect(out).toContain('body.lib-alt-site .hero');
  });

  it('namespaces @keyframes and updates animation references', () => {
    const css = '@keyframes spin { from {opacity:0} to {opacity:1} } .x { animation: spin 1s }';
    const out = scopeCss(css, { scope: 'body.lib-alt-site', scopeId: 'p1' });
    expect(out).toContain('@keyframes spin__p1');
    expect(out).toContain('animation: spin__p1 1s');
  });

  it('rewrites url() via rewriteUrl', () => {
    const out = scopeCss('.x { background: url(/a.png) }', {
      scope: 'body.lib-alt-site',
      rewriteUrl: (u) => (u === '/a.png' ? '/wp/up/a.png' : null),
    });
    expect(out).toContain('url(/wp/up/a.png)');
  });
});

describe('scopeCss — combined-root + edge selectors', () => {
  it('folds :root combined with a class onto the scope', () => {
    const out = scopeCss(':root.dark { color: white }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site.dark');
    // .dark must not be orphaned as its own selector: no leading combinator (space, >, ~, +) or
    // comma directly before it. It is only legal glued onto the scope (…lib-alt-site.dark).
    expect(out).not.toMatch(/(?:^|[\s,>~+])\.dark\s*\{/);
  });

  it('folds :root:not(...) onto the scope', () => {
    const out = scopeCss(':root:not(.x) { color: white }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site:not(.x)');
  });

  it('preserves a child combinator after body', () => {
    const out = scopeCss('body > .x { color: red }', { scope: 'body.lib-alt-site' });
    expect(out).toContain('body.lib-alt-site > .x');
  });

  it('returns empty string for empty CSS without throwing', () => {
    expect(scopeCss('', { scope: 'body.lib-alt-site' })).toBe('');
  });

  it('leaves no un-renamed animation reference after keyframe namespacing', () => {
    const css = '@keyframes spin { from {opacity:0} to {opacity:1} } .x { animation: spin 1s }';
    const out = scopeCss(css, { scope: 'body.lib-alt-site', scopeId: 'p1' });
    expect(out).not.toContain('animation: spin 1s');
  });
});
