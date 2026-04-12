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

// Static adapter imports — add new adapters here
import { wixAdapter } from './adapters/wix.js';
import { squarespaceAdapter } from './adapters/squarespace.js';
import { webflowAdapter } from './adapters/webflow.js';
import { shopifyAdapter } from './adapters/shopify.js';
const adapters: PlatformAdapter[] = [wixAdapter, squarespaceAdapter, webflowAdapter, shopifyAdapter];

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
      description: 'Detect the platform of a website (Wix, Squarespace, Webflow, Shopify, or unknown)',
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
          verbose: { type: 'boolean', description: 'Enable detailed per-page logging' },
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
