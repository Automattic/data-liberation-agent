import { describe, it, expect } from 'vitest';
import { applyBlockRecipe } from './apply-block-recipe.js';
import type { AdapterBlocks } from '../../adapters/page-actions.js';

const CTX = { url: 'https://x.test/p' };
describe('applyBlockRecipe', () => {
  it('returns null when the adapter declares no blocks capability', () => {
    expect(applyBlockRecipe('<p>hi</p>', undefined, CTX)).toBeNull();
  });
  it('uses htmlToBlocks first', () => {
    const blocks: AdapterBlocks = { htmlToBlocks: (h) => (h.includes('marker') ? '<!-- wp:paragraph --><p>ok</p><!-- /wp:paragraph -->' : null) };
    expect(applyBlockRecipe('<div>marker</div>', blocks, CTX)).toContain('wp:paragraph');
  });
  it('falls through to the recipe table when htmlToBlocks returns null', () => {
    const blocks: AdapterBlocks = { htmlToBlocks: () => null, recipes: [{ match: 'h2', block: 'core/heading', inner: 'text' }] };
    const out = applyBlockRecipe('<h2>Title</h2>', blocks, CTX);
    expect(out).toContain('<!-- wp:heading -->');
    expect(out).toContain('Title');
  });
  it('emits an image recipe and keeps unmatched elements as core/html (lossless)', () => {
    const blocks: AdapterBlocks = { recipes: [{ match: 'img', block: 'core/image', inner: 'drop' }] };
    const out = applyBlockRecipe('<img src="https://x.test/a.jpg" alt="a"/><table><tr><td>x</td></tr></table>', blocks, CTX)!;
    expect(out).toContain('<!-- wp:image -->');
    expect(out).toContain('https://x.test/a.jpg');
    expect(out).toContain('<!-- wp:html -->');
  });
  it('keeps unmatched content losslessly when no recipe matches', () => {
    const blocks: AdapterBlocks = { recipes: [{ match: 'video', block: 'core/video' }] };
    expect(applyBlockRecipe('<p>nothing matches</p>', blocks, CTX)).toContain('<!-- wp:html -->');
  });
});
