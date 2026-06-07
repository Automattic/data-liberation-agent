//
// General HTML → native blocks (rawHandler)
// =========================================
// WordPress's paste parser (`@wordpress/blocks` rawHandler) is the general,
// semantic-tag-driven HTML→blocks engine — it reads <h2>/<table>/<blockquote>
// and emits core blocks regardless of source platform. It runs HERE (not in the
// main process) only because @wordpress/blocks needs React 18 while the CLI
// hoists React 19 from Ink — they can't share a process (see block-fixer-client.ts).
//
// Three render-save normalizations precede the parse — they fix HTML that any
// RENDERED page carries, and do NOT read wp-block-* to decide block identity
// (that's rawHandler's tag-driven job):
//   1. Unwrap non-semantic layout/template wrappers — else the whole section
//      collapses into one wp:html.
//   2. Unwrap figure.wp-block-table → bare <table> — the table transform's
//      selector is 'table', so the figure wrapper matches nothing → wp:html;
//      the bare table → clean wp:table.
//   3. Native-emit spacers — core/spacer has no raw transform, so a spacer div
//      → wp:html; we splice a real wp:spacer (source height) after serialize.
//
const { JSDOM } = require('jsdom');
const { rawHandler, serialize } = require('@wordpress/blocks');
const { registerCoreBlocks } = require('@wordpress/block-library');

let initialized = false;
function init() {
  if (initialized) return;
  try {
    registerCoreBlocks();
  } catch (e) {
    console.error('[rawConvert] registerCoreBlocks failed:', e && e.message);
  }
  initialized = true;
}

// Keep in sync with src/lib/replicate/semantic-html.ts (UNWRAP_SELECTOR).
const UNWRAP_SELECTOR =
  'main, div.wp-block-group, div.wp-block-post-content, div.entry-content, div.wp-block-group__inner-container';

function spacerBlock(height) {
  const h = height || '50px';
  return `<!-- wp:spacer {"height":"${h}"} -->\n<div style="height:${h}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`;
}

function preprocess(html) {
  const d = new JSDOM(`<body>${html}</body>`).window.document.body;
  // 1. Unwrap non-semantic wrappers, repeatedly, until stable (NOT spacers).
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of [...d.querySelectorAll(UNWRAP_SELECTOR)]) {
      if (el.classList.contains('wp-block-spacer')) continue;
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
      changed = true;
    }
  }
  // 2. Unwrap figure.wp-block-table → bare <table>.
  for (const fig of [...d.querySelectorAll('figure.wp-block-table')]) {
    const table = fig.querySelector('table');
    if (table) fig.parentNode.replaceChild(table, fig);
  }
  // 3. Replace spacers with sentinel paragraphs spliced back post-serialize.
  const spacers = [];
  for (const sp of [...d.querySelectorAll('.wp-block-spacer')]) {
    const m = (sp.getAttribute('style') || '').match(/height:\s*([0-9.]+px)/);
    spacers.push(m ? m[1] : '50px');
    const marker = d.ownerDocument.createElement('p');
    marker.textContent = `@@SPACER_${spacers.length - 1}@@`;
    sp.parentNode.replaceChild(marker, sp);
  }
  return { html: d.innerHTML, spacers };
}

/**
 * Convert one section's (already-sanitized) HTML into native block markup.
 * Returns { html, wpHtmlResidue }. Never throws — on parser error returns
 * { html: '', wpHtmlResidue: Infinity } so the caller falls back.
 */
function convertHtmlToBlocks(sectionHtml) {
  if (!sectionHtml || !sectionHtml.trim()) return { html: '', wpHtmlResidue: 0 };
  init();
  try {
    const { html, spacers } = preprocess(sectionHtml);
    let markup = serialize(rawHandler({ HTML: html }));
    markup = markup.replace(
      /<!-- wp:paragraph -->\s*<p>@@SPACER_(\d+)@@<\/p>\s*<!-- \/wp:paragraph -->/g,
      (_, i) => spacerBlock(spacers[+i]),
    );
    if (markup.includes('@@SPACER_')) {
      console.error('[rawConvert] spacer sentinel survived serialization — forcing fallback');
      return { html: '', wpHtmlResidue: Infinity };
    }
    const wpHtmlResidue = (markup.match(/<!-- wp:html/g) || []).length;
    return { html: markup, wpHtmlResidue };
  } catch (e) {
    console.error('[rawConvert] convert failed:', e && e.message);
    return { html: '', wpHtmlResidue: Infinity };
  }
}

module.exports = { convertHtmlToBlocks };
