# data-liberation-agent

Extract content from closed web platforms into WordPress-compatible WXR files.

## The problem

Closed platforms make it hard to leave. Wix has no HTML export and caps RSS at 20 posts. JavaScript-rendered content and limited APIs leave your site data locked inside.

## The solution

This tool extracts all content from closed platforms — posts, pages, media, navigation, redirects, products — and produces a standard WordPress WXR file ready to import.

**Where to host WordPress**: If your current provider also offers WordPress, you can move to WordPress and stay with them. WordPress.com is another option: the $4/mo Personal plan now supports plugins and themes, and the [WordPress.com MCP integration](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) gives AI agents direct write access.

## Supported platforms

| Platform | Status | Prompt |
|---|---|---|
| **GoDaddy Websites & Marketing** (pages/blog) | Ready | [`prompts/godaddy-wm.md`](./prompts/godaddy-wm.md) |
| **Hostinger Website Builder** (blog/pages/products) | Ready | — |
| **HubSpot** | Ready | — |
| **Shopify** (blog/pages/products) | Ready | [`prompts/shopify.md`](./prompts/shopify.md) |
| **Squarespace** | Ready | [`prompts/squarespace.md`](./prompts/squarespace.md) |
| **Webflow** | Ready | [`prompts/webflow.md`](./prompts/webflow.md) |
| **Weebly** (blog/pages/products) | Ready | — |
| **Wix** | Ready | [`prompts/wix.md`](./prompts/wix.md) |
| **Any other website** (generic fallback) | Best-effort | — |

All eight platforms have MCP adapters with full extraction support including products (exported as WooCommerce-compatible CSV). Sites matching none of them fall back to a generic `default` adapter that renders each page in a headless browser and extracts the main content, media, and any JSON-LD products — best-effort, since it can't key off platform-specific markup. GoDaddy Websites & Marketing is pages + blog only in v1; GoDaddy Online Store (OLS) product support is planned for v1.1.

## Screenshots

Capture full-page + scrolled-state screenshots (desktop 1440×900 + mobile 390×844) plus rendered HTML and site-analysis metadata (palette, typography) for every URL on a site. Useful for pre-liberation analysis and feeding AI design-system tools.

Standalone:

```bash
data-liberation screenshot https://example.com --output ~/Studio/_liberations/example.com
```

Screenshots run automatically at the end of `data-liberation <url>` extracts. Results land under `<outputDir>/screenshots/` alongside a `manifest.json` keyed by URL — the join back to `output.wxr` and `products.jsonl` happens on the filesystem, not via WordPress postmeta. Pass `--no-screenshots` to skip them:

```bash
data-liberation https://example.com                          # default: ~/Studio/_liberations/example.com
data-liberation https://example.com --no-screenshots         # skip screenshots
```

Output lives at `<outputDir>/screenshots/{desktop,mobile}/<slug>.png` (fullpage + `.scrolled.png` variants) and `<outputDir>/html/<slug>.html`. See `<outputDir>/screenshots/manifest.json` for the URL → files join table.

Options:
- `--limit N` — cap to first N URLs
- `--types page,post,product` — filter by URL type
- `--concurrency N` — parallel captures (default 6, max 10)
- `--browser-restart-every N` — restart Chromium every N URLs (default 100)
- `--cdp-port <n>` — connect to existing Chrome session (for authenticated sites)
- `--force` — re-capture even if output files already exist
- `--urls-file <path>` — read URLs from a file instead of fetching the sitemap

## Getting started — agent-first

The front door is `/liberate` inside Claude Code (or Codex). One command runs the full pipeline: extraction + block-theme design + local WordPress preview.

```bash
# 1. Install the plugin
claude plugin install data-liberation

# 2. In Claude Code, run:
/liberate https://your-site.com
```

What you'll see: the agent detects the platform, inventories all pages/posts/products, pauses to confirm scope and estimated time, then extracts content and media. It then drives the design phase — clustering page layouts, building a responsive block theme that mirrors your source site's structure and visual style, and importing everything into Automattic Studio. When it finishes you get a local preview URL and a `run-report.json` summarizing what was built, what's faithful, and any gaps.

> **Studio required for preview/import.** Install at https://developer.wordpress.com/studio/ before running `/liberate`. Extraction itself needs no WordPress.

The result is a responsive, editable WordPress block theme — not a static copy.

### Claude Code (plugin install)

