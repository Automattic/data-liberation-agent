import { sanitizeSourceHtml } from '../streaming/html-sanitize.js';

export function wrapFragment(fragmentHtml: string, slug: string, bodyClasses: string[]): string {
  const safe = sanitizeSourceHtml(fragmentHtml);
  const cls = ['data-blocks-engine-capture-replica', 'data-blocks-engine-capture-content-desktop', `data-blocks-engine-capture-page-${slug}`, ...bodyClasses].join(' ');
  return `<div class="${cls}">\n${safe}\n</div>`;
}

/**
 * Wrap the mobile body fragment for viewport-toggled rendering.
 * The `data-blocks-engine-capture-content-mobile` outer div is the clipping/height-reserving shell;
 * `data-blocks-engine-capture-content-mobile-inner` is the element that receives the CSS transform
 * scaling the fixed-width mobile canvas down to the viewport width.
 */
export function wrapMobileFragment(fragmentHtml: string, slug: string, bodyClasses: string[]): string {
  const safe = sanitizeSourceHtml(fragmentHtml);
  const cls = ['data-blocks-engine-capture-replica', 'data-blocks-engine-capture-content-mobile', `data-blocks-engine-capture-page-${slug}`, ...bodyClasses].join(' ');
  return `<div class="${cls}">\n<div class="data-blocks-engine-capture-content-mobile-inner">\n${safe}\n</div>\n</div>`;
}

// Rewrite top-level `body`/`html` selector tokens to `.data-blocks-engine-capture-replica`; optionally
// prefix every selector with `.data-blocks-engine-capture-page-<slug>` (for page-specific inline CSS).
export function scopeCss(css: string, slug: string, scopePage: boolean): string {
  let out = css.replace(/(^|[\s,{>+~])(html|body)(?=[\s,{>+~:]|$)/g, (_m, pre) => `${pre}.data-blocks-engine-capture-replica`);
  if (scopePage) {
    out = out.replace(/(^|})\s*([^{}]+?)\s*\{/g, (_m, brace, sel) => {
      const scoped = sel.split(',').map((s: string) => `.data-blocks-engine-capture-page-${slug} ${s.trim()}`).join(', ');
      return `${brace}${scoped}{`;
    });
  }
  return out;
}
