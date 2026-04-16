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
| **Wix** | Ready | [`prompts/wix.md`](./prompts/wix.md) |
| **Squarespace** | Ready | [`prompts/squarespace.md`](./prompts/squarespace.md) |
| **Webflow** | Ready | [`prompts/webflow.md`](./prompts/webflow.md) |
| **Shopify** (blog/pages/products) | Ready | [`prompts/shopify.md`](./prompts/shopify.md) |
| **Weebly** (blog/pages/products) | Ready | — |
| **Hostinger Website Builder** (blog/pages/products) | Ready | — |
| **GoDaddy Websites & Marketing** (pages/blog) | Ready | [`prompts/godaddy-wm.md`](./prompts/godaddy-wm.md) |

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

# 3. Or just the inspection
npm run inspect -- https://yoursite.com

# 4. Verify extraction quality
npm run verify -- ./output/yoursite.com

# 5. Validate WordPress connection
npm run setup -- --site your-wp-site.wordpress.com --username you --token YOUR_APP_PASSWORD

# 6. Import to WordPress
npm run liberate -- import ./output/yoursite.com/output.wxr --site your-wp-site --username you --token YOUR_APP_PASSWORD
```

Or skip all of that and **paste the prompt into your AI assistant** — it will handle everything.

## Output

A successful extraction produces in `/output/<site>/`:

- `output/<site>/`
   - `output.wxr` — WordPress eXtended RSS file, ready to import via WordPress Admin > Tools > Import
   - `media/` — downloaded images and attachments with local paths rewritten in the WXR
   - `redirect-map.json` — old platform paths mapped to new WordPress slugs
   - `extraction-log.jsonl` — per-URL extraction log for debugging or resuming
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
