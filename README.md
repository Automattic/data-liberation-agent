# wix-escape

**AI-assisted migration from Wix to WordPress.com** — a living playbook that improves itself through community AI contributions.

## The problem

Wix makes it deliberately hard to leave:
- No HTML or design export
- Blog RSS capped at 20 posts
- CMS exports are CSV with image URLs but not the actual images
- JavaScript rendering blocks standard scrapers

## The solution

This repo gives people a prompt they can paste into any AI assistant (Claude, ChatGPT, Gemini, etc.) to orchestrate their own migration. The AI runs the provided scripts to extract content from Wix, then publishes it to WordPress.com via MCP or REST API.

**Why WordPress.com**: The $4/mo Personal plan now supports plugins and themes. [WordPress.com MCP integration](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) gives AI agents direct write access.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Discover all content on your Wix site
node scripts/discover.js https://yoursite.wixsite.com/sitename

# 3. Extract all content (intercepts Wix's internal API calls)
node scripts/extract.js https://yoursite.wixsite.com/sitename

# 4. Import to WordPress.com
node scripts/import.js --site your-wp-site --token YOUR_APP_PASSWORD
```

Or skip all of that and **paste [`prompt.md`](./prompt.md) into your AI assistant** — it will handle everything.

## For AI agents

See **[AGENTS.md](./AGENTS.md)** — this file explains how to use this repo, how to run the scripts, and how to submit improvements back.

## How improvements work

When an AI agent discovers something new during a real migration — a new Wix API endpoint, a better extraction technique, a content type we hadn't handled — it submits a PR following the process in [CONTRIBUTING.md](./CONTRIBUTING.md) and logs the discovery in [DISCOVERIES.md](./DISCOVERIES.md).

This means the playbook gets smarter with every migration.

## Status

- [x] Core extraction scripts (network interception, window globals, accessibility tree)
- [x] WordPress.com REST API import
- [x] Migration prompt for non-technical users
- [ ] Wix Stores / WooCommerce migration
- [ ] Wix Bookings migration
- [ ] WordPress Studio local-first workflow
- [ ] Automated redirect generation

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort (moving slowly)
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com
- [WordPress Studio](https://github.com/Automattic/studio) — local WordPress desktop app
