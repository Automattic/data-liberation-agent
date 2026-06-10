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
});
