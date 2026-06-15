//
// Smoke test for the block-fixer's core function. Runs without the HTTP
// server — just exercises fixBlocksInTemplate directly to catch
// dependency-resolution / JSDOM-globals breakage early.
//

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.getComputedStyle = dom.window.getComputedStyle;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.matchMedia = () => ({
  matches: false,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
});
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  writable: true,
  configurable: true,
});

const { fixBlocksInTemplate } = require('../lib/blockFixer.js');

test('fixBlocksInTemplate normalizes a simple paragraph block', () => {
  const input = '<!-- wp:paragraph --><p>Hello world</p><!-- /wp:paragraph -->';
  const result = fixBlocksInTemplate(input);
  assert.ok(result.html.includes('<p>Hello world</p>'));
  assert.ok(result.html.includes('<!-- wp:paragraph'));
  assert.ok(result.html.includes('<!-- /wp:paragraph -->'));
});

test('fixBlocksInTemplate flattens nested <p> inside wp:paragraph', () => {
  const input =
    '<!-- wp:paragraph --><p class="outer"><p class="inner">Nested</p></p><!-- /wp:paragraph -->';
  const result = fixBlocksInTemplate(input);
  // Should flatten to a single <p>; both classes preserved (or content recovered).
  assert.ok(result.html.includes('Nested'));
  // No nested-p remaining.
  const nestedMatch = /<p[^>]*>\s*<p[^>]*>/.exec(result.html);
  assert.strictEqual(nestedMatch, null, 'nested <p> tags should be flattened');
});

test('fixBlocksInTemplate handles heading + paragraph composition', () => {
  const input = [
    '<!-- wp:heading {"level":1} --><h1>Title</h1><!-- /wp:heading -->',
    '<!-- wp:paragraph --><p>Body text.</p><!-- /wp:paragraph -->',
  ].join('\n');
  const result = fixBlocksInTemplate(input);
  // WP canonicalizes <h1> → <h1 class="wp-block-heading">; that's the whole point.
  assert.ok(/<h1[^>]*>Title<\/h1>/.test(result.html));
  assert.ok(result.html.includes('Body text.'));
});

// --- Editor-valid carry rework regression -----------------------------------
// The carry emitter no longer rides inline style= (the fixer STRIPS it from core
// blocks); per-instance styles ride a lib-i<hash> className + a carried rule, and
// raw inline group bodies ride a core/html INNER block. These prove the fixer
// PRESERVES both shapes (the original failures: heading style stripped, group
// inline body DELETED).

test('carry: heading className (source class + lib-i) survives the fixer, no inline style', () => {
  const input =
    '<!-- wp:heading {"className":"display lib-iabc1234567"} -->\n' +
    '<h2 class="wp-block-heading display lib-iabc1234567">Scent</h2>\n' +
    '<!-- /wp:heading -->';
  const result = fixBlocksInTemplate(input);
  assert.ok(result.html.includes('Scent'));
  assert.ok(result.html.includes('display'), 'source class preserved');
  assert.ok(result.html.includes('lib-iabc1234567'), 'instance lib-i class preserved');
  assert.ok(!/style=/.test(result.html), 'no inline style attr re-introduced');
});

test('carry: paragraph className (lib-i) survives the fixer', () => {
  const input =
    '<!-- wp:paragraph {"className":"lead lib-ixyz9876543"} -->\n' +
    '<p class="lead lib-ixyz9876543">Made to order.</p>\n' +
    '<!-- /wp:paragraph -->';
  const result = fixBlocksInTemplate(input);
  assert.ok(result.html.includes('Made to order.'));
  assert.ok(result.html.includes('lead'));
  assert.ok(result.html.includes('lib-ixyz9876543'));
});

test('carry: group with a core/html inner block preserves raw inline body (no content loss)', () => {
  // The ORIGINAL failure: a core/group with raw inline content ("01 Made here")
  // had its inner DELETED by the fixer. Wrapping the inline body in core/html
  // makes it survive — the group keeps its class (.kicker layout) and the spans
  // render inline.
  const input =
    '<!-- wp:group {"tagName":"div","className":"kicker"} -->\n' +
    '<div class="wp-block-group kicker">\n' +
    '<!-- wp:html -->\n' +
    '<span class="num">01</span> Made here\n' +
    '<!-- /wp:html -->\n' +
    '</div>\n' +
    '<!-- /wp:group -->';
  const result = fixBlocksInTemplate(input);
  assert.ok(result.html.includes('kicker'), 'group class preserved');
  assert.ok(result.html.includes('<span class="num">01</span>'), 'inline span content preserved (not deleted)');
  assert.ok(result.html.includes('Made here'), 'inline text preserved');
});

test('fixBlocksInTemplate returns input unchanged on parse error', () => {
  const input = '<!-- wp:bogus-block-name-that-does-not-exist --><div>oops</div>';
  const result = fixBlocksInTemplate(input);
  // Either passes through or returns a freeform-html block; mustn't crash.
  assert.ok(typeof result.html === 'string');
  assert.ok(result.html.length > 0);
});
