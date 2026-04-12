# MCP Tools

The data-liberation-agent MCP server exposes 11 tools via stdio transport. Start it with:

```bash
npx tsx src/mcp-server.ts
```

## Extraction workflow

These tools are typically called in order: detect -> discover -> extract -> verify -> setup -> import.

### liberate_detect

Detect the platform of a website.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | yes | The URL of the website to detect |

Returns: `platform` (wix, squarespace, webflow, shopify, instagram, or unknown), `confidence` (high/medium/low), `signals` (what was detected).

### liberate_discover

Inventory a website: fetch sitemap, categorize URLs, extract navigation structure, detect platform features.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | yes | The URL of the website to inventory |
| `token` | no | API token for platforms requiring auth |
| `cdpPort` | no | CDP port for browser-based extraction |
| `verbose` | no | Enable detailed logging |

Returns: `siteUrl`, `siteMeta` (title, tagline, language), `navigation` (nav links), `counts` (URLs by type), `urls` (full URL list with types), `platformFeatures` (detected features with transfer status and WP plugin recommendations).

### liberate_inspect

Probe a site to assess extractability. Combines detection, sitemap scan, sample page probes, and feature detection into a single call.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | yes | The URL of the website to inspect |
| `token` | no | API token if needed |
| `cdpPort` | no | CDP port for browser-based inspection |

Returns: `platform`, `confidence`, `signals`, `sitemapFound`, `urlCount`, `counts` (by type), `probeResults` (sample page extractability), `platformFeatures`, `extractionFeasibility` (ready or limited).

### liberate_extract

Extract all content from a website. Produces a WXR file, media directory, redirect map, and optionally a products CSV.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | yes | The URL of the website to extract |
| `outputDir` | yes | Directory to write WXR, media, and logs |
| `token` | no | API token for platforms requiring auth |
| `cdpPort` | no | CDP port for browser-based extraction |
| `delay` | no | Delay between requests in ms (default: 500) |
| `resume` | no | Resume a previous extraction (skip already-processed URLs) |
| `dryRun` | no | Extract 2-3 pages and report without writing WXR |
| `verbose` | no | Enable detailed per-page logging |

Returns: `wxrPath`, `redirectMapPath`, `outputDir`, `summary` (counts, quality scores), `failures` (URLs and errors), `wxrValidation`.

### liberate_status

Check progress of a running or completed extraction.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `outputDir` | yes | The output directory of the extraction |

Returns: `running` (boolean), `processed`, `failed` counts.

## Debugging & Reconnaissance

### liberate_map_apis

Map all API endpoints used by a website by navigating pages via CDP and capturing JSON network traffic. Produces a categorized endpoint catalog with sample responses and auth headers. Use during `/adapt` reconnaissance to reverse-engineer a new platform.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `cdpPort` | yes | Chrome DevTools Protocol port (e.g. 9222) |
| `url` | yes | The URL of the site to map |
| `crawlUrls` | no | Additional URLs to navigate (e.g. admin dashboard sections) |
| `followLinks` | no | Follow same-origin links from the main page, up to 20 (default: false) |

Returns: `totalApiCalls`, `totalEndpoints`, `endpoints` (array sorted by call count, each with path, methods, statuses, sections, queryParams, sampleRequestHeaders, samplePostData, sampleResponsePreview), `categories` (endpoints grouped by type: Content, Site Config, Auth & Identity, Commerce, Analytics, Media & Assets, Other), `authHeaders` (custom headers observed on API calls).

### liberate_probe

Probe a browser page via CDP for extraction-relevant data. Requires a running Chrome with `--remote-debugging-port`. Use for debugging extraction failures — called by the `/diagnose` skill.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `cdpPort` | yes | Chrome DevTools Protocol port (e.g. 9222) |
| `url` | no | Only probe pages on this domain (probes all tabs if omitted) |

Returns an array of probe results (one per matching browser tab), each containing: `globals` (window objects with platform prefixes), `jsonLd` (structured data), `cookies` (names/domains/flags, not values), `localStorage` (key names/sizes/previews), `networkEntries` (API calls from Performance API), `identity` (platform-specific IDs — Wix metaSiteId, Squarespace websiteId, Shopify shop name).

## Post-extraction

### liberate_verify

Verify a completed extraction. Checks for stale CDN URLs, failed pages, missing media, and items needing manual attention.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `outputDir` | yes | The output directory of the extraction to verify |

Returns: `wxrFound`, `contentItems`, `pages`, `posts`, `mediaAttachments`, `mediaOnDisk`, `staleCdnUrls`, `failedUrls`, `failedMedia`, `redirectCount`, `qualityScores` (high/medium/low), `manualAttentionItems`.

## Quality assurance

### liberate_qa

Compare extracted WXR content against the original source site page by page. Reports text similarity, missing headings/images/links, and grades each page. Optionally patches fixable issues like missing alt text.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `wxrFile` | yes | Path to the WXR file to QA |
| `fix` | no | Patch fixable issues in the WXR (default: false) |

Returns: `pages` (array of per-page results with slug, sourceUrl, grade, diff details), `skipped` (count of pages without source URL), `summary` (pass/warn/fail/error/fixed counts).

## WordPress import

### liberate_setup

Validate WordPress connection before importing. Checks site reachability, REST API availability, and authentication. Returns step-by-step guidance if anything fails.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `site` | yes | WordPress site domain (e.g. mysite.com) |
| `username` | yes | WordPress username |
| `token` | yes | WordPress application password |

Returns: `siteUrl`, `siteReachable`, `restApiAvailable`, `authenticated`, `siteName`, `userName`, `errors`, `guidance`.

### liberate_import

Import a WXR file into a WordPress site via the REST API.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `wxrFile` | yes | Path to the WXR file to import |
| `site` | yes | WordPress site domain |
| `username` | yes | WordPress username |
| `token` | yes | WordPress application password |
| `dryRun` | no | Preview without importing |
| `delay` | no | Delay between requests in ms (default: 500) |
| `only` | no | Only import specific type (categories, tags, media, pages, posts, comments, menus) |
| `verbose` | no | Enable detailed logging |
| `resume` | no | Resume a previous import, retrying only failed items |
| `importAuthors` | no | Create WordPress users for each author in the WXR (default: false — all content owned by authenticated user) |
| `woocommerceKey` | no | WooCommerce consumer key for product import |
| `woocommerceSecret` | no | WooCommerce consumer secret for product import |

Returns: per-stage results (media, categories, tags, pages, posts, comments, menus, products) with total/created/failed counts, plus `redirectMap`.
