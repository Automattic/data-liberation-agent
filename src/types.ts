import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WxrBuilder } from './lib/wxr/index.js';
import type { ExtractionLog } from './lib/resume-state/index.js';
import type { AdapterCapture, AdapterBlocks } from './adapters/page-actions.js';

/**
 * A platform adapter contributes platform-specific knowledge to the pipeline.
 * It does not identify its own platform: detection lives in
 * `lib/detect-platform`, and `resolveAdapter` routes a detected platform id to
 * the adapter that declares it. Keeping identification in one place is what
 * stops a URL pattern from being defined twice and corrected once.
 */
export interface PlatformAdapter {
  /** Platform id this adapter serves. Matched against the detection result. */
  id: string;
  discover(url: string, opts: Record<string, unknown>): Promise<unknown>;
  extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<unknown>;
  probe?(url: string, urls: string[], opts: Record<string, unknown>): Promise<unknown[]>;
  capture?: AdapterCapture;   // NEW (seam 1)
  blocks?: AdapterBlocks;     // NEW (seam 2)
}
