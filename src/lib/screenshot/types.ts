import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { UrlType } from '../extraction/sitemap.js';

export interface Viewport {
  id: 'desktop' | 'mobile';
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORTS: Viewport[] = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'mobile', width: 390, height: 844 },
];

export interface ScreenshotOpts {
  urls: string[];
  outputDir: string;
  primaryUrl?: string;               // reference for same-origin enforcement
  viewports?: Viewport[];
  concurrency?: number;              // default: 6
  browserRestartEvery?: number;      // default: 100
  cdpPort?: number;
  force?: boolean;
  types?: UrlType[];
  limit?: number;
  screenshotTimeoutMs?: number;      // default: 30_000
  evaluateTimeoutMs?: number;        // default: 5_000
  settleMs?: number;                 // default: 1_000
  server?: Server;
  verbose?: boolean;
}

export interface ScreenshotResult {
  captured: number;
  skipped: number;
  failed: number;
  browserRestarts: number;
  durationMs: number;
  manifestPath: string;
}
