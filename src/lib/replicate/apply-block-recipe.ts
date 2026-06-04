import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { AdapterBlocks, BlockRecipe, BlockRecipeContext } from '../../adapters/page-actions.js';

/**
 * Seam 2: turn platform-structured source HTML into Gutenberg block markup via
 * the adapter's declared recipe. Order: whole-body htmlToBlocks first, then the
 * recipes table. Returns null when the adapter has no blocks capability or
 * produced nothing — the caller falls through to the generic renderer / core/html
 * floor (nothing is ever dropped). Called ONLY on the blocks reconstruct path.
 */
export function applyBlockRecipe(html: string, blocks: AdapterBlocks | undefined, ctx: BlockRecipeContext): string | null {
  if (!blocks) return null;
  if (blocks.htmlToBlocks) {
    const out = blocks.htmlToBlocks(html, ctx);
    if (out != null && out.trim()) return out;
  }
  if (blocks.recipes && blocks.recipes.length > 0) return composeFromRecipes(html, blocks.recipes, ctx);
  return null;
}

function composeFromRecipes(html: string, recipes: BlockRecipe[], ctx: BlockRecipeContext): string | null {
  const $ = cheerio.load(html, null, false);
  const out: string[] = [];
  $.root().children().each((_, node) => {
    if ((node as Element).type !== 'tag') return;
    const el = node as Element;
    const recipe = recipes.find((r) => $(el).is(r.match));
    out.push(recipe ? emitRecipeBlock($, el, recipe, ctx) : coreHtmlIsland($.html(el)));
  });
  const result = out.filter((b) => b && b.trim());
  return result.length ? result.join('\n\n') : null;
}

/** Strip the `core/` namespace prefix for core blocks — WP serialises them as `<!-- wp:heading -->`, not `<!-- wp:core/heading -->`. */
function blockTag(block: string): string {
  return block.startsWith('core/') ? block.slice('core/'.length) : block;
}

function emitRecipeBlock($: CheerioAPI, el: Element, recipe: BlockRecipe, ctx: BlockRecipeContext): string {
  const tag = blockTag(recipe.block);
  const attrs = recipe.attrs && Object.keys(recipe.attrs).length ? ` ${JSON.stringify(recipe.attrs)}` : '';
  const open = `<!-- wp:${tag}${attrs} -->`;
  const close = `<!-- /wp:${tag} -->`;
  const mode = recipe.inner ?? 'innerHtml';
  const $el = $(el);
  if (recipe.block === 'core/image' || mode === 'images') {
    const img = $el.is('img') ? $el : $el.find('img').first();
    const src = ctx.mediaMap?.[img.attr('src') || ''] ?? (img.attr('src') || '');
    return `${open}\n<figure class="wp-block-image"><img src="${escapeAttr(src)}" alt="${escapeAttr(img.attr('alt') || '')}"/></figure>\n${close}`;
  }
  if (mode === 'drop') return `${open}\n${close}`;
  const inner = mode === 'text' ? escapeHtml($el.text().trim()) : ($el.html() ?? '');
  return `${open}\n${inner}\n${close}`;
}

function coreHtmlIsland(html: string): string { return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`; }
function escapeAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
