import { load } from 'cheerio';
import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';
import { getSourceResponse } from '../../lib/browser-kit/source-traffic.js';
import { PANEL_REPLAY_ATTRIBUTES, rewritePanelReplayHtml } from '../../lib/panel-replay-state.js';

export function authoredEmbedDocument(source: string, url: string): string | undefined {
  const $source = load(source, { xml: false }, false);
  const authored = $source('[data-is-interactive-full-page-embed="true"]').first().attr('data-code');
  if (!authored) return undefined;
  const $document = load(authored, { xml: false });
  const href = url.replace(/[&\"<>]/g, (char) => ({ '&': '&amp;', '\"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]!));
  if ($document('head').length) $document('head').prepend(`<base href="${href}">`);
  else $document('html').prepend(`<head><base href="${href}"></head>`);
  // The embed renders inside Google's viewer, so visitors see the viewer's title.
  const title = $source('title').first().text().trim();
  if (title) {
    $document('title').remove();
    $document('head').append($document('<title>').text(title));
  }
  return $document.html();
}

const NAVIGATION_SETTLE_STYLE_ID = 'google-sites-navigation-settle';

/** Closure identifiers are needed while Google's runtime drives capture probes.
 * Strip only from frozen artifacts, including serialized interaction panels. */
export function canonicalizeGoogleSitesHtml(html: string): string {
  // Documents keep their doctype (standards mode); serialized panels stay fragments.
  const document = /<(?:!doctype|html|head|body)\b/i.test(html);
  const $ = load(html, { xml: false }, document);
  // URL tiles need Google's postMessage runtime to populate the intermediate
  // frame. Frozen HTML embeds the declared destination directly, without
  // replacing the tile's wrappers or its measured sizing. Keep the attested
  // source in sync: portable iframe sanitization uses it instead of src.
  $('div.w536ob[data-url]').each((_index, element) => {
    const tile = $(element);
    const url = tile.attr('data-url')?.trim();
    if (!url) return;
    tile.find('iframe').each((_frameIndex, frame) => {
      const iframe = $(frame);
      iframe.attr('src', url);
      if (iframe.attr('data-blocks-engine-capture-visual-iframe-src') !== undefined) {
        iframe.attr('data-blocks-engine-capture-visual-iframe-src', url);
      }
    });
  });
  // Selection has one portable spelling. Google's runtime keeps its classes
  // while probes run; frozen styling follows aria-current instead.
  $('.PsKE7e').removeClass('M9vuGd lhZOrc');
  $('style').each((_index, element) => {
    const style = $(element);
    const text = style.text();
    if (/\.(?:M9vuGd|lhZOrc)\b/.test(text)) style.text(text.replace(/\.(?:M9vuGd|lhZOrc)\b/g, '[aria-current="true"]'));
  });
  $(`#${NAVIGATION_SETTLE_STYLE_ID}`).remove();
  // Overflow writes aria-hidden as a snapshot of the last resize; learned
  // width classes own the items' visibility in the frozen copy.
  $('nav li[data-nav-level]').removeAttr('aria-hidden');
  $('nav [style=""]').removeAttr('style');
  // A serialized panel is shared navigation, not the page it was probed on.
  if (!document) $('[aria-current], [aria-selected]').removeAttr('aria-current').removeAttr('aria-selected');
  const rewritePanel = (html: string): string => {
    const panel = load(canonicalizeGoogleSitesHtml(html), { xml: false }, false);
    panel('[data-blocks-engine-node-id]').removeAttr('data-blocks-engine-node-id');
    return panel.html();
  };
  $(PANEL_REPLAY_ATTRIBUTES.map(attribute => `[${attribute}]`).join(', ')).each((_index, element) => {
    for (const attribute of PANEL_REPLAY_ATTRIBUTES) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try { $(element).attr(attribute, JSON.stringify(rewritePanelReplayHtml(JSON.parse(value), rewritePanel))); }
      catch { /* Malformed evidence is left for its owning validator. */ }
    }
  });
  $('*').each((_index, element) => {
    for (const attribute of ['jscontroller', 'jsaction', 'jsname', 'jsmodel', 'jsshadow', 'jsslot', 'jsowner', 'data-idom-class']) {
      $(element).removeAttr(attribute);
    }
  });
  return $.html();
}

export const googleSitesAdapter: PlatformAdapter = {
  id: 'google-sites',
  detection,
  discover: discoverDefault,
  liberation: {
    async prepare(page) {
      // Top-navigation overflow subtracts the header's padding while it is
      // still transitioning, so the same width yields route-dependent "More"
      // membership. Settle that padding for the probe; canonicalization drops it.
      await page.addStyleTag({ content: '.VLoccc { transition-property: opacity !important; }' })
        .then(style => style.evaluate((node, id) => { (node as HTMLElement).id = id; }, NAVIGATION_SETTLE_STYLE_ID));
    },
    async loadDocument(page, url, timeout) {
      const response = await getSourceResponse(page.context(), url, { timeout, maxRedirects: 0 });
      try {
        if (!response.ok()) return undefined;
        const source = await response.text();
        const html = authoredEmbedDocument(source, url);
        // Google's viewer headers carry a nonce-only script CSP written for its own
        // runtime; the authored document loads its own scripts, so serve it as plain HTML.
        return html ? { html, headers: { 'content-type': 'text/html; charset=utf-8' } } : undefined;
      } finally { await response.dispose(); }
    },
    // Platform identities, not text matches: owner links to Google Sites and
    // authored buttons/sections must survive, including translated content.
    removeSelectors: [
      'button[jsname="z2EeY"]', // Skip to main content
      'button[jsname="ilzYPe"]', // Skip to navigation
      '.LqzjUe', // Floating Site actions menu and its compact footer variant
      // "Last updated" container holding the Site actions trigger. Its menu
      // (Report abuse, Page details) mounts only on click, so removing the
      // trigger before probing keeps that menu out of captured panels.
      '[data-last-updated-at-time]',
      '[data-abuse-reporting-widget-proto]',
      '[role="dialog"]:has([data-abuse-reporting-widget-proto])',
      '[role="dialog"][aria-label="Report abuse"]',
      'a[href^="https://sites.google.com/new"][href*="usp=viewer_footer"]', // Google Sites badge
    ],
    canonicalizeHtml: canonicalizeGoogleSitesHtml,
  },
};
