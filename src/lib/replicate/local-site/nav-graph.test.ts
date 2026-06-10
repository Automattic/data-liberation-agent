import { describe, it, expect } from 'vitest';
import { buildNavGraph } from './nav-graph.js';
import type { LocalSite } from './types.js';

function site(pages: Array<{ slug: string; relPath: string; html: string }>): LocalSite {
  return { root: '/x', pages: pages.map((p) => ({ ...p, title: p.slug })) };
}

describe('buildNavGraph', () => {
  it('records internal links by target slug and ignores external ones', () => {
    const s = site([
      { slug: 'home', relPath: 'index.html', html: '<a href="about.html">About</a><a href="https://x.com">Ext</a>' },
      { slug: 'about', relPath: 'about.html', html: '<a href="index.html">Home</a>' },
    ]);
    const links = buildNavGraph(s);
    expect(links).toContainEqual({ fromSlug: 'home', toSlug: 'about', label: 'About' });
    expect(links).toContainEqual({ fromSlug: 'about', toSlug: 'home', label: 'Home' });
    expect(links.some((l) => l.label === 'Ext')).toBe(false);
  });

  it('drops links to unknown targets', () => {
    const s = site([{ slug: 'home', relPath: 'index.html', html: '<a href="missing.html">X</a>' }]);
    expect(buildNavGraph(s)).toEqual([]);
  });
});
