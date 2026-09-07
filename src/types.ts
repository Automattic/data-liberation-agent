import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WxrBuilder } from './lib/wxr/index.js';
import type { ExtractionLog } from './lib/resume-state/index.js';
import type { AdapterBlocks } from './adapters/page-actions.js';
import type { Platform } from './platform/types.js';

/**
 * Legacy adapter shape: a registered Platform whose WordPress-extraction-era
 * members are still required. Retained until #119 removes the extract-era
 * callers; new code (including third-party platforms) should target the
 * public Platform contract in src/platform/types.ts, where discovery is the
 * only required capability and detection signals live on the platform.
 */
export interface PlatformAdapter extends Platform {
  extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<unknown>;
  probe?(url: string, urls: string[], opts: Record<string, unknown>): Promise<unknown[]>;
  blocks?: AdapterBlocks;     // NEW (seam 2)
}
