// src/mcp-server.ts
//
// Thin router. Tool listing lives below; per-tool logic lives in
// src/mcp-server/handlers/<tool>.ts. The dispatch map at the bottom maps
// tool names to handler modules.
//
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { PlatformAdapter } from './types.js';

import type { Handler, HandlerContext, ToolResult } from './mcp-server/handler-types.js';
import { detectHandler } from './mcp-server/handlers/detect.js';
import { discoverHandler } from './mcp-server/handlers/discover.js';
import { inspectHandler } from './mcp-server/handlers/inspect.js';
import { extractHandler } from './mcp-server/handlers/extract.js';
import { extractOneHandler } from './mcp-server/handlers/extract-one.js';
import { mediaInstallHandler } from './mcp-server/handlers/media-install.js';
import { replicateTickHandler } from './mcp-server/handlers/replicate-tick.js';
import { blockTransformApplyHandler } from './mcp-server/handlers/block-transform-apply.js';
import { blockComposeHandler } from './mcp-server/handlers/block-compose.js';
import { qaHandler } from './mcp-server/handlers/qa.js';
import { mapApisHandler } from './mcp-server/handlers/map-apis.js';
import { probeHandler } from './mcp-server/handlers/probe.js';
import { verifyHandler } from './mcp-server/handlers/verify.js';
import { setupHandler } from './mcp-server/handlers/setup.js';
import { wpImportHandler } from './mcp-server/handlers/wp-import.js';
import { statusHandler } from './mcp-server/handlers/status.js';
import { previewHandler } from './mcp-server/handlers/preview.js';
import { installThemeHandler } from './mcp-server/handlers/install-theme.js';
import { themeScaffoldHandler } from './mcp-server/handlers/theme-scaffold.js';
import { previewStopHandler } from './mcp-server/handlers/preview-stop.js';
import { screenshotHandler } from './mcp-server/handlers/screenshot.js';
import { designFoundationScaffoldHandler } from './mcp-server/handlers/design-foundation-scaffold.js';
import { designFoundationValidateHandler } from './mcp-server/handlers/design-foundation-validate.js';
import { designFoundationSaveHandler } from './mcp-server/handlers/design-foundation-save.js';
import { replicateInventoryHandler } from './mcp-server/handlers/replicate-inventory.js';
import { replicateVerifyHandler } from './mcp-server/handlers/replicate-verify.js';
import { compareHandler } from './mcp-server/handlers/compare.js';

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

