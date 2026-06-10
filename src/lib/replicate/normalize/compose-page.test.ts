// src/lib/replicate/normalize/compose-page.test.ts
import { describe, it, expect } from 'vitest';
import { composePage } from './compose-page.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';
import type { LocalPage } from '../local-site/types.js';

const page: LocalPage = {
  relPath: 'index.html',
  slug: 'home',
  title: 'Home',
  html: '<body><main><section id="hero"><h1>Hi</h1><p>Body</p></section><section id="cta"><p>More</p></section></main></body>',
};

describe('composePage', () => {
  it('produces round-tripping post content and a per-section report', () => {
    const { postContent, report } = composePage(page);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(report.map((r) => r.sectionId)).toEqual(['hero', 'cta']);
    expect(report.every((r) => r.confidence === 1)).toBe(true);
    expect(postContent).toContain('<h1>Hi</h1>');
  });

  it('returns empty content + empty report for a page with no body sections', () => {
    const empty: LocalPage = { ...page, html: '<body><main></main></body>' };
    const { postContent, report } = composePage(empty);
    expect(report).toEqual([]);
    expect(postContent).toBe('');
  });

  it('composes sections from a body without <main> (body > section wrappers)', () => {
    const noMain: LocalPage = {
      ...page,
      html: '<body><section id="alpha"><p>Alpha text</p></section><section id="beta"><p>Beta text</p></section></body>',
    };
    const { postContent, report } = composePage(noMain);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(report.map((r) => r.sectionId)).toEqual(['alpha', 'beta']);
    expect(postContent).toContain('Alpha text');
    expect(postContent).toContain('Beta text');
  });

  it('excludes chrome (header/footer) content from postContent in a chrome+body mix', () => {
    const mixed: LocalPage = {
      ...page,
      html:
        '<body><header><nav><a href="/">HeaderOnly</a></nav></header>' +
        '<section id="about"><h2>About</h2><p>BodyOnly</p></section>' +
        '<footer><p>FooterOnly</p></footer></body>',
    };
    const { postContent, report } = composePage(mixed);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(report.map((r) => r.sectionId)).toEqual(['about']);
    expect(postContent).toContain('BodyOnly');
    expect(postContent).not.toContain('HeaderOnly');
    expect(postContent).not.toContain('FooterOnly');
  });

  it('composes loose <main> content — each loose child becomes its own section', () => {
    const loose: LocalPage = {
      ...page,
      html: '<body><main><h1>Loose Heading</h1><p>Loose para</p></main></body>',
    };
    const { postContent, report } = composePage(loose);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(report).toHaveLength(2);
    expect(postContent).toContain('Loose Heading');
    expect(postContent).toContain('Loose para');
  });

  it('preserves mixed top-level children end-to-end (section + figure + heading)', () => {
    const mixed: LocalPage = {
      ...page,
      html:
        '<body><main><section id="intro"><p>Sec text</p></section>' +
        '<figure><img src="photo.jpg" alt="P"/></figure>' +
        '<h1>Page Title</h1></main></body>',
    };
    const { postContent, report } = composePage(mixed);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(report).toHaveLength(3);
    expect(postContent).toContain('Sec text');
    expect(postContent).toContain('photo.jpg');
    expect(postContent).toContain('Page Title');
  });

  it('preserves a loose text node end-to-end with escaping intact', () => {
    const withText: LocalPage = {
      ...page,
      html: '<body><main>Tom &amp; Jerry &lt;3 "quotes" here<section id="s"><p>x</p></section></main></body>',
    };
    const { postContent } = composePage(withText);
    expect(blockMarkupRoundtrips(postContent).ok).toBe(true);
    expect(postContent).toContain('Tom &amp; Jerry &lt;3 &quot;quotes&quot; here');
  });
});
