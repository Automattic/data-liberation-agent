import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WxrBuilder } from './lib/extraction/wxr-builder.js';
import type { ExtractionLog } from './lib/extraction/extraction-log.js';

export interface PlatformAdapter {
  id: string;
  detect(url: string): boolean;
  discover(url: string, opts: Record<string, unknown>): Promise<unknown>;
  extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<unknown>;
  probe?(url: string, urls: string[], opts: Record<string, unknown>): Promise<unknown[]>;
}
