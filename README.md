# data-liberation-agent

**AI-assisted migration from closed platforms to WordPress.com** — a living playbook that improves itself through community AI contributions.

## The problem

Closed platforms make it deliberately hard to leave. Wix has no HTML export and caps RSS at 20 posts. Squarespace locks your design. Proprietary builders trap your content behind JavaScript rendering and limited APIs.

## The solution

This repo gives people a prompt they can paste into any AI assistant (Claude, ChatGPT, Gemini, etc.) to orchestrate their own migration to WordPress.com. The AI runs the provided scripts to extract content, then publishes it via MCP or REST API.

**Why WordPress.com**: The $4/mo Personal plan now supports plugins and themes. [WordPress.com MCP integration](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) gives AI agents direct write access.

## Supported platforms

| Platform | Status | Prompt |
|---|---|---|
| **Wix** | Ready | [`prompts/wix.md`](./prompts/wix.md) |
| **Squarespace** | Ready | [`prompts/squarespace.md`](./prompts/squarespace.md) |
| Webflow | Planned | — |
| Shopify (blog/pages) | Planned | — |

## Quick start (Wix)

```bash
# 1. Install dependencies
npm install

# 2. Discover all content on your Wix site
node scripts/wix/discover.js https://yoursite.wixsite.com/sitename

# 3. Extract all content (intercepts Wix's internal API calls)
node scripts/wix/extract.js https://yoursite.wixsite.com/sitename

# 4. Import to WordPress.com
node scripts/import.js --site your-wp-site --username your-user --token YOUR_APP_PASSWORD
```

## Quick start (Squarespace)

```bash
# 1. Install dependencies
npm install

# 2. Discover all content on your Squarespace site
node scripts/squarespace/discover.js https://yoursite.squarespace.com \
  --cdp-port 9222 --cdp-admin

# 3. Extract all content (intercepts Squarespace's admin API calls)
node scripts/squarespace/extract.js https://yoursite.squarespace.com \
  --inventory output/inventory.json --cdp-port 9222 --cdp-admin

# 4. Import to WordPress.com
node scripts/squarespace/import.js --site your-wp-site \
  --username your-user --token YOUR_APP_PASSWORD
```

Or skip all of that and **paste the prompt into your AI assistant** — it will handle everything.

## For AI agents

See **[AGENTS.md](./AGENTS.md)** — this file explains how to use this repo, how to run the scripts, and how to submit improvements back.

## How improvements work

When an AI agent discovers something new during a real migration — a new API endpoint, a better extraction technique, a content type we hadn't handled — it submits a PR following the process in [CONTRIBUTING.md](./CONTRIBUTING.md) and logs the discovery in [DISCOVERIES.md](./DISCOVERIES.md).

This means the playbook gets smarter with every migration.

## Status

### Wix
- [x] Core extraction scripts (network interception, window globals, accessibility tree)
- [x] WordPress.com REST API import
- [x] Migration prompt for non-technical users
- [ ] Wix Stores / WooCommerce migration
- [ ] Wix Bookings migration

### Squarespace
- [x] Admin extraction via Chrome DevTools Protocol (CDP)
- [x] Section-based content extraction (headings, text, images)
- [x] Media download and URL rewriting
- [x] WordPress.com XML-RPC import
- [ ] Block conversion (`core/paragraph`, `core/image`, etc.)
- [ ] Product/commerce migration

### General
- [x] WordPress.com REST API import script
- [ ] WordPress Studio local-first workflow
- [ ] Automated redirect generation
- [ ] Webflow extractor

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com
- [WordPress Studio](https://github.com/Automattic/studio) — local WordPress desktop app
