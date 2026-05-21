// src/lib/screenshot/capture-design.ts
import type { Page } from 'playwright';
import { collectBodyFragment, collectStylesheets, collectHeadLinks, collectScripts } from './dom-capture.js';

const MIN_DESIGN_BYTES = 512;

export interface DesignCapture {
  bodyFragmentHtml: string;
  css: string;
  headLinks: string[];
  bodyClasses: string[];
  scripts: Array<{ src?: string; inline?: string }>;
}

export async function captureDesign(
  page: Page, _baseUrl: string, opts: { includeScripts: boolean },
): Promise<DesignCapture> {
  const [bodyFragmentHtml, css, headLinks, bodyClasses] = await Promise.all([
    collectBodyFragment(page),
    collectStylesheets(page),
    collectHeadLinks(page),
    page.evaluate(() => document.body.className.split(/\s+/).filter(Boolean)),
  ]);
  if (bodyFragmentHtml.length + css.length < MIN_DESIGN_BYTES) {
    throw new Error(`captureDesign: captured content too small (${bodyFragmentHtml.length + css.length}B) — page likely did not render`);
  }
  const scripts = opts.includeScripts ? await collectScripts(page) : [];
  return { bodyFragmentHtml, css, headLinks, bodyClasses, scripts };
}
