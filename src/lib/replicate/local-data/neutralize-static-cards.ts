import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { MountSpec } from './types.js';
import { structuralSignature } from './discover-html-cards.js';
import { anchorId } from './string-utils.js';

export interface NeutralizeStaticCardsResult {
  html: string;
  /** Mount selectors (#id) that were stamped onto a container in this page. */
  stamped: string[];
}

/**
 * For each static-card mount (carrying `sourceSelector`) whose container resolves
 * in `html`: empty the card-signature children (the dominant repeated child shape),
 * preserve any non-card siblings, and stamp the synthetic id from `mount.selector`.
 * Pure + best-effort: a mount whose container/anchor can't be resolved is skipped.
 */
export function neutralizeStaticCards(html: string, mounts: MountSpec[]): NeutralizeStaticCardsResult {
  const $ = cheerio.load(html, undefined, false);
  const stamped: string[] = [];
  for (const mount of mounts) {
    if (!mount.sourceSelector) continue;
    const id = anchorId(mount.selector);
    if (!id) continue;
    let container: Element | undefined;
    try {
      container = $(mount.sourceSelector).first()[0] as Element | undefined;
    } catch {
      continue;
    }
    if (!container) continue;
    const childEls = $(container).children().toArray() as Element[];
    const freq = new Map<string, number>();
    for (const c of childEls) {
      const sig = structuralSignature($, c);
      freq.set(sig, (freq.get(sig) ?? 0) + 1);
    }
    const allDesc = $(container).find('*').toArray() as Element[];
    for (const c of allDesc) {
      const sig = structuralSignature($, c);
      freq.set(sig, (freq.get(sig) ?? 0) + 1);
    }
    const cardSig = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!cardSig) continue;
    for (const el of allDesc) {
      if (structuralSignature($, el) === cardSig) $(el).remove();
    }
    $(container).children().toArray().forEach((c) => {
      if ($(c).children().length === 0 && !$(c).text().trim()) $(c).remove();
    });
    $(container).attr('id', id);
    stamped.push(mount.selector);
  }
  return { html: $.html(), stamped };
}