function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
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
          captureDesign: { type: 'boolean', description: 'Enable html-first design replication: carry source HTML+CSS as the page/post design. Note: full html-first design capture (site.css aggregation, blank theme install) runs via the CLI (`data-liberation --html-first`); this flag is reserved for future MCP support.' },
        },
        required: ['url', 'outputDir'],
      },
    },
    {
      name: 'liberate_extract_one',
      description: 'Extract a single URL through the streaming pipeline. Used by the watch loop and agent-driven streaming. Each call runs adapter discovery to set up state, then narrows to the target URL. Append-mode WXR — results accumulate in output.wxr across calls.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The single URL to extract.' },
          outputDir: { type: 'string', description: 'Liberation output directory. WXR + media + logs are appended here.' },
          siteUrl: { type: 'string', description: 'Origin of the source site, used for adapter discovery. Defaults to the origin parsed from `url`.' },
          token: { type: 'string', description: 'API token for platforms requiring auth (e.g. Webflow).' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based extraction.' },
          adminToken: { type: 'string', description: 'Shopify Admin API token (see liberate_extract).' },
          shopDomain: { type: 'string', description: 'Shopify *.myshopify.com hostname (see liberate_extract).' },
          delay: { type: 'number', description: 'Delay floor in ms.' },
          verbose: { type: 'boolean', description: 'Per-step logging.' },
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
      description: 'Spawn a local WordPress Playground (or Studio) preview of an extraction output. Returns { url, pid, port, status, warnings }. Kills any existing preview on the same outputDir before starting. Optionally installs a generated replica theme + block plugins via themeFiles[] + blockPlugins[]; the theme is activated after content import. Used by the replicate skill in Step 5 (Install).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Path to the extraction output directory (contains output.wxr).' },
          open: { type: 'boolean', description: 'If true, open the URL in the default browser after readiness.' },
          port: { type: 'number', description: 'Override the auto-picked port (default range: 9400-9499).' },
          themeFiles: {
            type: 'array',
            description: 'Generated replica theme files. Each entry is { relativePath, content } rooted at the theme directory (e.g. relativePath: "templates/index.html"). Theme is written to wp-content/themes/<themeSlug>/ and activated after content import.',
            items: {
              type: 'object' as const,
              properties: {
                relativePath: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['relativePath', 'content'],
            },
          },
          blockPlugins: {
            type: 'array',
            description: 'DEPRECATED — embed custom blocks inside the theme at blocks/<slug>/{src,build}/ via themeFiles[] instead (Telex blocks-inside-themes pattern, registered from functions.php). Kept for backwards compatibility. Each entry is { slug, files: [{relativePath, content}] }; plugin is written to wp-content/plugins/<slug>/ and activated.',
            items: {
              type: 'object' as const,
              properties: {
                slug: { type: 'string' },
                files: {
                  type: 'array',
                  items: {
                    type: 'object' as const,
                    properties: {
                      relativePath: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['relativePath', 'content'],
                  },
                },
              },
              required: ['slug', 'files'],
            },
          },
          themeSlug: { type: 'string', description: 'Theme directory name (kebab-case). Required when themeFiles is non-empty. Conventionally <siteSlug>-replica.' },
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
      name: 'liberate_install_theme',
      description: 'Install replica theme files + block plugins into an ALREADY-RUNNING Studio site (no site creation, no content import). Use this from the streaming watch loop\'s theme-piece / archetype-template judgments — `liberate_preview` would create a `-2` duplicate Studio site and re-import content over the streamed posts. Writes to <studioSitePath>/wordpress/wp-content/{themes,plugins}/, then runs `studio wp plugin activate` and `studio wp theme activate`. Returns warnings[] for non-fatal activate failures.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Path to the extraction output directory (used for log routing only — files are written to studioSitePath, not outputDir).' },
          studioSitePath: { type: 'string', description: 'On-disk path to the running Studio site (parent dir, NOT the wordpress sub-dir). Streaming watch logs this as `preview-pre-started.sitePath`.' },
          themeFiles: {
            type: 'array',
            description: 'Replica theme files. Same shape as liberate_preview — { relativePath, content }, rooted at the theme directory. Activated after writing.',
            items: {
              type: 'object' as const,
              properties: {
                relativePath: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['relativePath', 'content'],
            },
          },
          blockPlugins: {
            type: 'array',
            description: 'DEPRECATED — kept for backwards compatibility. New replica work should embed custom blocks inside the theme at blocks/<slug>/{src,build}/ via themeFiles[], following the Telex blocks-inside-themes pattern. The skill registers them from functions.php. Each plugin entry is { slug, files: [{relativePath, content}] }, activated after writing.',
            items: {
              type: 'object' as const,
              properties: {
                slug: { type: 'string' },
                files: {
                  type: 'array',
                  items: {
                    type: 'object' as const,
                    properties: {
                      relativePath: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['relativePath', 'content'],
                  },
                },
              },
              required: ['slug', 'files'],
            },
          },
          themeSlug: { type: 'string', description: 'Theme directory name (kebab-case). Required when themeFiles is non-empty. Conventionally <siteSlug>-replica.' },
        },
        required: ['outputDir', 'studioSitePath'],
      },
    },
    {
      name: 'liberate_theme_scaffold',
      description: 'Read <outputDir>/design-foundation.json and emit a complete-and-activatable WordPress block theme bundle deterministically: style.css (theme header), theme.json (settings/styles mapped from foundation tokens), functions.php (theme setup + custom-block registration loop), templates/index.html (homepage shell with header part + post-content + footer part), parts/header.html (site-title + page-list nav), parts/footer.html (copyright). No agent reasoning, no vision, no LLM call — pure deterministic mapping. Pair with `liberate_install_theme` to install the result into a running Studio site. Per-archetype templates (page.html, single.html, etc.) and patterns are NOT emitted here — they belong to the replicate skill\'s archetype-template tick.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (must contain design-foundation.json).' },
          themeSlug: { type: 'string', description: 'Theme directory slug (kebab-case). Conventionally <siteSlug>-replica.' },
          themeName: { type: 'string', description: 'Display name. Defaults to themeSlug.' },
          siteTitle: { type: 'string', description: 'Source site title — used in style.css description and footer copyright.' },
          themeDescription: { type: 'string', description: 'Override the default style.css Description line.' },
        },
        required: ['outputDir', 'themeSlug'],
      },
    },
    {
      name: 'liberate_screenshot',
      description: 'Capture full-page + scrolled screenshots (desktop + mobile) and rendered HTML for every URL on a site. Writes to <outputDir>/screenshots/ and <outputDir>/html/, plus palette.json, typography.json, breakpoints.json, and computed-styles.json via DOM/CSS site-analysis. Reuses sitemap discovery or accepts explicit urls[].',
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
    {
      name: 'liberate_design_foundation_scaffold',
      description:
        'Runs the deterministic scaffold on a liberation output directory: reads palette.json / typography.json / breakpoints.json / screenshots/manifest.json from SP1 output, applies pure rules (darkest high-frequency → text.default, lightest → surface.base, breakpoint tier mapping, gradient regex extraction from html/*.html), and returns a PartialDesignFoundation. Empty role slots are left for the design-foundations skill to assign. Emits skillTodos listing every path the skill must fill. The design-foundations skill may additionally read computed-styles.json for HTML/CSS role assignment.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (must contain SP1 files).' },
          origin: { type: 'string', description: 'Origin URL (e.g. https://example.com). Stored in the foundation `origin` field.' },
        },
        required: ['outputDir', 'origin'],
      },
    },
    {
      name: 'liberate_design_foundation_validate',
      description:
        'Validates a design-foundation JSON blob against the schema. Returns { ok: true } or { ok: false, errors: [...] }. Used by the design-foundations skill after filling role slots to catch structural mistakes and unfilled skillTodos before saving to disk.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          foundation: { type: 'object', description: 'JSON blob to validate (not a path).' },
        },
        required: ['foundation'],
      },
    },
    {
      name: 'liberate_design_foundation_save',
      description:
        'Persists a validated design-foundation JSON to disk and generates the human-readable design-foundation.md companion. Writes both files atomically to outputDir. Skips write when inputsDigest matches prior file (unless force=true).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Destination directory.' },
          foundation: { type: 'object', description: 'Complete design foundation JSON blob.' },
          force: { type: 'boolean', description: 'Overwrite even if inputsDigest matches prior file.' },
        },
        required: ['outputDir', 'foundation'],
      },
    },
    {
      name: 'liberate_media_install',
      description: 'Install one URL\'s pending media into the running replica WP site. Idempotent: skips media already registered as attachments (tracked via MediaStubStore.wpPostId). Studio path uses `studio wp eval-file`; Playground path uses `wp-playground-cli run-blueprint` against the persisted playground-site wp-content mount.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (contains media-stubs.json + media/).' },
          url: { type: 'string', description: 'Source URL whose media we are installing (used for logging; the install acts on all pending media in MediaStubStore).' },
          target: {
            type: 'object' as const,
            description: 'Where to install the media. Studio: { kind: "studio", sitePath: "/Users/.../Studio/site-name" }. Playground: { kind: "playground", sitePath: "<outputDir>/playground-site", siteUrl: "http://127.0.0.1:9400" }.',
            properties: {
              kind: { type: 'string', enum: ['studio', 'playground'] },
              sitePath: { type: 'string' },
              siteUrl: { type: 'string', description: 'Optional running Playground URL used to compute browser-visible upload URLs.' },
            },
            required: ['kind', 'sitePath'],
          },
        },
        required: ['outputDir', 'url', 'target'],
      },
    },
    {
      name: 'liberate_replicate_tick',
      description: 'Run one tick of the replicate streaming scheduler. Reads replicate-state.json, computes deltas (new archetypes since last tick, foundation drift), returns judgmentNeeded[] markers describing what skills the calling agent should invoke (replicate, design-foundations, compose-page-blocks). The MCP tool is deterministic — it does not invoke skills directly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory.' },
          reason: { type: 'string', description: 'Optional reason override (manual / new-archetype / periodic / foundation-drift). Defaults to inferred.' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_block_transform_apply',
      description: 'Apply composed block markup to a post in the running replica site. Validates: parse_blocks roundtrip + output-verify text-substring check + post-existence poll (3 retries with backoff). Idempotent via block-transform-log.jsonl (same source+output hashes skip re-apply). Studio path uses `wp post update` via studio CLI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (block-transform-log.jsonl lives here).' },
          url: { type: 'string', description: 'Source URL (post is matched via _source_url meta in the replica).' },
          blocks: { type: 'string', description: 'Composed block markup to apply as post_content.' },
          sourceHtml: { type: 'string', description: 'Original sanitized source HTML — passed to output-verify for text-substring validation.' },
          target: {
            type: 'object' as const,
            description: 'Replica site target. Studio: { kind: "studio", sitePath: "..." }. Playground: { kind: "playground", siteUrl: "http://localhost:9400" }.',
            properties: {
              kind: { type: 'string', enum: ['studio', 'playground'] },
              sitePath: { type: 'string' },
              siteUrl: { type: 'string' },
            },
            required: ['kind'],
          },
          composedBy: { type: 'string', description: 'Provenance string for the log entry (e.g. "compose-page-blocks@v1.0" or "heuristic@v1.0").' },
        },
        required: ['outputDir', 'url', 'blocks', 'sourceHtml', 'target'],
      },
    },
    {
      name: 'liberate_block_compose',
      description: 'Validate composed block markup and write it to a sidecar file (<outputDir>/composed/<slug>.blocks.html) for the streaming watch loop to install as post_content. Compose-then-install counterpart to liberate_block_transform_apply: same parse_blocks roundtrip + output-verify validation, same block-transform-log.jsonl idempotency, but NO database write. The runner reads the sidecar after the agent returns and passes the contents to wp_insert_post via contentOverride, so the very first DB write of each post carries block markup (not raw HTML that gets transformed afterward). Use this in the streaming watch loop\'s compose-page-blocks judgment; reach for liberate_block_transform_apply only for re-composing already-imported posts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (sidecar lives at <outputDir>/composed/, log is block-transform-log.jsonl).' },
          url: { type: 'string', description: 'Source URL — used for log entries and as the manifest lookup key when sourceHtml is omitted.' },
          slug: { type: 'string', description: 'Post slug — determines the sidecar filename (composed/<slug>.blocks.html). Must match the WxrItem.slug the runner buffered.' },
          blocks: { type: 'string', description: 'Composed block markup. Validated for parse_blocks roundtrip and against sourceHtml for text-substring containment.' },
          sourceHtml: { type: 'string', description: 'Sanitized source HTML used for anti-hallucination output-verify. Optional — falls back to <outputDir>/screenshots/manifest.json lookup.' },
          composedBy: { type: 'string', description: 'Provenance string for the log entry (default "compose-page-blocks@v1.0").' },
          source: { type: 'string', enum: ['heuristic', 'ai'], description: 'Compose source flavour for the log entry (default "ai").' },
        },
        required: ['outputDir', 'url', 'slug', 'blocks'],
      },
    },
    {
      name: 'liberate_replicate_inventory',
      description:
        'Read a liberation outputDir and return a structured archetype inventory: counts per archetype (homepage/page/post/product/gallery/event), up to 3 representative URLs per archetype with their screenshot+html paths (selected by largest HTML — proxy for section count), product count from products.jsonl, and presence of design-foundation.json. Used by the replicate skill in Step 1 (Inventory). Throws when output.wxr is missing.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (must contain output.wxr).' },
        },
        required: ['outputDir'],
      },
    },
    {
      name: 'liberate_replicate_verify',
      description:
        'Capture replica screenshots at given URLs (desktop + mobile by default) against a running replica WP install and pair each viewport with the matching source screenshot from screenshots/manifest.json. Returns a structured pairing manifest the calling agent (vision-capable) uses for side-by-side comparison. Used by the replicate skill in Step 6 (Verify). Replica screenshots are written to <outputDir>/<outputSubdir>/<viewport>/<slug>.png — same shape as the source layout.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          outputDir: { type: 'string', description: 'Liberation output directory (contains screenshots/manifest.json and the source screenshots/).' },
          replicaBaseUrl: { type: 'string', description: 'Base URL of the running replica (e.g. https://my-site-replica.wp.local or http://localhost:8881). No trailing slash.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Path-only URLs to verify (e.g. ["/", "/blog/post-1"]).' },
          viewports: { type: 'array', items: { type: 'string', enum: ['desktop', 'mobile'] }, description: 'Viewports to capture. Default: ["desktop", "mobile"].' },
          outputSubdir: { type: 'string', description: 'Where in outputDir to write replica screenshots. Default: "replica-screenshots". Files land at <subdir>/<viewport>/<slug>.png.' },
          cdpPort: { type: 'number', description: 'Connect to existing Chrome via CDP (otherwise launches a new browser).' },
        },
        required: ['outputDir', 'replicaBaseUrl', 'urls'],
      },
    },
    {
      name: 'liberate_compare',
      description:
        'Pixel-parity scorer (fixed viewport). Joins an origin screenshots dir to a replica screenshots dir by URL pathname, crops both full-page PNGs to the top 1440×900 / 390×844 region, and returns per-pathname desktop/mobile similarity scores (1 − diffPixels/total). Writes comparison.json + diff PNGs into the replica dir. Both dirs must have the standard layout: manifest.json + desktop/<slug>.png + mobile/<slug>.png.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          originDir: { type: 'string', description: 'Origin screenshots dir (manifest.json + desktop/ mobile/).' },
          replicaDir: { type: 'string', description: 'Replica screenshots dir, same layout. comparison.json + diff/ are written here.' },
          viewports: { type: 'array', items: { type: 'string', enum: ['desktop', 'mobile'] }, description: 'Viewports to score. Default: both.' },
          diffOutputDir: { type: 'string', description: 'Where to write diff PNGs. Default: <replicaDir>/diff.' },
        },
        required: ['originDir', 'replicaDir'],
      },
    },
  ],
}));

