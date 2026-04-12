# CLI Reference

The `data-liberation` CLI extracts content from closed web platforms and imports it into WordPress.

```bash
npm run liberate -- <command> [options]
```

Individual commands also have shortcuts: `npm run inspect`, `npm run verify`, `npm run setup`.

## Commands

### Extract (default)

```bash
data-liberation <url> [options]
```

The main workflow. Detects the platform, inventories the site, extracts all content, and offers to import to WordPress. Produces a WXR file, media directory, redirect map, and products CSV (if applicable).

After extraction completes, the CLI prompts:
1. "Ready to import to WordPress?" — skip with `--non-interactive`
2. "Do you already have a WordPress site?" — if no, shows setup guidance
3. Collects credentials and validates the connection before importing

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--output <dir>` | Output directory | `./output` |
| `--dry-run` | Extract 2-3 pages and report without writing WXR | off |
| `--resume` | Resume a previous extraction, skipping already-processed URLs | off |
| `--token <token>` | API token for platforms requiring auth (e.g. Webflow) | `LIBERATION_TOKEN` env var |
| `--delay <ms>` | Delay between requests | 500 |
| `--verbose` | Detailed per-page extraction logging | off |
| `--cdp-port <port>` | Chrome DevTools Protocol port for browser-based extraction | none |
| `--admin-token <tok>` | **Shopify only** — Admin API access token. Unlocks GraphQL product extraction with richer fields (sale pricing, stock policy, cost of goods, variant media, collections, SEO metafields). Falls back to public JSON API on failure. | `SHOPIFY_ADMIN_TOKEN` env var |
| `--shop-domain <host>` | **Shopify only** — `*.myshopify.com` hostname used for Admin API calls. Usually auto-detected from the storefront HTML during discovery; only pass manually if detection fails. | auto-detected |
| `--non-interactive` | Skip the post-extraction import prompt | off |

**Output directory structure:**

```
output/<site-hostname>/
  output.wxr              WordPress eXtended RSS file
  media/                  Downloaded images and attachments
  redirect-map.json       Old paths -> new WordPress slugs
  extraction-log.jsonl    Per-URL extraction log (atomic URL dedupe)
  session.json            Pipeline stage, captured CLI opts, progress, pagination cursors
  media-stubs.json        Per-asset download status (retry cap + user-ignored URLs)
  products.csv            WooCommerce product CSV (if e-commerce detected)
  products.jsonl          Raw product data stream
  .discovery-complete     Marker file (extraction finished successfully)
