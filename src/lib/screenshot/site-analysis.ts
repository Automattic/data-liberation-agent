import type { Page } from 'playwright';
import { withEvaluateTimeout } from './page-helpers.js';

export interface PageAnalysis {
  palette: Array<{ hex: string; count: number }>;
  typography: Record<string, {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
  }>;
  metadata: {
    title: string;
    metaDescription: string;
    openGraph: Record<string, string>;
    jsonLdTypes: string[];
    htmlBytes: number;
  };
}

function validate(value: unknown): asserts value is PageAnalysis {
  if (!value || typeof value !== 'object') throw new Error('analyzePage: bad shape');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.palette)) throw new Error('analyzePage: palette must be array');
  if (!v.typography || typeof v.typography !== 'object') throw new Error('analyzePage: typography shape');
  if (!v.metadata || typeof v.metadata !== 'object') throw new Error('analyzePage: metadata shape');
}

/**
 * Extract palette, typography samples, and URL metadata in a single round-trip
 * to the browser. Runs inside page.evaluate so we share one DOM traversal.
 *
 *   enter page  ──▶ element background-color sampling ─┐
 *                ──▶ getComputedStyle on h1/h2/h3/body/button ─┤──▶ one serialized return
 *                ──▶ title/og-tags/json-ld/htmlBytes scan ─────┘
 */
export async function analyzePage(page: Page, timeoutMs = 5_000): Promise<PageAnalysis> {
  const result = await withEvaluateTimeout(page.evaluate(() => {
    // --- palette via background-color sampling ----------------------------
    // Pixel-perfect sampling would require rendering to a canvas (expensive
    // and CSP-fragile). Sampling computed background-color of major layout
    // elements gives a good dominant-color signal at near-zero cost.
    const bucketed = new Map<string, number>();
    const colorOf = (el: Element): string => {
      const c = getComputedStyle(el).backgroundColor;
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return '';
      return c;
    };
    const els = document.querySelectorAll('body, header, main, footer, section, article, nav, aside, div');
    let counted = 0;
    for (const el of Array.from(els)) {
      const c = colorOf(el);
      if (!c) continue;
      bucketed.set(c, (bucketed.get(c) ?? 0) + 1);
      counted++;
      if (counted > 500) break;
    }
    const palette = Array.from(bucketed.entries())
      .map(([color, count]) => {
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return { hex: color, count };
        const [, r, g, b] = m;
        const hex = '#' + [r, g, b].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
        return { hex, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    // --- typography -------------------------------------------------------
    const typoTargets = ['h1', 'h2', 'h3', 'body', 'button'] as const;
    const typography: Record<string, { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string }> = {};
    for (const sel of typoTargets) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      typography[sel] = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
      };
    }

    // --- metadata ---------------------------------------------------------
    const title = document.title;
    const metaDescription = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? '';
    const openGraph: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll('meta[property^="og:"]'))) {
      const m = el as HTMLMetaElement;
      const prop = m.getAttribute('property');
      if (prop) openGraph[prop] = m.content;
    }
    const jsonLdTypes: string[] = [];
    for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const obj = JSON.parse((el as HTMLScriptElement).textContent ?? '');
        const stack: unknown[] = [obj];
        while (stack.length) {
          const v = stack.shift();
          if (!v) continue;
          if (Array.isArray(v)) stack.push(...v);
          else if (typeof v === 'object') {
            const rec = v as Record<string, unknown>;
            if (rec['@type']) jsonLdTypes.push(String(rec['@type']));
            stack.push(...Object.values(rec));
          }
        }
      } catch { /* skip malformed JSON-LD */ }
    }
    const htmlBytes = new Blob([document.documentElement.outerHTML]).size;

    return { palette, typography, metadata: { title, metaDescription, openGraph, jsonLdTypes, htmlBytes } };
  }), timeoutMs);

  validate(result);
  return result;
}
