// src/lib/screenshot/dom-capture.ts
import type { Page } from 'playwright';

/** Inner HTML of <body>, image src/srcset preserved (no inlining). */
export async function collectBodyFragment(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerHTML);
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