```

**Resume state is split across four files:**

- `extraction-log.jsonl` — append-only per-URL log; `--resume` skips any URL that already has a `processed` entry.
- `session.json` — higher-level state: stage (`discovering` → `extracting` → `finalizing` → `complete`), the original CLI opts, per-entity `{discovered, extracted, failed}` counts, and adapter pagination cursors. Crash-safe via atomic rename; a corrupt file is preserved as `session.json.corrupt.<ts>` rather than deleted.
- `media-stubs.json` — status per media URL (`awaiting` / `success` / `error` / `ignored`) with an attempt counter. After 3 consecutive failures the URL is treated as permanently broken and resume runs skip it. The `ignored` status is terminal; adapters or a future CLI can mark URLs to skip forever.
- `products.jsonl` — streaming JSONL of mapped WooCommerce products; on `--resume` the file is appended to rather than truncated so mid-catalog crashes don't re-emit duplicates.

**Resume:** When `--resume` is used, the CLI reads `extraction-log.jsonl` to skip already-processed URLs and rebuilds the media dedup hash map from existing files. `session.json` is loaded to restore stage and cursors. Progress counters reflect the full total (e.g. `[21/50]` not `[1/30]`). A `.liberation-lock` file prevents concurrent `data-liberation` runs against the same output directory — if the lock is present and the holding PID is still alive, a second run refuses to start.

### inspect

```bash
data-liberation inspect <url> [--token <token>]
```

Pre-extraction site assessment. Reports:
- Platform detection with confidence level and signals
- Sitemap URL count with breakdown by type (pages, posts, products, galleries, events)
- Sample page probes testing extractability (if the platform adapter supports probing)
- Platform feature flags — stores, bookings, forms, members, scheduling, forums, events — with transfer status and WordPress plugin recommendations

### qa

```bash
data-liberation qa <wxr-file> [--fix]
```

Compare WXR content against the original source site page by page. For each page with a `_source_url`, fetches the origin and compares text, headings, images, and links.

Reports a grade for each page:
- **pass** (>90% match) — content faithfully extracted
- **warn** (70-90%) — minor gaps
- **fail** (<70%) — significant content missing
- **error** — source page unreachable

With `--fix`: patches fixable issues (e.g. missing alt text on images) directly in the WXR file. Logs all comparisons and fixes to `qa-log.jsonl`.

### verify

```bash
data-liberation verify <output-dir>
```

Post-extraction health check. Scans the output directory and reports:
- WXR file presence and item counts (pages, posts, media attachments)
- Stale CDN URLs still embedded in content (Wix, Squarespace, Shopify, Webflow CDN domains)
- Failed page extractions and failed media downloads from the extraction log
- Quality score breakdown (high/medium/low)
- Media files on disk vs media attachments in the WXR
- Redirect map entry count
- Summary of items needing manual attention

### setup

```bash
data-liberation setup [--site <domain>] [--username <user>] [--token <password>]
```

Validate a WordPress connection. Prompts interactively for any missing parameters. Tests three things in order:

1. **Site reachable** — can we connect at all?
2. **REST API available** — does `/wp-json` respond?
3. **Authentication** — do the credentials work?

If any step fails, shows specific guidance (how to create Application Passwords, WordPress.com vs self-hosted differences, common mistakes).

### import

```bash
data-liberation import <wxr-file> --site <domain> --username <user> --token <password> [options]
```

Import a WXR file into WordPress via the REST API. Imports in this order: media, categories, tags, pages, posts, comments, menus. All content is imported as drafts.

**Required flags:**

| Flag | Description |
|------|-------------|
| `--site <domain>` | WordPress site domain (e.g. `mysite.com` or `localhost:8881`) |
| `--username <user>` | WordPress username |
| `--token <password>` | Application password (or `WP_APP_PASSWORD` env var) |

**Optional flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Preview what would be imported without making changes | off |
| `--delay <ms>` | Delay between API requests | 500 |
| `--verbose` | Detailed per-item logging | off |
| `--only <type>` | Only import a specific type: categories, tags, media, pages, posts, comments, menus | all |
| `--resume` | Retry only previously failed items | off |
| `--import-authors` | Create WordPress users for each author in the WXR (default: all content owned by you) | off |

### mcp

```bash
data-liberation mcp
```

Start the MCP server on stdio transport. Used by AI tools (Claude Code, Codex, Gemini CLI) to access the 8 `liberate_*` tools programmatically. See [docs/mcp.md](./mcp.md) for tool documentation.

## Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `LIBERATION_TOKEN` | extract | API token for platforms requiring auth (alternative to `--token`) |
| `WP_APP_PASSWORD` | import, setup | WordPress application password (alternative to `--token`) |

## Examples

```bash
# Inspect a site before extracting
data-liberation inspect https://www.example.com

# Extract with a dry run first
data-liberation https://www.example.com --dry-run --verbose

# Full extraction
data-liberation https://www.example.com --output ./migrations

# Resume an interrupted extraction
data-liberation https://www.example.com --resume

# Verify the output
data-liberation verify ./migrations/www.example.com

# Validate WordPress credentials
data-liberation setup --site myblog.wordpress.com --username admin --token "xxxx xxxx xxxx"

# Import to WordPress
data-liberation import ./migrations/www.example.com/output.wxr \
  --site myblog.wordpress.com --username admin --token "xxxx xxxx xxxx"

# Import only media first, then posts
data-liberation import ./output.wxr --site myblog.wordpress.com --username admin --token "$WP_APP_PASSWORD" --only media
data-liberation import ./output.wxr --site myblog.wordpress.com --username admin --token "$WP_APP_PASSWORD" --only posts

# Squarespace: extract with admin access via CDP (gets drafts, unlisted pages, richer content)
# 1. Launch Chrome: google-chrome --remote-debugging-port=9222
# 2. Log in to your Squarespace admin in that Chrome window
# 3. Extract:
data-liberation https://www.example.squarespace.com --cdp-port 9222
```
