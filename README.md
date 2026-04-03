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
| **Instagram** | Ready | [`prompts/instagram.md`](./prompts/instagram.md) |
| Squarespace | Planned | — |
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
node scripts/import.js --site your-wp-site --token YOUR_APP_PASSWORD
```

## Quick start (Instagram)

```bash
# 1. Install dependencies
npm install

# 2. Launch Chrome with remote debugging (Instagram requires an authenticated session)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.data-liberation/cdp-profile/chrome"

# 3. Log into Instagram in the browser, then discover all posts
node scripts/instagram/discover.js YOUR_USERNAME --cdp-port 9222

# 4. Extract content and download all media
node scripts/instagram/extract.js YOUR_USERNAME --cdp-port 9222

# 5. Import to WordPress.com
node scripts/import.js --site your-wp-site --token YOUR_APP_PASSWORD
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

### Instagram
- [x] Profile discovery via GraphQL interception
- [x] Post extraction with full metadata (captions, dates, locations, hashtags)
- [x] Carousel slide extraction via `?img_index=N`
- [x] Media download (photos and videos)
- [x] WordPress.com REST API import with block markup
- [x] Custom post type support (`--post-type`)
- [ ] Stories and Reels extraction
- [ ] Comment extraction

### General
- [x] WordPress.com REST API import script
- [ ] WordPress Studio local-first workflow
- [ ] Automated redirect generation
- [ ] Squarespace extractor
- [ ] Webflow extractor

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com
- [WordPress Studio](https://github.com/Automattic/studio) — local WordPress desktop app
