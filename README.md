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

# 2. Extract a site (works for any supported platform). A local preview site
#    boots automatically after extraction — Automattic Studio if installed,
#    WordPress Playground otherwise.
npm run liberate -- https://yoursite.com

# 3. Re-open the preview later (same Studio/Playground selection as above)
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
* [Wix authenticated content endpoints](/docs/wix-content-endpoints.md) — reference of the ten load-bearing content endpoints behind Wix's editor / dashboard auth

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com

## Troubleshooting the preview

**Picking between Studio and Playground** — the preview uses [Automattic Studio](https://developer.wordpress.com/studio/) when the `studio` CLI is on PATH (install the app — the CLI ships with it), and falls back to WordPress Playground otherwise. Studio sites are persistent and named after the output directory's domain slug (`example-com`, `example-com-2` on collision). Playground sites are ephemeral per-run.

**"No free port in 9400–9499"** (Playground only) — another process is holding the range. Pass `--port <n>` to override, or stop the conflict.

**"Playground failed to boot"** — the readiness probe didn't see HTTP within 60s. Check `<outputDir>/playground/preview.log` for the subprocess output. Common causes: slow network on first run (WASM download), wrong Node version (requires Node 18+).

**"ECONNREFUSED" when browsing the URL** (Playground only) — the Playground subprocess died after startup. Run `liberate_preview_stop <outputDir>` (or delete `<outputDir>/playground/preview.pid`), then re-run `preview`.

**"stale preview running for >24h"** (Playground only) — the tool auto-cleans PID files older than a day. This is informational; it will restart cleanly.

**Preview is not a secure environment.** Both paths auto-log in as `admin`/`password` and bind to `127.0.0.1` (Playground) or `localhost:<port>` (Studio). Do not paste secrets into it.
