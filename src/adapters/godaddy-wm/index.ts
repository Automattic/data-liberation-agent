import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';

/** Preserve the date exposed only through GoDaddy's runtime blog model. */
async function preservePublicationEvidence(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => {
    const post = (window as typeof window & {
      _BLOG_DATA?: { post?: { publishedDate?: unknown } };
    })._BLOG_DATA?.post;
    const publishedDate = post?.publishedDate;
    if (typeof publishedDate !== 'string' || Number.isNaN(Date.parse(publishedDate))) return;
    if (document.head.querySelector('meta[property="article:published_time"]')) return;
    const meta = document.createElement('meta');
    meta.setAttribute('property', 'article:published_time');
    meta.setAttribute('content', publishedDate);
    document.head.appendChild(meta);
  });
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { GoDaddyWmAdapterOpts, GoDaddyWmInventory } from './types.js';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const godaddyWmAdapter: PlatformAdapter = {
  id: 'godaddy-wm',
  detection,
  discover,
  liberation: {
    cleanupRules: [
      { id: 'godaddy-freemium-acquisition', category: 'source-attribution', selector: '[data-freemium-ad="true"]' },
      ...providerCreditRules('godaddy', ['godaddy.com'], 'GoDaddy'),
    ],
    beforeSerialize: async (page) => preservePublicationEvidence(page),
  },
};
