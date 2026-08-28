import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ExtractionLog } from './lib/resume-state/index.js';
import type { AdapterCapture, AdapterBlocks } from './adapters/page-actions.js';

export interface PlatformAdapter {
  id: string;
  detect(url: string): boolean;
  discover(url: string, opts: Record<string, unknown>): Promise<unknown>;
  probe?(url: string, urls: string[], opts: Record<string, unknown>): Promise<unknown[]>;
  capture?: AdapterCapture;   // NEW (seam 1)
  blocks?: AdapterBlocks;     // NEW (seam 2)
}
