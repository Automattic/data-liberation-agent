// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PlatformAdapter } from './types.js';
import { detect } from './lib/extraction/detect-platform.js';
import { fetchSitemap, classifyUrl } from './lib/extraction/sitemap.js';
import { ExtractionLog } from './lib/extraction/extraction-log.js';
import { WxrBuilder } from './lib/extraction/wxr-builder.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Static adapter imports — add new adapters here (alphabetical)
import { godaddyWmAdapter } from './adapters/godaddy-wm.js';
import { hostingerAdapter } from './adapters/hostinger.js';
import { hubspotAdapter } from './adapters/hubspot.js';
import { shopifyAdapter } from './adapters/shopify.js';
import { squarespaceAdapter } from './adapters/squarespace.js';
import { webflowAdapter } from './adapters/webflow.js';
import { weeblyAdapter } from './adapters/weebly.js';
import { wixAdapter } from './adapters/wix.js';
const adapters: PlatformAdapter[] = [godaddyWmAdapter, hostingerAdapter, hubspotAdapter, shopifyAdapter, squarespaceAdapter, webflowAdapter, weeblyAdapter, wixAdapter];

function findAdapter(platform: string): PlatformAdapter | null {
  return adapters.find((a) => a.id === platform) || null;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const server = new Server(
  { name: 'data-liberation', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'liberate_detect',
      description: 'Detect the platform of a website (GoDaddy Websites & Marketing, Hostinger, HubSpot, Shopify, Squarespace, Webflow, Weebly, Wix, or unknown)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL of the website to detect' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_discover',
      description: 'Inventory a website: fetch sitemap, categorize URLs, extract navigation structure',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL of the website to inventory' },
          token: { type: 'string', description: 'API token for platforms requiring auth' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based extraction' },
          verbose: { type: 'boolean', description: 'Enable detailed logging' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_inspect',
      description: "Probe a site to assess extractability: detect platform, check sitemap, probe sample pages",
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL of the website to inspect' },
          token: { type: 'string', description: 'API token if needed' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based inspection' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_extract',
      description: 'Extract all content from a website. Produces WXR file + media directory + redirect map.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL of the website to extract' },
          outputDir: { type: 'string', description: 'Directory to write WXR, media, and logs' },
          token: { type: 'string', description: 'API token for platforms requiring auth (e.g. Webflow)' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based extraction' },
          adminToken: { type: 'string', description: 'Shopify Admin API access token. When set, products are fetched via the Shopify Admin GraphQL API for richer data (compareAtPrice, inventoryPolicy, unitCost, collections, SEO metafields, variant images). Falls back to the public JSON API on failure.' },
          shopDomain: { type: 'string', description: 'Shopify *.myshopify.com hostname. Usually auto-detected by liberate_discover from the storefront HTML; only pass explicitly if detection failed (e.g. Cloudflare-protected site).' },
          delay: { type: 'number', description: 'Delay between requests in ms (default: 500)' },
          resume: { type: 'boolean', description: 'Resume a previous extraction' },
          dryRun: { type: 'boolean', description: 'Extract 2-3 pages and report without writing WXR' },
          limit: { type: 'number', description: 'Cap extraction to the first N URLs and write a real WXR for them' },
          verbose: { type: 'boolean', description: 'Enable detailed per-page logging' },
          screenshots: { type: 'boolean', description: 'After extract completes, capture screenshots (desktop + mobile) for every processed URL. Results are written to output/<site>/screenshots/ with a manifest.json keyed by URL.' },
        },
        required: ['url', 'outputDir'],
      },
    },
    {
      name: 'liberate_status',
      description: 'Check progress of a running or completed extraction',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'The output directory of the extraction' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_map_apis',
      description: 'Map all API endpoints used by a website by navigating pages via CDP and capturing JSON network traffic. Produces a categorized endpoint catalog with sample responses and auth headers. Use during /adapt reconnaissance to reverse-engineer a new platform.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cdpPort: { type: 'number', description: 'Chrome DevTools Protocol port (e.g. 9222)' },
          url: { type: 'string', description: 'The URL of the site to map' },
          crawlUrls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional URLs to navigate (e.g. admin dashboard sections)',
          },
          followLinks: { type: 'boolean', description: 'Follow same-origin links from the main page (up to 20, default: false)' },
        },
        required: ['cdpPort', 'url'],
      },
    },
    {
      name: 'liberate_probe',
      description: 'Probe a browser page via CDP for extraction-relevant data: window globals, JSON-LD, cookies, localStorage, network entries, and platform identity fields. Requires a running Chrome with --remote-debugging-port. Use for debugging extraction failures.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cdpPort: { type: 'number', description: 'Chrome DevTools Protocol port (e.g. 9222)' },
          url: { type: 'string', description: 'Only probe pages on this domain (optional — probes all tabs if omitted)' },
        },
        required: ['cdpPort'],
      },
    },
    {
      name: 'liberate_qa',
      description: 'Compare extracted WXR content against the original source site page by page. Reports text similarity, missing headings/images/links, and grades each page (pass/warn/fail). Optionally patches fixable issues like missing alt text.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          wxrFile: { type: 'string', description: 'Path to the WXR file to QA' },
          fix: { type: 'boolean', description: 'Patch fixable issues in the WXR (default: false)' },
        },
        required: ['wxrFile'],
      },
    },
    {
      name: 'liberate_verify',
      description: 'Verify a completed extraction: check for stale CDN URLs, failed pages, missing media, and items needing manual attention',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'The output directory of the extraction to verify' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_setup',
      description: 'Validate WordPress connection: check site reachability, REST API, and authentication. Returns guidance if anything fails. Pass delegate: true to skip validation and receive a structured manifest describing what the import target needs — useful when the calling environment handles site setup itself.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          site: { type: 'string', description: 'WordPress site domain (e.g. mysite.com or localhost:8881)' },
          username: { type: 'string', description: 'WordPress username' },
          token: { type: 'string', description: 'WordPress application password' },
          delegate: { type: 'boolean', description: 'Skip validation and return a setup manifest for the calling environment to handle. Use when the environment has its own site management (e.g. local dev tools).' },
        },
        required: [],
      },
    },
    {
      name: 'liberate_import',
      description: 'Import a WXR file into a WordPress site. Pass delegate: true to skip REST import and receive a structured import manifest — useful when the calling environment handles imports itself (e.g. local dev tools with direct database/CLI access).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          wxrFile: { type: 'string', description: 'Path to the WXR file to import' },
          site: { type: 'string', description: 'WordPress site domain (e.g. example.com)' },
          username: { type: 'string', description: 'WordPress username' },
          token: { type: 'string', description: 'WordPress application password' },
          dryRun: { type: 'boolean', description: 'Preview without importing' },
          delay: { type: 'number', description: 'Delay between requests in ms (default: 500)' },
          only: { type: 'string', description: 'Only import specific type (categories, tags, media, pages, posts, comments, menus)' },
          verbose: { type: 'boolean', description: 'Enable detailed logging' },
          resume: { type: 'boolean', description: '(deprecated — import is always idempotent, this flag has no effect)' },
          importAuthors: { type: 'boolean', description: 'Create WordPress users for each author in the WXR (default: false — all content owned by authenticated user)' },
          woocommerceKey: { type: 'string', description: 'WooCommerce consumer key for product import' },
          woocommerceSecret: { type: 'string', description: 'WooCommerce consumer secret for product import' },
          delegate: { type: 'boolean', description: 'Skip REST import and return a structured import manifest for the calling environment to handle.' },
        },
        required: ['wxrFile'],
      },
    },
    {
      name: 'liberate_preview',
      description: 'Spawn a local WordPress Playground preview of an extraction output. Returns { url, pid, port, status, warnings }. Kills any existing preview on the same outputDir before starting.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Path to the extraction output directory (contains output.wxr).' },
          open: { type: 'boolean', description: 'If true, open the URL in the default browser after readiness.' },
          port: { type: 'number', description: 'Override the auto-picked port (default range: 9400-9499).' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_preview_stop',
      description: 'Stop a running Playground preview by outputDir.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Path to the extraction output directory.' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_screenshot',
      description: 'Capture full-page + scrolled screenshots (desktop + mobile) and rendered HTML for every URL on a site. Writes to <outputDir>/screenshots/ and <outputDir>/html/, plus palette.json and typography.json via site-analysis. Reuses sitemap discovery or accepts explicit urls[].',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Site URL (used for sitemap discovery and same-origin enforcement)' },
          outputDir: { type: 'string', description: 'Output directory' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Explicit URL list (skips sitemap fetch; all must share origin with `url` if both provided)' },
          types: { type: 'array', items: { type: 'string' }, description: 'Filter by URL type: page, post, product, homepage, gallery, event' },
          limit: { type: 'number', description: 'Cap to first N URLs' },
          concurrency: { type: 'number', description: 'Parallel URL captures (default 3, max 10)' },
          browserRestartEvery: { type: 'number', description: 'Close and relaunch browser every N URLs (default 100)' },
          cdpPort: { type: 'number', description: 'Connect to existing Chrome via CDP' },
          force: { type: 'boolean', description: 'Re-capture even if output files already exist' },
          verbose: { type: 'boolean', description: 'Per-URL progress logging' },
        },
        required: ['url', 'outputDir'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const typedArgs = args as Record<string, unknown>;

  switch (name) {
    case 'liberate_detect': {
      const result = await detect(typedArgs.url as string);
      return textResult(result);
    }

    case 'liberate_discover': {
      const detection = await detect(typedArgs.url as string);
      const adapter = findAdapter(detection.platform);
      if (!adapter) {
        return errorResult(
          `No adapter available for platform: ${detection.platform}. Supported: ${
            adapters.map((a) => a.id).join(', ') || 'none (install an adapter)'
          }`
        );
      }
      const opts = {
        token: typedArgs.token,
        cdpPort: typedArgs.cdpPort,
        verbose: typedArgs.verbose,
      };
      const inventory = await adapter.discover(typedArgs.url as string, opts);

      // Detect platform-specific features from discovered URLs
      const { detectFeatures } = await import('./lib/features/detect-features.js');
      const inv = inventory as { urls?: Array<{ url: string }> };
      const urls = (inv.urls || []).map((u) => u.url);
      const platformFeatures = detectFeatures(detection.platform, urls, []);

      return textResult({ ...inventory as object, platformFeatures });
    }

    case 'liberate_inspect': {
      const detection = await detect(typedArgs.url as string);
      const result: Record<string, unknown> = {
        url: typedArgs.url,
        platform: detection.platform,
        confidence: detection.confidence,
        signals: detection.signals,
        sitemapFound: false,
        urlCount: 0,
        counts: {} as Record<string, number>,
        probeResults: [],
        authRequired: false,
        extractionFeasibility: detection.platform === 'unknown' ? 'limited' : 'ready',
      };

      const urls = await fetchSitemap(typedArgs.url as string);
      result.sitemapFound = urls.length > 0;
      result.urlCount = urls.length;

      const counts: Record<string, number> = {};
      for (const url of urls) {
        const type = classifyUrl(url);
        counts[type] = (counts[type] || 0) + 1;
      }
      result.counts = counts;

      const adapter = findAdapter(detection.platform);
      if (adapter && typeof adapter.probe === 'function') {
        const opts = { token: typedArgs.token, cdpPort: typedArgs.cdpPort };
        result.probeResults = await adapter.probe(typedArgs.url as string, urls.slice(0, 3), opts);
      }

      // Detect platform-specific features
      const { detectFeatures } = await import('./lib/features/detect-features.js');
      const featureUrls = urls.length > 0 ? urls : [typedArgs.url as string];
      result.platformFeatures = detectFeatures(detection.platform, featureUrls, []);

      return textResult(result);
    }

    case 'liberate_extract': {
      const detection = await detect(typedArgs.url as string);
      const adapter = findAdapter(detection.platform);
      if (!adapter) {
        return errorResult(`No adapter available for platform: ${detection.platform}`);
      }

      const outputDir = typedArgs.outputDir as string;
      mkdirSync(outputDir, { recursive: true });

      const log = new ExtractionLog(outputDir);

      if (!log.acquireLock()) {
        return errorResult(
          'Extraction already in progress in this directory. Use a different outputDir or wait for the current extraction to complete.'
        );
      }

      try {
        const opts = {
          token: typedArgs.token,
          cdpPort: typedArgs.cdpPort,
          adminToken: typedArgs.adminToken,
          shopDomain: typedArgs.shopDomain,
          delay: typedArgs.delay,
          resume: typedArgs.resume,
          dryRun: typedArgs.dryRun,
          limit: typedArgs.limit,
          verbose: typedArgs.verbose,
          outputDir,
        };

        const inventory = (await adapter.discover(typedArgs.url as string, opts)) as {
          siteMeta?: { title?: string; tagline?: string; language?: string };
        };
        const wxr = new WxrBuilder({
          title: inventory.siteMeta?.title || 'Imported Site',
          url: typedArgs.url as string,
          description: inventory.siteMeta?.tagline || '',
          language: inventory.siteMeta?.language || 'en-US',
        });

        await adapter.extract(inventory, wxr, opts, { log, server });

        const wxrPath = join(outputDir, 'output.wxr');
        if (!typedArgs.dryRun && wxr.items.length > 0) {
          wxr.serialize(wxrPath);
        }

        // --- Optional screenshot capture ---
        // The manifest at output/<site>/screenshots/manifest.json is keyed by
        // URL; filesystem-level joins against output.wxr / products.jsonl happen
        // out-of-band (no WordPress-side postmeta injection).
        let screenshotResult: import('./lib/screenshot/types.js').ScreenshotResult | undefined;
        if (typedArgs.screenshots && !typedArgs.dryRun) {
          const { ImportSession } = await import('./lib/extraction/import-session.js');
          // resume:true — we're continuing the same run the adapter just ran,
          // not starting a new one. Preserves the session.json the adapter
          // persisted (cursors, counters) so `liberate_status` reflects state.
          const session = ImportSession.loadOrCreate(outputDir, detection.platform, opts, { resume: true });
          session.setStage('screenshotting');
          const processedUrls = Array.from(log.getProcessedUrls());
          const { captureScreenshots } = await import('./lib/screenshot/screenshotter.js');
          screenshotResult = await captureScreenshots({
            urls: processedUrls,
            outputDir,
            primaryUrl: typedArgs.url as string,
            server,
          });
          session.setStage('finalizing');
        }

        const summary = log.getSummary();
        const validation = typedArgs.dryRun ? { valid: true, warnings: [] } : wxr.validate();

        const qualityScores = { high: 0, medium: 0, low: 0 };
        for (const entry of summary.processed) {
          const score = (entry as Record<string, unknown>).qualityScore as string;
          if (score === 'high' || score === 'medium' || score === 'low') {
            qualityScores[score]++;
          }
        }

        return textResult({
          wxrPath: typedArgs.dryRun ? null : wxrPath,
          redirectMapPath:
            wxr.redirects.length > 0 ? join(outputDir, 'redirect-map.json') : null,
          outputDir,
          summary: {
            pagesExtracted: wxr.items.filter((i) => i.type === 'page').length,
            postsExtracted: wxr.items.filter((i) => i.type === 'post').length,
            mediaDownloaded: summary.mediaDownloaded.length,
            mediaFailed: summary.mediaFailed.length,
            categoriesFound: wxr.categories.length,
            tagsFound: wxr.tags.length,
            menuItemsFound: wxr.items.filter((i) => i.type === 'nav_menu_item').length,
            failedUrls: summary.failed.length,
            qualityScores,
          },
          failures: summary.failed.map((f) => ({
            url: (f as Record<string, unknown>).url,
            error: (f as Record<string, unknown>).error,
          })),
          wxrValidation: validation,
          dryRun: !!typedArgs.dryRun,
          ...(screenshotResult ? { screenshots: screenshotResult } : {}),
        });
      } finally {
        log.releaseLock();
      }
    }

    case 'liberate_qa': {
      const { runQa } = await import('./lib/qa/qa-runner.js');
      const result = await runQa({
        wxrFile: typedArgs.wxrFile as string,
        fix: (typedArgs.fix as boolean) ?? false,
        onProgress: (current, total, slug) => {
          server.sendLoggingMessage({
            level: 'info',
            data: `[qa] ${current}/${total} ${slug}`,
          });
        },
      });
      return textResult(result);
    }

    case 'liberate_map_apis': {
      const { mapApis } = await import('./lib/probe/map-apis.js');
      const result = await mapApis({
        cdpPort: typedArgs.cdpPort as number,
        url: typedArgs.url as string,
        crawlUrls: (typedArgs.crawlUrls as string[]) ?? [],
        followLinks: (typedArgs.followLinks as boolean) ?? false,
      });
      return textResult(result);
    }

    case 'liberate_probe': {
      const { probeBrowser } = await import('./lib/probe/browser-probe.js');
      const results = await probeBrowser(
        typedArgs.cdpPort as number,
        typedArgs.url as string | undefined,
      );
      return textResult(results);
    }

    case 'liberate_verify': {
      const { verifyExtraction } = await import('./lib/verification/verify.js');
      const report = await verifyExtraction(typedArgs.outputDir as string);
      return textResult(report);
    }

    case 'liberate_setup': {
      // Delegate mode: return a manifest for the calling environment
      if (typedArgs.delegate) {
        return textResult({
          mode: 'delegate',
          manifest: {
            description: 'A running WordPress site is needed to receive the imported content.',
            requirements: [
              'A WordPress site must be available and running',
              'The site should have the WordPress Importer plugin installed and activated',
              'If products will be imported, WooCommerce should be installed and activated',
            ],
          },
        });
      }

      // REST API mode: validate connection
      const { validateWpConnection } = await import('./lib/setup/wp-setup.js');
      const report = await validateWpConnection({
        site: typedArgs.site as string,
        username: typedArgs.username as string,
        token: typedArgs.token as string,
      });
      return textResult(report);
    }

    case 'liberate_import': {
      const wxrFile = typedArgs.wxrFile as string;

      // Delegate mode: return a structured import manifest
      if (typedArgs.delegate) {
        const outputDir = join(wxrFile, '..');
        const { existsSync } = await import('fs');
        const mediaDir = join(outputDir, 'media');
        const productsCsvPath = join(outputDir, 'products.csv');
        const redirectMapPath = join(outputDir, 'redirect-map.json');

        return textResult({
          mode: 'delegate',
          manifest: {
            wxrFile,
            outputDir,
            mediaDir: existsSync(mediaDir) ? mediaDir : null,
            productsCsv: existsSync(productsCsvPath) ? productsCsvPath : null,
            redirectMap: existsSync(redirectMapPath) ? redirectMapPath : null,
            importAuthors: (typedArgs.importAuthors as boolean) ?? false,
          },
        });
      }

      // REST API mode: import directly
      try {
        const { importToWordPress } = await import('./lib/import/wp-importer.js');
        const { resolveSiteUrl } = await import('./lib/import/resolve-site-url.js');
        const resolvedSite = await resolveSiteUrl(typedArgs.site as string);
        const importResult = await importToWordPress({
          wxrFile,
          site: resolvedSite,
          username: typedArgs.username as string,
          token: typedArgs.token as string,
          dryRun: (typedArgs.dryRun as boolean) ?? false,
          delay: (typedArgs.delay as number) ?? 500,
          only: (typedArgs.only as string) ?? undefined,
          resume: (typedArgs.resume as boolean) ?? false,
          verbose: (typedArgs.verbose as boolean) ?? false,
          importAuthors: (typedArgs.importAuthors as boolean) ?? false,
          woocommerceKey: (typedArgs.woocommerceKey as string) ?? undefined,
          woocommerceSecret: (typedArgs.woocommerceSecret as string) ?? undefined,
          onProgress: (stage, current, total, label) => {
            server.sendLoggingMessage({
              level: 'info',
              data: `[${stage}] ${current}/${total} ${label}`,
            });
          },
        });
        return textResult(importResult);
      } catch (err) {
        return errorResult(`Import failed: ${(err as Error).message}`);
      }
    }

    case 'liberate_status': {
      const outputDir = typedArgs.outputDir as string;

      const log = new ExtractionLog(outputDir);
      const running = log.isLockActive();
      const summary = log.getSummary();

      return textResult({
        running,
        processed: summary.processed.length,
        remaining: 0,
        failed: summary.failed.length,
        currentUrl: null,
        elapsedMs: null,
        estimatedRemainingMs: null,
      });
    }

    case 'liberate_preview': {
      const { startPreview } = await import('./lib/preview/playground-server.js');
      const result = await startPreview({
        outputDir: typedArgs.outputDir as string,
        open: typedArgs.open as boolean | undefined,
        port: typedArgs.port as number | undefined,
        detached: true,
      });
      if (result.status === 'ready' && typedArgs.open && result.url) {
        const { spawn, execFileSync } = await import('node:child_process');
        const openBrowser = () => {
          const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
          try {
            spawn(cmd, [`${result.url}/wp-admin/`], { detached: true, stdio: 'ignore' }).unref();
          } catch { /* best-effort */ }
        };
        const openStudioApp = (): boolean => {
          try {
            if (process.platform === 'darwin') {
              spawn('open', ['-a', 'Studio'], { detached: true, stdio: 'ignore' }).unref();
              return true;
            }
            if (process.platform === 'win32') {
              spawn('cmd', ['/c', 'start', '', 'Studio'], { detached: true, stdio: 'ignore' }).unref();
              return true;
            }
            if (process.platform === 'linux') {
              const customCmd = process.env.STUDIO_APP_CMD;
              if (customCmd) {
                spawn('sh', ['-c', customCmd], { detached: true, stdio: 'ignore' }).unref();
                return true;
              }
              for (const bin of ['Studio', 'studio-app', 'wp-studio']) {
                try {
                  execFileSync('which', [bin], { stdio: 'ignore', timeout: 1000 });
                  spawn(bin, [], { detached: true, stdio: 'ignore' }).unref();
                  return true;
                } catch { /* try next */ }
              }
            }
            return false;
          } catch { return false; }
        };
        if (result.source === 'studio' && openStudioApp()) {
          /* launched Studio app */
        } else {
          openBrowser();
        }
      }
      return textResult(result);
    }

    case 'liberate_preview_stop': {
      const { stopPreview } = await import('./lib/preview/playground-server.js');
      const result = await stopPreview({ outputDir: typedArgs.outputDir as string });
      return textResult(result);
    }

    case 'liberate_screenshot': {
      const url = typedArgs.url as string;
      const outputDir = typedArgs.outputDir as string;
      // mkdirSync BEFORE acquireLock — lockfile write needs the directory to exist.
      mkdirSync(outputDir, { recursive: true });
      const log = new ExtractionLog(outputDir);
      if (!log.acquireLock()) {
        return errorResult('Another liberation workflow is already running in this outputDir.');
      }
      try {
        let urls: string[] = Array.isArray(typedArgs.urls) ? (typedArgs.urls as string[]) : [];
        if (urls.length === 0) {
          urls = await fetchSitemap(url);
        }
        const { captureScreenshots } = await import('./lib/screenshot/screenshotter.js');
        const result = await captureScreenshots({
          urls,
          outputDir,
          primaryUrl: url,
          types: typedArgs.types as import('./lib/extraction/sitemap.js').UrlType[] | undefined,
          limit: typedArgs.limit as number | undefined,
          concurrency: typedArgs.concurrency as number | undefined,
          browserRestartEvery: typedArgs.browserRestartEvery as number | undefined,
          cdpPort: typedArgs.cdpPort as number | undefined,
          force: typedArgs.force as boolean | undefined,
          verbose: typedArgs.verbose as boolean | undefined,
          server,
        });
        return textResult(result);
      } finally {
        log.releaseLock();
      }
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
