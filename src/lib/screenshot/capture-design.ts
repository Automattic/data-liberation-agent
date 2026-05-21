// src/lib/screenshot/capture-design.ts
import type { Page } from 'playwright';
import { collectBodyAndChrome, collectStylesheets, collectHeadLinks, collectScripts } from './dom-capture.js';

const MIN_DESIGN_BYTES = 512;

export interface DesignCapture {
  bodyFragmentHtml: string;
  css: string;
  headLinks: string[];
  bodyClasses: string[];
  scripts: Array<{ src?: string; inline?: string }>;
  /** Extracted + de-pinned site header HTML, or null when none detected. */
  headerHtml: string | null;
  /** Extracted + de-pinned site footer HTML, or null when none detected. */
  footerHtml: string | null;
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
  const { bodyFragmentHtml, headerHtml, footerHtml } = chrome;
  if (bodyFragmentHtml.length + css.length < MIN_DESIGN_BYTES) {
    throw new Error(`captureDesign: captured content too small (${bodyFragmentHtml.length + css.length}B) — page likely did not render`);
  }
  const scripts = opts.includeScripts ? await collectScripts(page) : [];
  return { bodyFragmentHtml, css, headLinks, bodyClasses, scripts, headerHtml, footerHtml };
}
