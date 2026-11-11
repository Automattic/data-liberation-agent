import type { InventoryUrl } from '../shared.js';
import type { NavLink } from '../../lib/html-extract/index.js';

/** Legacy rich inventory retained by specialized discovery (Blogger and tenant sites). */
export interface DefaultInventory {
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
  diagnostics?: Array<{ code: string; url: string; reason: string }>;
}