/** Tool name → handler module. */
const handlers: Record<string, Handler> = {
  liberate_compare: compareHandler,
  liberate_design_foundation_save: designFoundationSaveHandler,
  liberate_design_foundation_scaffold: designFoundationScaffoldHandler,
  liberate_design_foundation_validate: designFoundationValidateHandler,
  liberate_detect: detectHandler,
  liberate_discover: discoverHandler,
  liberate_block_transform_apply: blockTransformApplyHandler,
  liberate_block_compose: blockComposeHandler,
  liberate_extract: extractHandler,
  liberate_extract_one: extractOneHandler,
  liberate_media_install: mediaInstallHandler,
  liberate_replicate_tick: replicateTickHandler,
  liberate_import: wpImportHandler,
  liberate_inspect: inspectHandler,
  liberate_map_apis: mapApisHandler,
  liberate_preview: previewHandler,
  liberate_install_theme: installThemeHandler,
  liberate_theme_scaffold: themeScaffoldHandler,
  liberate_preview_stop: previewStopHandler,
  liberate_probe: probeHandler,
  liberate_qa: qaHandler,
  liberate_replicate_inventory: replicateInventoryHandler,
  liberate_replicate_verify: replicateVerifyHandler,
  liberate_screenshot: screenshotHandler,
  liberate_setup: setupHandler,
  liberate_status: statusHandler,
  liberate_verify: verifyHandler,
};

function makeContext(): HandlerContext {
  return { adapters, findAdapter, textResult, errorResult, server };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  if (!handler) return errorResult(`Unknown tool: ${name}`);
  return handler((args ?? {}) as Record<string, unknown>, makeContext());
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
