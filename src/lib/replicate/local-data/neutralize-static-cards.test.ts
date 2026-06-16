import { describe, it, expect } from 'vitest';
import { neutralizeStaticCards } from './neutralize-static-cards.js';
import type { MountSpec } from './types.js';
import * as cheerio from 'cheerio';

const mount = (selector: string, sourceSelector: string): MountSpec => ({
  selector, sourceSelector, sourceCall: `html-cards:${sourceSelector}`,
  query: { postType: 'post', perPage: -1, orderBy: 'date', order: 'ASC' },
});

const PAGE = `<main><section><div class="grid">
  <article><h3>One</h3><img src="a.png"></article>
  <article><h3>Two</h3><img src="b.png"></article>
  <article><h3>Three</h3><img src="c.png"></article>
</div></section></main>`;

describe('neutralizeStaticCards', () => {
  it('stamps the synthetic id and empties the card children', () => {
    const m = mount('#dla-cards-x', 'main > section:nth-of-type(1) > div:nth-of-type(1)');
    const { html, stamped } = neutralizeStaticCards(PAGE, [m]);
    expect(stamped).toEqual(['#dla-cards-x']);
    const $ = cheerio.load(html);
    expect($('#dla-cards-x').length).toBe(1);
    expect($('#dla-cards-x').children().length).toBe(0); // cards removed
    expect($('article').length).toBe(0);
  });

  it('preserves non-card siblings inside the container', () => {
    const withHeading = PAGE.replace('<div class="grid">', '<div class="grid"><h2>Latest</h2>');
    const m = mount('#dla-cards-x', 'main > section:nth-of-type(1) > div:nth-of-type(1)');
    const { html } = neutralizeStaticCards(withHeading, [m]);
    const $ = cheerio.load(html);
    expect($('#dla-cards-x h2').text()).toBe('Latest'); // non-card sibling kept
    expect($('#dla-cards-x article').length).toBe(0);    // cards gone
  });

  it('is a no-op when the container selector does not resolve', () => {
    const m = mount('#dla-cards-x', 'main > nope:nth-of-type(9)');
    const { html, stamped } = neutralizeStaticCards(PAGE, [m]);
    expect(stamped).toEqual([]);
    expect(html).toBe(PAGE); // unchanged
  });

  it('ignores JS-path mounts (no sourceSelector)', () => {
    const js: MountSpec = { selector: '#grid', sourceCall: 'mountGrid', query: { postType: 'x', perPage: -1 } };
    const { stamped } = neutralizeStaticCards(PAGE, [js]);
    expect(stamped).toEqual([]);
  });
});
