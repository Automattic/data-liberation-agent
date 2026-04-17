# data-liberation-agent

Extract content from closed web platforms into WordPress-compatible WXR files.

## The problem

Closed platforms make it deliberately hard to leave. Wix has no HTML export and caps RSS at 20 posts. Squarespace locks your design. JavaScript-rendered content and limited APIs trap your site data.

## The solution

This tool extracts all content from closed platforms — posts, pages, media, navigation, redirects, products — and produces a standard WordPress WXR file ready to import.

**Why WordPress.com**: The $4/mo Personal plan now supports plugins and themes. [WordPress.com MCP integration](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) gives AI agents direct write access.

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

All eight platforms have MCP adapters with full extraction support including products (exported as WooCommerce-compatible CSV). GoDaddy Websites & Marketing is pages + blog only in v1; GoDaddy Online Store (OLS) product support is planned for v1.1.

## AI tool integration

### Claude Code

**As a marketplace & plugin from GitHub**

```bash
# Install from GitHub
claude plugin marketplace add Automattic/data-liberation-agent
claude plugin install data-liberation

# Use from the git checkout
cd data-liberation-agent
claude --add-plugin .
```

This installs the MCP server and skills directly.

### Gemini CLI

```bash
# Use from the git checkout
cd data-liberation-agent
gemini extension link .
```

### Codex

```bash
cd data-liberation-agent
codex
```

The `.codex-plugin/plugin.json` and `.mcp.json` register the MCP server and skills automatically.

### Any MCP client

```bash
npx tsx src/mcp-server.ts

# or

npm run mcp
```

Stdio transport. Exposes 11 tools: `liberate_detect`, `liberate_discover`, `liberate_inspect`, `liberate_extract`, `liberate_status`, `liberate_qa`, `liberate_map_apis`, `liberate_probe`, `liberate_verify`, `liberate_setup`, and `liberate_import`.

## Quick start

```bash
# 1. Install
npm install

# 2. Extract a site (works for any supported platform)
npm run liberate -- https://yoursite.com

# 3. Preview locally in WordPress Playground (optional but recommended)
npm run liberate -- preview ./output/yoursite.com --open

# 4. Or just the inspection
npm run inspect -- https://yoursite.com

# 5. Verify extraction quality
npm run verify -- ./output/yoursite.com

# 6. Validate WordPress connection
npm run setup -- --site your-wp-site.wordpress.com --username you --token YOUR_APP_PASSWORD

# 7. Import to WordPress
npm run liberate -- import ./output/yoursite.com/output.wxr --site your-wp-site --username you --token YOUR_APP_PASSWORD
```

Or skip all of that and **paste the prompt into your AI assistant** — it will handle everything.

## Output

A successful extraction produces in `/output/<site>/`:

- `output/<site>/`
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

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com

## Troubleshooting the preview

**"No free port in 9400–9499"** — another process is holding the range. Pass `--port <n>` to override, or stop the conflict.

**"Playground failed to boot"** — the readiness probe didn't see HTTP within 60s. Check `<outputDir>/playground/preview.log` for the subprocess output. Common causes: slow network on first run (WASM download), wrong Node version (requires Node 18+).

**"ECONNREFUSED" when browsing the URL** — the Playground subprocess died after startup. Run `liberate_preview_stop <outputDir>` (or delete `<outputDir>/playground/preview.pid`), then re-run `preview`.

**"stale preview running for >24h"** — the tool auto-cleans PID files older than a day. This is informational; it will restart cleanly.

**Preview is not a secure environment.** The Playground auto-logs in with `admin`/`password` and binds to `127.0.0.1`. Do not paste secrets into it.
