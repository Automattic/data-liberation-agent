import { describe, it, expect } from 'vitest';
import { wrapFragment, scopeCss } from './design-transform.js';

describe('wrapFragment', () => {
  it('wraps in .dla-replica .dla-page-<slug> + body classes and sanitizes', () => {
    const out = wrapFragment('<h1>hi</h1><img src="x" onclick="evil()"><script>bad()</script>', 'about', ['home', 'dark']);
    expect(out).toMatch(/^<div class="dla-replica dla-page-about home dark">/);
    expect(out).toContain('<h1>hi</h1>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<script>');
  });
  it('handles empty body classes', () => {
    const out = wrapFragment('<p>x</p>', 'home', []);
    expect(out).toMatch(/^<div class="dla-replica dla-page-home">/);
  });
});

describe('scopeCss', () => {
  it('rewrites body/html selectors to .dla-replica, preserving descendants', () => {
    expect(scopeCss('body{margin:0}', 'about', false)).toBe('.dla-replica{margin:0}');
    expect(scopeCss('body .x{color:red}', 'about', false)).toBe('.dla-replica .x{color:red}');
    expect(scopeCss('html,body{font:1em}', 'about', false)).toContain('.dla-replica');
  });
  it('does NOT rewrite body inside class/id names', () => {
    expect(scopeCss('.bodywrap{color:red}', 'about', false)).toBe('.bodywrap{color:red}');
  });
  it('prefixes page-specific rules with .dla-page-<slug> when scopePage=true', () => {
    expect(scopeCss('.hero{color:red}', 'about', true)).toBe('.dla-page-about .hero{color:red}');
  });
});
