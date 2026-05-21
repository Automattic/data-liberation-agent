// src/lib/preview/assemble-design-theme.ts
//
// Run-end blank-theme assembly for html-first design capture.
//
// Takes the run-level CSS aggregate (from CssAggregator.toString()), the
// optional JS aggregate (from JsAggregator.toString()), the accumulated
// mediaUrlMap, and the CDN head-links collected during the capture pass, and
// produces a ReplicaFile[] that can be handed directly to
// writeReplicaFilesToHost + wp theme activate.
//
// This is the final step of the html-first pipeline:
//   captureDesign (per-URL) → CssAggregator / JsAggregator (run-level)
//     → assembleDesignTheme (run-end) → writeReplicaFilesToHost → activate
//
import { buildBlankTheme } from './blank-theme.js';
import { rewriteMediaUrls } from '../streaming/media-url-rewrite.js';
import type { ReplicaFile } from './types.js';

export interface AssembleDesignThemeOpts {
  outputDir: string;
  cssText: string;                      // CssAggregator.toString()
  jsText?: string;                      // JsAggregator.toString() (undefined → no JS)
  mediaUrlMap: Map<string, string>;     // source URL → local upload URL
  headLinks: string[];                  // CDN/cross-origin <link>s to re-link
  themeSlug?: string;                   // default 'dla-replica'
  /** Sanitized site header HTML to bake into the blank theme. */
  headerHtml?: string;
  /** Sanitized site footer HTML to bake into the blank theme. */
  footerHtml?: string;
}

/**
 * Assemble the blank design theme for html-first mode.
 *
 * Returns the ReplicaFile[] for the blank theme (style.css, functions.php,
 * index.php, page.php, singular.php) plus the run-level site.css
 * (media-URL-rewritten) and, when jsText is non-empty, site.js.
 */
export function assembleDesignTheme(opts: AssembleDesignThemeOpts): ReplicaFile[] {
  const themeSlug = opts.themeSlug ?? 'dla-replica';
  const hasJs = !!(opts.jsText && opts.jsText.trim());

  // Rewrite CSS url() refs to local uploads (the second rewrite surface —
  // first is per-URL markup rewrites in flushPendingImports).
  const siteCss = opts.mediaUrlMap.size > 0
    ? rewriteMediaUrls(opts.cssText, opts.mediaUrlMap)
    : opts.cssText;

  const files = buildBlankTheme({ themeSlug, hasJs, headLinks: opts.headLinks, headerHtml: opts.headerHtml, footerHtml: opts.footerHtml });
  files.push({ relativePath: 'site.css', content: siteCss });
  if (hasJs) {
    files.push({ relativePath: 'site.js', content: opts.jsText! });
  }
  return files;
}