```bash
# From the marketplace
claude plugin marketplace add Automattic/data-liberation-agent
claude plugin install data-liberation

# Or from the git checkout
cd data-liberation-agent
claude --add-plugin .
```

Available skills: `/liberate` (front door — capture, then choose the reconstruct path), `/replicate-with-blocks` + `/replicate-theme` (the two reconstruct paths `/liberate` dispatches to), `/qa`, `/diagnose`, `/adapt`. See [docs/skills.md](./docs/skills.md).

### Codex

```bash
cd data-liberation-agent
codex
```

The `.codex-plugin/plugin.json` and `.mcp.json` register the MCP server and skills automatically. `/liberate` runs sequentially on Codex (the builder fan-out step degrades to a sequential loop).

### Gemini CLI

```bash
cd data-liberation-agent
gemini extension link .
```

### Any MCP client

```bash
npx tsx src/mcp-server.ts

# or

npm run mcp
```

Stdio transport. Exposes 11 tools: `liberate_detect`, `liberate_discover`, `liberate_inspect`, `liberate_extract`, `liberate_status`, `liberate_qa`, `liberate_map_apis`, `liberate_probe`, `liberate_verify`, `liberate_setup`, and `liberate_import`.

## Headless / CI (extraction only)

The `data-liberation` CLI handles the deterministic extraction stages — detect, discover, extract, screenshot, and import. It does **not** run the design/replica phase; that requires an agent context. Use the CLI for CI pipelines, batch migrations, or when you only need a WXR + media.

```bash
# 1. Install
npm install

# 2. Extract a site (produces WXR + media + screenshots; no design phase)
npm run liberate -- https://yoursite.com

# 3. Re-open the local preview later (Studio required)
npm run liberate -- preview ~/Studio/_liberations/yoursite.com --open

# 4. Inspect before extracting
npm run inspect -- https://yoursite.com

# 5. Verify extraction quality
npm run verify -- ~/Studio/_liberations/yoursite.com

# 6. Validate WordPress connection
npm run setup -- --site your-wp-site.wordpress.com --username you --token YOUR_APP_PASSWORD

# 7. Import WXR to WordPress
npm run liberate -- import ~/Studio/_liberations/yoursite.com/output.wxr --site your-wp-site --username you --token YOUR_APP_PASSWORD
```

Full CLI reference: [docs/cli.md](./docs/cli.md).

## Output

A successful extraction produces in `~/Studio/_liberations/<host>/` (default; override with `--output` or `DLA_OUTPUT_DIR`):

- `~/Studio/_liberations/<host>/`
   - `output.wxr` — WordPress eXtended RSS file, ready to import via WordPress Admin > Tools > Import
   - `media/` — downloaded images and attachments with local paths rewritten in the WXR
   - `redirect-map.json` — old platform paths mapped to new WordPress slugs
   - `extraction-log.jsonl` — per-URL extraction log (atomic dedupe for `--resume`)
   - `session.json` — pipeline stage, captured CLI opts, per-entity progress counters, and adapter pagination cursors
   - `media-stubs.json` — per-asset download status so permanently-broken URLs stop retrying across resume runs
   - `products.csv` — WooCommerce-compatible product CSV (if the site has e-commerce)
   - `products.jsonl` — raw product data streamed during extraction

## Additional documentation

* [CLI commands](/docs/cli.md)
* [AI agent commands](/docs/commands.md)
* [AI skills](/docs/skills.md)
* [MCP server tools](/docs/mcp.md)
* [Wix authenticated content endpoints](/docs/wix-content-endpoints.md) — reference of the ten load-bearing content endpoints behind Wix's editor / dashboard auth

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com

## Troubleshooting the preview

Preview and import require [Automattic Studio](https://developer.wordpress.com/studio/) — install the app first (the `studio` CLI ships with it). Studio sites are persistent and named after the output directory's domain slug (`example-com`, `example-com-2` on collision).

**"Studio not found"** — the `studio` CLI is not on PATH. Install Studio from https://developer.wordpress.com/studio/ and relaunch the terminal so the PATH update takes effect.

**"Studio create-site fails"** — out of disk, port conflict, or Studio config corruption. The error message includes the underlying CLI output. If it's a port conflict, retry. If the Studio config is corrupt, reinstalling Studio fixes it.

**Preview is not a secure environment.** Studio sites auto-log in as `admin`/`password` and bind to `localhost`. Do not paste secrets into them.
