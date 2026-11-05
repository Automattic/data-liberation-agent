import { load } from 'cheerio';
import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';

/** Closure identifiers are needed while Google's runtime drives capture probes.
 * Strip only from frozen artifacts, including serialized interaction panels. */
export function canonicalizeGoogleSitesHtml(html: string): string {
  const $ = load(html, { xml: false }, false);
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
