import * as cheerio from 'cheerio';
import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import {
  slugify,
  runExtractionLoop,
  extractMeta,
  extractTitle,
  extractHeading,
  extractNavLinks,
  IMAGE_EXTENSIONS,
} from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';

// ---------------------------------------------------------------------------
// Scope (v1)
// ---------------------------------------------------------------------------
// Posts, pages, categories, tags, bylines, media.
// Out of scope: comments, products, custom plugin collections.
// See DISCOVERIES.md and docs/superpowers/specs/2026-04-22-emdash-adapter-design.md
// ---------------------------------------------------------------------------

export interface EmDashAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  limit?: number;
}

export interface EmDashInventory {
  siteUrl: string;
  discoveredAt: string;
  siteMeta: {
    title: string;
    tagline: string;
    language: string;
  };
  navigation: NavLink[];
  counts: Record<string, number>;
  urls: InventoryUrl[];
}

// Upper bound on HTML size we process — matches HubSpot precedent.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Paths EmDash serves locally from the media library.
const LOCAL_MEDIA_PREFIX = '/_emdash/api/media/file/';

// URL paths that appear in sitemap or listing-crawl but are not content pages.
// Filtered out before extraction. Matches /category/foo, /tag/foo, /category/foo/page/2, etc.
const NON_CONTENT_URL_PATTERNS: RegExp[] = [
  /\/category(\/|$)/i,
  /\/tag(\/|$)/i,
  /\/search(\/|$)/i,
  /\/404(\/|$)/i,
  /\/_emdash(\/|$)/i,
];

export const emdashAdapter: PlatformAdapter = {
  id: 'emdash',

  detect(_url: string): boolean {
    // URL-based detection routed through detect-platform.ts (URL_PATTERNS
    // for *.dashhost.cc, SOURCE_SIGNALS for HTML markers, PATH_PROBES for
    // /_emdash/admin). Adapter-level detect intentionally returns false.
    return false;
  },

  async discover(_url: string, _opts: Record<string, unknown>): Promise<EmDashInventory> {
    throw new Error('Not implemented');
  },

  async extract(
    _inventory: unknown,
    _wxr: WxrBuilder,
    _opts: Record<string, unknown>,
    _context: { log: ExtractionLog; server: Server }
  ): Promise<unknown> {
    throw new Error('Not implemented');
  },
};
