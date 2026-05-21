import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { captureDesign } from './capture-design.js';
import { wrapFragment, scopeCss } from './design-transform.js';
import { extractCssMediaUrls } from './css-url-media.js';
import { isFirstParty } from './first-party.js';
import { isAllowlistedCdn, type ScriptInput } from './js-aggregator.js';
import type { CssAggregator } from './css-aggregator.js';
import type { JsAggregator } from './js-aggregator.js';

const CDN_FONT_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com', 'use.typekit.net'];

export function designSidecarPath(outputDir: string, slug: string): string {
  return join(outputDir, 'design', `${slug}.fragment.html`);
}

export interface DesignCaptureRunOpts {
  page: Page;
  url: string;
  slug: string;
  archetype: string;              // only 'page'|'post' are captured
  outputDir: string;
  baseUrl: string;
  includeScripts: boolean;
  cssAgg: CssAggregator;
  jsAgg?: JsAggregator;           // present iff includeScripts
  headLinks: Set<string>;         // run-level accumulator of CDN/cross-origin <link> hrefs
  fetchScript?: (url: string) => Promise<string | null>; // injectable for tests; defaults to global fetch
}

/** Returns the source media URLs found in this page's CSS (for media discovery),
 *  or null when design wasn't captured (non page/post, or capture failed → caller falls back). */
export async function captureDesignForUrl(opts: DesignCaptureRunOpts): Promise<{ cssMediaUrls: string[] } | null> {
  if (opts.archetype !== 'page' && opts.archetype !== 'post') return null;
  let cap;
  try {
    cap = await captureDesign(opts.page, opts.baseUrl, { includeScripts: opts.includeScripts });
  } catch (e) {
    console.error(`[design] capture failed for ${opts.url}: ${(e as Error).message} — falling back to extracted content`);
    return null;
  }
  // fragment → sidecar (wrapped + sanitized)
  const wrapped = wrapFragment(cap.bodyFragmentHtml, opts.slug, cap.bodyClasses);
  const sidecar = designSidecarPath(opts.outputDir, opts.slug);
  mkdirSync(dirname(sidecar), { recursive: true });
  writeFileSync(sidecar, wrapped);
  // CSS → aggregator (body→.dla-replica; scopePage=false — at-rule-safe, per eng-review)
  await opts.cssAgg.add(opts.slug, scopeCss(cap.css, opts.slug, false));
  // head links → run-level set (theme re-links them)
  for (const l of cap.headLinks) opts.headLinks.add(l);
  // scripts → aggregator (fetch external first-party/allowlisted bodies; inline already have content)
  if (opts.includeScripts && opts.jsAgg) {
    const fetcher = opts.fetchScript ?? (async (u: string) => {
      try { const r = await fetch(u); return r.ok ? await r.text() : null; } catch { return null; }
    });
    const inputs: ScriptInput[] = [];
    for (const s of cap.scripts) {
      if (s.inline !== undefined) { inputs.push({ content: s.inline }); continue; }
      if (s.src && (isFirstParty(s.src, opts.baseUrl) || isAllowlistedCdn(s.src))) {
        const body = await fetcher(s.src);
        if (body) inputs.push({ src: s.src, content: body });
      }
    }
    await opts.jsAgg.add(opts.slug, inputs);
  }
  return { cssMediaUrls: extractCssMediaUrls(cap.css, CDN_FONT_HOSTS) };
}
