// src/lib/replicate/local-theme/source-assets.ts
//
// Stage 1d: carry the SOURCE site's CSS/JS into the theme so the
// class-preserving block DOM (emit-blocks className/anchor) renders under the
// designer's own stylesheet — the path to ~100% parity. We OWN the source, so
// divergences are fixed by deterministic adaptation here, not approximation:
//   - Google-Fonts @import/link CSS is stripped (faces are already self-hosted
//     by google-fonts.ts under the same family names).
//   - A small WP-compat layer is PREPENDED (lowest precedence) neutralizing
//     WP wrapper interference (template-part div, root layout padding).
// JS is carried verbatim (user decision: identical replication; the spec's
// off-by-default hatch is deliberately ON for this flow) — functions.php adds
// the html.js class snippet so source reveal-gates behave as authored.
//
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Neutralize WP-injected wrappers so source layout selectors keep working.
 * Prepended (lowest precedence) — source rules always win over it. */
export const WP_COMPAT_CSS = `/* wp-compat: neutralize WP wrapper interference for carried source CSS */
.wp-block-template-part { display: contents; }
:where(body .is-layout-constrained) > * { margin-block-start: 0; margin-block-end: 0; }
:where(body) { margin: 0; }
`;

const GOOGLE_IMPORT_RE = /@import\s+url\(\s*['"]?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g;

export interface SourceAssets {
  /** Compat layer + all source CSS (linked files in DOCUMENT order, then unlinked top-level fallback, then inline <style> blocks). */
  css: string;
  /** All source JS concatenated (linked scripts in DOCUMENT order, then unlinked top-level fallback). */
  js: string;
  /** Relative paths (subdir-aware) in concatenation order. */
  cssFiles: string[];
  jsFiles: string[];
}

export function collectSourceAssets(
  dir: string,
  pages: Array<{ relPath: string; html: string }>,
): SourceAssets {
  const cssFiles: string[] = [];
  const jsFiles: string[] = [];
  const cssParts: string[] = [];
  const jsParts: string[] = [];

  // Pass 1: linked assets in DOCUMENT order — the page's <link rel=stylesheet>
  // / <script src> sequence IS the author's cascade; alphabetical reads would
  // invert it (e.g. overrides.css before theme.css → wrong winner). First-seen
  // dedup across pages keeps the earliest page's position authoritative.
  const seenCss = new Set<string>();
  const seenJs = new Set<string>();
  const seenInline = new Set<string>();
  const pageHtmls: string[] = [];
  for (const page of pages) {
    const html =
      page.html ||
      (existsSync(join(dir, page.relPath)) ? readFileSync(join(dir, page.relPath), 'utf8') : '');
    pageHtmls.push(html);
    for (const m of html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)) {
      const hrefMatch = m[0].match(/href=["']([^"']+)|href=([^\s>]+)/i);
      const href = hrefMatch?.[1] ?? hrefMatch?.[2];
      if (!href || /^https?:\/\//i.test(href)) continue; // skip absolute CDN URLs — captured sites have local copies
      const rel = href.replace(/^\//, '');
      if (seenCss.has(rel)) continue;
      seenCss.add(rel);
      const absPath = join(dir, rel);
      if (existsSync(absPath)) {
        cssFiles.push(rel);
        cssParts.push(readFileSync(absPath, 'utf8'));
      }
    }
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)|<script[^>]+src=([^\s>]+)/gi)) {
      const src = m[1] ?? m[2];
      if (!src || /^https?:\/\//i.test(src)) continue;
      const rel = src.replace(/^\//, '');
      if (seenJs.has(rel)) continue;
      seenJs.add(rel);
      const absPath = join(dir, rel);
      if (existsSync(absPath)) {
        jsFiles.push(rel);
        jsParts.push(readFileSync(absPath, 'utf8'));
      }
    }
  }

  // Pass 2: top-level unlinked .css/.js fallback (alphabetical, skip already
  // linked) — catches assets the capture saved but no surviving page references.
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.css') && !seenCss.has(name)) {
      seenCss.add(name);
      cssFiles.push(name);
      cssParts.push(readFileSync(join(dir, name), 'utf8'));
    } else if (name.endsWith('.js') && !seenJs.has(name)) {
      seenJs.add(name);
      jsFiles.push(name);
      jsParts.push(readFileSync(join(dir, name), 'utf8'));
    }
  }

  // Inline <style> blocks from each page (first occurrence set, dedup by content).
  // NOTE: a page-scoped inline style becomes GLOBAL in the carried bundle —
  // acceptable while captured sites' inline rules are page-prefixed or
  // idempotent; revisit if a page-specific rule leaks across pages.
  for (const html of pageHtmls) {
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const body = m[1].trim();
      if (body && !seenInline.has(body)) {
        seenInline.add(body);
        cssParts.push(body);
      }
    }
  }

  // Strip Google-Fonts @imports AFTER concat: WP_COMPAT_CSS contains no @imports
  // so startsWith(WP_COMPAT_CSS) is preserved; Google imports only exist in cssParts.
  const css = (WP_COMPAT_CSS + cssParts.join('\n\n')).replace(GOOGLE_IMPORT_RE, '');
  return { css, js: jsParts.join('\n\n'), cssFiles, jsFiles };
}
