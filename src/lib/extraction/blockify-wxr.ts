import { WxrBuilder, type WxrItem } from './wxr-builder.js';
import { readWxr } from './wxr-reader.js';
import { applyBlockRecipe } from '../replicate/apply-block-recipe.js';
import type { AdapterBlocks } from '../../adapters/page-actions.js';

/**
 * BULK blog-body block conversion — the content-body counterpart to seam 2.
 *
 * Runs the adapter's block recipe over every post/page `content:encoded` body
 * IN PLACE. This is the bulk counterpart to the per-section recipe firing in
 * `page-reconstruct.ts`: the visual reconstruction upgrades captured sections,
 * while this upgrades the imported post/page bodies — e.g. the Squarespace case
 * where `item.body` is sqs-block markup that would otherwise import as one
 * uneditable Classic block.
 *
 * Blocks path ONLY — the CALLER decides whether to run it (the blocks reconstruct
 * flow does; the theme/carry path leaves `content:encoded` as verbatim source
 * HTML). Lossless: a body the recipe can't convert (returns null) is left
 * untouched, and non-content items (attachments, nav menu items, comments,
 * terms) are never touched. Returns the number of bodies converted.
 */
export function blockifyWxrBodies(items: WxrItem[], blocks: AdapterBlocks): number {
  let converted = 0;
  for (const item of items) {
    if (item.type !== 'post' && item.type !== 'page') continue;
    if (!item.content || !item.content.trim()) continue;
    const out = applyBlockRecipe(item.content, blocks, { url: item.sourceUrl ?? '' });
    if (out != null && out.trim() && out !== item.content) {
      item.content = out;
      converted++;
    }
  }
  return converted;
}

/**
 * Read a WXR file, blockify its post/page bodies via {@link blockifyWxrBodies},
 * and write it back (only when something actually converted, to avoid a no-op
 * re-serialize). Uses `readWxr` → `serialize` — the codebase's round-trip, also
 * used by `--resume` / `extract_one` — but keeps ALL items, INCLUDING
 * `nav_menu_item`s that `rehydrateBuilderFromWxr` deliberately drops, so nothing
 * but the converted bodies changes. Returns how many bodies converted out of the
 * post/page total.
 */
export function blockifyWxrFile(
  wxrPath: string,
  blocks: AdapterBlocks,
): { converted: number; postsAndPages: number } {
  const data = readWxr(wxrPath);
  const wxr = new WxrBuilder(data.site);
  wxr.authors = data.authors;
  wxr.categories = data.categories;
  wxr.tags = data.tags;
  wxr.terms = data.terms;
  wxr.comments = data.comments;
  wxr.redirects = data.redirects;
  wxr.items = data.items; // keep EVERYTHING (incl nav_menu_item) — do NOT filter
  let maxId = 0;
  for (const it of wxr.items) maxId = Math.max(maxId, it.id);
  wxr._nextId = maxId + 1;

  const postsAndPages = wxr.items.filter((i) => i.type === 'post' || i.type === 'page').length;
  const converted = blockifyWxrBodies(wxr.items, blocks);
  if (converted > 0) wxr.serialize(wxrPath);
  return { converted, postsAndPages };
}
