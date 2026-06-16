import { describe, it, expect } from 'vitest';
import { discoverHtmlCards, structuralSignature } from './discover-html-cards.js';
import * as cheerio from 'cheerio';

// Deliberately weird, non-semantic class names so a class-keyed shortcut fails.
const MIXED_DEPTH_GRID = `
<main>
  <section class="zone-7">
    <div class="cluster">
      <article class="tile tile--big">
        <div class="thumb"><a href="story-1.html"><img src="a.png" alt=""></a></div>
        <div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="story-1.html">First headline here</a></h3>
          <p>An excerpt of the first story that is reasonably long.</p>
          <time>Dec 22, 2023</time>
        </div>
      </article>
      <div class="column">
        <article class="tile tile--row">
          <div class="thumb"><a href="story-2.html"><img src="b.png" alt=""></a></div>
          <div class="meat">
            <a class="kicker" href="cat-guides.html">Guides</a>
            <h3><a href="story-2.html">Second headline</a></h3>
            <time>Dec 19, 2023</time>
          </div>
        </article>
        <article class="tile tile--row">
          <div class="thumb"><a href="story-3.html"><img src="c.png" alt=""></a></div>
          <div class="meat">
            <a class="kicker" href="cat-reviews.html">Reviews</a>
            <h3><a href="story-3.html">Third headline</a></h3>
            <time>Dec 15, 2023</time>
          </div>
        </article>
        <article class="tile tile--row">
          <div class="thumb"><a href="story-4.html"><img src="d.png" alt=""></a></div>
          <div class="meat">
            <a class="kicker" href="cat-news.html">News</a>
            <h3><a href="story-4.html">Fourth headline</a></h3>
            <time>Dec 11, 2023</time>
          </div>
        </article>
      </div>
    </div>
  </section>
</main>`;

const NAV_AND_FOOTER = `
<body>
  <nav><ul>
    <li><a href="a.html">Home</a></li>
    <li><a href="b.html">News</a></li>
    <li><a href="c.html">Reviews</a></li>
    <li><a href="d.html">Guides</a></li>
  </ul></nav>
  <footer><div class="cols">
    <div class="col"><a href="x.html">Link</a></div>
    <div class="col"><a href="y.html">Link</a></div>
    <div class="col"><a href="z.html">Link</a></div>
  </div></footer>
</body>`;

describe('structuralSignature', () => {
  it('is class-agnostic: tag + sorted direct-child tag names', () => {
    const $ = cheerio.load(`<article class="x"><div></div><span></span></article>`);
    const $$ = cheerio.load(`<article class="totally-different"><span></span><div></div></article>`);
    const a = structuralSignature($, $('article')[0]);
    const b = structuralSignature($$, $$('article')[0]);
    expect(a).toBe(b); // class names ignored; child order normalized
    expect(a).toBe('article>div,span');
  });
});

describe('discoverHtmlCards — candidate clustering', () => {
  it('clusters mixed-depth cards into ONE grid (featured + nested rows)', () => {
    const grids = discoverHtmlCards(MIXED_DEPTH_GRID);
    expect(grids).toHaveLength(1);
    expect(grids[0].records).toHaveLength(4);
    expect(grids[0].containerSelector).toBeTruthy();
  });
});

describe('discoverHtmlCards — richness gate', () => {
  it('rejects nav link lists and footer link columns (no heading+image+text)', () => {
    expect(discoverHtmlCards(NAV_AND_FOOTER)).toHaveLength(0);
  });
});

describe('discoverHtmlCards — field roles', () => {
  it('assigns title/excerpt/image/category/date/link + synthesized id', () => {
    const [grid] = discoverHtmlCards(MIXED_DEPTH_GRID);
    const first = grid.records[0];
    expect(first.title).toBe('First headline here');
    expect(first.excerpt).toContain('excerpt of the first story');
    expect(first.image).toBe('a.png');
    expect(first.category).toBe('News');
    expect(first.date).toBe('Dec 22, 2023');
    expect(first.link).toBe('story-1.html');
    expect(typeof first.id).toBe('string');
    expect((first.id as string).length).toBeGreaterThan(0);
  });

  it('groups variant cards even when one lacks the excerpt (optional field)', () => {
    const [grid] = discoverHtmlCards(MIXED_DEPTH_GRID);
    const rowCard = grid.records[1]; // a tile--row, no <p>
    expect(rowCard.title).toBe('Second headline');
    expect(rowCard.excerpt ?? '').toBe(''); // missing field, not dropped/guessed
    expect(rowCard.image).toBe('b.png');
  });
});

describe('discoverHtmlCards — deterministic template', () => {
  it('annotates the source card with data-dla-* bindings, preserving classes', () => {
    const [grid] = discoverHtmlCards(MIXED_DEPTH_GRID);
    const t = grid.cardTemplate;
    expect(t).toContain('class="tile'); // source classes preserved
    expect(t).toMatch(/data-dla-text="title"/);
    expect(t).toMatch(/data-dla-text="content"/); // excerpt → content
    expect(t).toMatch(/data-dla-text="cat\.label"/); // category label
    expect(t).toMatch(/data-dla-attr="src:meta\.image"/);
    expect(t).not.toContain('First headline here');
  });
});

describe('discoverHtmlCards — body extraction', () => {
  it('uses extractMainContent for a DISTINCT linked page', () => {
    const pages: Record<string, string> = {
      'story-1.html': '<main><article><p>Full body of story one, much longer than the excerpt.</p></article></main>',
      'story-2.html': '<main><article><p>Full body of story two.</p></article></main>',
      'story-3.html': '<main><article><p>Full body of story three.</p></article></main>',
      'story-4.html': '<main><article><p>Full body of story four.</p></article></main>',
    };
    const [grid] = discoverHtmlCards(MIXED_DEPTH_GRID, { resolvePage: (h) => pages[h] ?? null });
    expect(grid.records[0].content).toContain('Full body of story one');
  });

  it('dedups a SHARED target: bodies fall back to excerpt, not N identical bodies', () => {
    const sharedHtml = MIXED_DEPTH_GRID.replace(/story-\d\.html/g, 'single.html');
    const single = '<main><article><p>The single template body, shared by all cards.</p></article></main>';
    const [grid] = discoverHtmlCards(sharedHtml, { resolvePage: () => single });
    const bodies = grid.records.map((r) => r.content);
    expect(bodies.every((b) => b === 'The single template body, shared by all cards.')).toBe(false);
    expect(grid.records[0].content).toBe(grid.records[0].excerpt);
  });
});
