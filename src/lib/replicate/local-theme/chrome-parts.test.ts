// src/lib/replicate/local-theme/chrome-parts.test.ts
import { describe, it, expect } from 'vitest';
import { buildHeaderPart, buildFooterPart } from './chrome-parts.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';
import type { NavLink, Section } from '../local-site/types.js';

const NAV: NavLink[] = [
  { fromSlug: 'home', toSlug: 'about', label: 'About' },
  { fromSlug: 'home', toSlug: 'contact', label: 'Contact' },
  { fromSlug: 'home', toSlug: 'about', label: 'About (dupe)' },
  { fromSlug: 'about', toSlug: 'home', label: 'Home' },
];

describe('buildHeaderPart', () => {
  it('emits site-title + core/navigation with deduped links from the home page', () => {
    const html = buildHeaderPart('Acme Co', NAV, ['home', 'about', 'contact']);
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
    expect(html).toContain('<!-- wp:site-title');
    expect(html).toContain('<!-- wp:navigation');
    // home-page edges only, deduped by target, first label wins:
    expect(html).toContain('{"label":"About","url":"/about/"}');
    expect(html).toContain('{"label":"Contact","url":"/contact/"}');
    expect(html).not.toContain('About (dupe)');
    expect(html).not.toContain('{"label":"Home"');
  });

  it('falls back to one link per page (skipping home) when home has no outgoing links', () => {
    const html = buildHeaderPart('Acme Co', [], ['home', 'about']);
    expect(html).toContain('{"label":"About","url":"/about/"}');
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
  });

  it('escapes the home link to "/"', () => {
    const nav: NavLink[] = [{ fromSlug: 'home', toSlug: 'home', label: 'Home' }];
    const html = buildHeaderPart('Acme Co', nav, ['home']);
    expect(html).toContain('{"label":"Home","url":"/"}');
  });

  it('sanitizes labels that contain --> (would break block comment boundary)', () => {
    const nav: NavLink[] = [{ fromSlug: 'home', toSlug: 'faq', label: 'FAQ-->Answers' }];
    const html = buildHeaderPart('Acme Co', nav, ['home', 'faq']);
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
    expect(html).not.toContain('FAQ-->Answers');
  });

  it('title-cases hyphenated slugs in the fallback nav', () => {
    const html = buildHeaderPart('Acme Co', [], ['home', 'about-us']);
    expect(html).toContain('{"label":"About Us","url":"/about-us/"}');
  });
});

describe('buildFooterPart', () => {
  it('renders the captured footer section as blocks', () => {
    const footer: Section = { id: 'footer', role: 'footer', html: '<footer><p>All rights reserved</p></footer>' };
    const html = buildFooterPart(footer, 'Acme Co');
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
    expect(html).toContain('All rights reserved');
  });

  it('emits footer direct children as separate blocks (not one merged blob)', () => {
    const footer: Section = { id: 'footer', role: 'footer', html: '<footer><p>Copyright 2024 Acme</p><p>All rights reserved</p></footer>' };
    const html = buildFooterPart(footer, 'Acme Co');
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
    expect(html).toContain('Copyright 2024 Acme');
    expect(html).toContain('All rights reserved');
    expect((html.match(/<!-- wp:paragraph -->/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('emits a minimal default footer when no footer section exists', () => {
    const html = buildFooterPart(null, 'Acme Co');
    expect(blockMarkupRoundtrips(html).ok).toBe(true);
    expect(html).toContain('Acme Co');
  });
});
