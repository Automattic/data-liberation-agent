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
import { sanitizeSourceHtml } from '../streaming/html-sanitize.js';
import type { BakedLayoutMap } from './fixups.js';

const CDN_FONT_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com', 'use.typekit.net'];

export function designSidecarPath(outputDir: string, slug: string): string {
  return join(outputDir, 'design', `${slug}.fragment.html`);
}

export interface DesignCaptureRunOpts {
  page: Page;
  url: string;
  slug: string;
  archetype: string;              // design-captured for content archetypes (homepage/page/post/gallery/event); 'product' stays structured
  outputDir: string;
  baseUrl: string;
  includeScripts: boolean;
  cssAgg: CssAggregator;
  jsAgg?: JsAggregator;           // present iff includeScripts
  headLinks: Set<string>;         // run-level accumulator of CDN/cross-origin <link> hrefs
  /**
   * Run-level accumulators for site chrome. First non-null value detected
   * across all captured pages wins and is stored for the blank-theme build.
   * Pass null cells so callers can use a simple `{ current: null }` box.
   *
   * Extended for dual-viewport: also accumulates the desktop layout map
   * (marker → computed props) so it can be paired with the mobile map
   * collected during the mobile pass to generate responsive chrome.css.
   */
  chromeAccum?: {
    headerHtml: string | null;
    footerHtml: string | null;
    /** Desktop baked layout map (marker → props). Set on first successful chrome capture. */
    desktopLayoutMap: BakedLayoutMap | null;
  };
  fetchScript?: (url: string) => Promise<string | null>; // injectable for tests; defaults to global fetch
}

// Content archetypes carry the html-first design; products keep the structured
// WooCommerce import (eng-review Q1). homepage/gallery/event are content pages —
// the homepage especially MUST be captured (it's the most important page).
const DESIGN_CAPTURE_ARCHETYPES = new Set(['homepage', 'page', 'post', 'gallery', 'event']);

/** Returns the source media URLs found in this page's CSS (for media discovery),
 *  or null when design wasn't captured (non-content archetype, or capture failed → caller falls back). */
export async function captureDesignForUrl(opts: DesignCaptureRunOpts): Promise<{ cssMediaUrls: string[] } | null> {
  if (!DESIGN_CAPTURE_ARCHETYPES.has(opts.archetype)) return null;
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
  // Chrome accumulators: first non-null sanitized value across the run wins.
  if (opts.chromeAccum) {
    if (opts.chromeAccum.headerHtml === null && cap.headerHtml) {
      opts.chromeAccum.headerHtml = sanitizeSourceHtml(cap.headerHtml);
    }
    if (opts.chromeAccum.footerHtml === null && cap.footerHtml) {
      opts.chromeAccum.footerHtml = sanitizeSourceHtml(cap.footerHtml);
    }
    // Accumulate desktop layout map (first non-null wins, same as html).
    if (opts.chromeAccum.desktopLayoutMap === null && cap.desktopLayoutMap) {
      opts.chromeAccum.desktopLayoutMap = cap.desktopLayoutMap;
    }
  }
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
