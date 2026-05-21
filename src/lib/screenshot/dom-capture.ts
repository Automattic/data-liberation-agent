// src/lib/screenshot/dom-capture.ts
import type { Page } from 'playwright';

/** Inner HTML of <body>, image src/srcset preserved (no inlining). */
export async function collectBodyFragment(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerHTML);
}

export interface BodyAndChrome {
  bodyFragmentHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
}

/**
 * Detect the site header + footer in the live (JS-rendered) DOM, bake their
 * position:static so they flow without JS, remove them from the body, and
 * return the trimmed body HTML together with the extracted chrome HTML.
 *
 * Called once per page during design capture. The single `page.evaluate` keeps
 * round-trips minimal and ensures the DOM mutations (style baking + removal)
 * happen atomically before we read `document.body.innerHTML`.
 */
export async function collectBodyAndChrome(page: Page): Promise<BodyAndChrome> {
  return page.evaluate((): BodyAndChrome => {
    const vw = window.innerWidth || 1440;
    const docH = document.documentElement.scrollHeight;

    const pick = (atTop: boolean): Element | null => {
      let best: Element | null = null;
      let bestScore = 2; // require score > 2 to accept a computed candidate
      for (const el of document.querySelectorAll('div,section,header,footer,nav')) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.6 || r.height < 24 || r.height > 400) continue;
        const fixedish = cs.position === 'fixed' || cs.position === 'sticky';
        const hasNav = !!el.querySelector('nav, a, [role="navigation"]');
        const nearTop = r.top <= 80;
        const nearBottom = r.bottom >= docH - 160;
        let s = 0;
        if (fixedish) s += 2;
        if (hasNav) s += 2;
        if (atTop && nearTop) s += 3;
        if (!atTop && nearBottom) s += 3;
        if (s > bestScore) { bestScore = s; best = el; }
      }
      return best;
    };

    const header = document.querySelector('header, [role="banner"]') || pick(true);
    const footer = document.querySelector('footer, [role="contentinfo"]') || pick(false);

    // Bake position:static on fixed/sticky elements within the chrome so it
    // flows without JS (it was correctly positioned at capture because the
    // page's JS had already run).
    const bake = (root: Element | null): string | null => {
      if (!root) return null;
      const els = [root, ...Array.from(root.querySelectorAll('*'))];
      for (const el of els) {
        const p = getComputedStyle(el as HTMLElement).position;
        if (p === 'fixed' || p === 'sticky') {
          (el as HTMLElement).style.position = 'static';
          (el as HTMLElement).style.top = 'auto';
          (el as HTMLElement).style.left = 'auto';
          (el as HTMLElement).style.transform = 'none';
        }
      }
      return (root as HTMLElement).outerHTML;
    };

    const headerHtml = bake(header);
    const footerHtml = bake(footer);

    // Only remove chrome elements when they are disjoint — avoid removing an
    // ancestor that contains the other.
    const safeRemove = (el: Element | null, other: Element | null): void => {
      if (el && !(other && (el.contains(other) || other.contains(el)))) el.remove();
    };
    safeRemove(header, footer);
    safeRemove(footer, header);

    return { bodyFragmentHtml: document.body.innerHTML, headerHtml, footerHtml };
  });
}

/** Concatenated cssText of all SAME-ORIGIN stylesheets. Cross-origin sheets
 *  throw on .cssRules and are skipped (their <link> is captured separately). */
export async function collectStylesheets(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
      } catch { /* cross-origin — skip */ }
    }
    return parts.join('\n');
  });
}

/** href of every <head> <link rel=stylesheet>. */
export async function collectHeadLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('head link[rel="stylesheet"]'))
      .map((l) => (l as HTMLLinkElement).href)
      .filter(Boolean),
  );
}

/** Scripts in document order: {src} external, {inline} inline blocks. */
export async function collectScripts(page: Page): Promise<Array<{ src?: string; inline?: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('script')).map((s) => {
      const el = s as HTMLScriptElement;
      return el.src ? { src: el.src } : { inline: el.textContent ?? '' };
    }),
  );
}
