// src/lib/screenshot/capture-design.ts
import type { Page } from 'playwright';
import { collectBodyAndChrome, collectStylesheets, collectHeadLinks, collectScripts } from './dom-capture.js';
import type { BakedLayoutMap } from './fixups.js';

const MIN_DESIGN_BYTES = 512;

export interface DesignCapture {
  bodyFragmentHtml: string;
  css: string;
  headLinks: string[];
  bodyClasses: string[];
  scripts: Array<{ src?: string; inline?: string }>;
  /** Extracted + marker-keyed site header HTML, or null when none detected. */
  headerHtml: string | null;
  /** Extracted + marker-keyed site footer HTML, or null when none detected. */
  footerHtml: string | null;
  /**
   * Desktop computed layout map for the chrome (marker → props).
   * Used with the mobile map to generate responsive chrome.css via generateChromeCss.
   * Null when no chrome was detected.
   */
  desktopLayoutMap: BakedLayoutMap | null;
}

export async function captureDesign(
  page: Page, _baseUrl: string, opts: { includeScripts: boolean },
): Promise<DesignCapture> {
  const [chrome, css, headLinks, bodyClasses] = await Promise.all([
    collectBodyAndChrome(page),
    collectStylesheets(page),
    collectHeadLinks(page),
    page.evaluate(() => document.body.className.split(/\s+/).filter(Boolean)),
  ]);
  const { bodyFragmentHtml, headerHtml, footerHtml, desktopLayoutMap } = chrome;
  if (bodyFragmentHtml.length + css.length < MIN_DESIGN_BYTES) {
    throw new Error(`captureDesign: captured content too small (${bodyFragmentHtml.length + css.length}B) — page likely did not render`);
  }
  const scripts = opts.includeScripts ? await collectScripts(page) : [];
  return { bodyFragmentHtml, css, headLinks, bodyClasses, scripts, headerHtml, footerHtml, desktopLayoutMap };
}
