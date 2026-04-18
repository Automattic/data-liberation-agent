# AGENTS.md — Instructions for AI Agents

## Overview

`data-liberation-agent` extracts content from closed web platforms (GoDaddy Websites & Marketing, Hostinger, HubSpot, Shopify, Squarespace, Webflow, Weebly, Wix) and produces WordPress-compatible WXR files. All eight platform adapters are implemented.

Three entry points — MCP server (11 tools), CLI (`src/cli.ts`), and Claude Code plugin (`claude plugin add .`) — all share `src/lib/` and `src/adapters/`. The plugin just wraps the MCP server.

The `scripts/` directory contains legacy standalone extraction scripts (Squarespace via CDP, Wix via Playwright). These predate the adapter system and are kept for reference.

## Adding a New Platform

1. Create `src/adapters/<platform>.ts` implementing `PlatformAdapter`
2. Register it in `src/mcp-server.ts` (see the "Static adapter imports" comment)
3. Add platform-specific barriers and workarounds as inline comments in the adapter
4. Update the supported platforms table in `README.md`

Adapters produce structured content and call into `WxrBuilder`, `ExtractionLog`, `ImportSession`, `MediaStubStore`, and `media` utilities for output.

## Resume State Files

Four files cooperate to make runs resumable. Never write to them outside of the extraction-log lockfile (`mcp-server.ts` and `ui/discover.tsx` bracket the whole pipeline):

- `extraction-log.jsonl` (`ExtractionLog`) — append-only per-URL dedupe. Source of truth for "did we process this URL."
- `session.json` (`ImportSession`) — stage, original opts, per-entity counts, adapter pagination cursors. Single-writer, atomic rename. Corrupt files become `session.json.corrupt.<ts>` (never silently deleted).
- `media-stubs.json` (`MediaStubStore`) — per-asset status (`success` / `error` / `ignored`) with retry cap (default 3). Successful writes are buffered via `flush()`; failures persist immediately.
- `products.jsonl` — streaming Woo product output. `openStream({resume: true})` appends instead of truncating, preserving GraphQL-emitted products across mid-run crashes.

Adapters call `ImportSession.loadOrCreate(outputDir, id, opts, { resume })` and pass the session to `runExtractionLoop` via `ExtractionLoopOpts.session`. The shared loop updates stage + per-entity counts automatically.

## Shopify GraphQL Path

When `adminToken` is present, `shopifyAdapter.extract` fetches products via the Shopify Admin GraphQL API (pinned to `2025-04`) instead of the public JSON API. The GraphQL path:

- Requires a `*.myshopify.com` hostname — throws if a custom storefront domain is derived and `shopDomain` wasn't passed explicitly.
- Paginates via `endCursor` stored in `session.cursors['shopify:products:endCursor']` (resumable).
- Tracks already-emitted product handles in `session.cursors['shopify:products:emittedHandles']` for idempotent CSV output across crashes.
- Falls back to the JSON API + URL loop on any GraphQL failure.
- Has `MAX_PAGES = 10000` and a non-advancing cursor guard to prevent infinite loops.

## Non-obvious Details

- WXR builder targets WXR 1.2 spec compliance
- `classifyUrl` types: `homepage`, `post`, `product`, `gallery`, `event`, `page` (no `category`/`author`/`other`)
- Media filename collision handling uses numeric suffixes (`-2`, `-3`), not hashes
- `detect-platform` uses domain-level URL patterns and HTTP fingerprinting (headers + HTML markers) — no path-based detection
- Shopify variant weights are normalized to kilograms regardless of source unit (`kg`, `g`, `lb`, `oz`) via `normalizeWeightToKg`
- Shopify simple-product sale price uses `compareAtPrice > price` semantics — when set, `compareAtPrice` becomes `regularPrice` and `price` becomes `salePrice`
- `WooProduct` has first-class `seoTitle`, `seoDescription`, `costOfGoods` fields plus an open `meta` record; the CSV builder emits `meta:_yoast_wpseo_title`, `meta:_yoast_wpseo_metadesc`, `meta:_wc_cog_cost` columns always, plus `meta:<key>` columns for any custom keys
- `diffContent` in `src/lib/qa/content-differ.ts` measures extraction *loss* (origin items not in WXR), not hallucination — `missingImages` etc. reflect content that failed to make it into the output
- Screenshots live at `output/<site>/screenshots/{desktop,mobile}/<slug>.png` and `<slug>.scrolled.png` (post-scroll viewport capture). Rendered HTML is at `output/<site>/html/<slug>.html`. Screenshot-to-WXR joining happens via two mechanisms: (1) `output/<site>/screenshots/manifest.json` maps URL → files (always present); (2) when screenshots run with extract (default on the CLI; opt-in `screenshots: true` on MCP), WXR posts/pages get `_liberation_screenshot_desktop`, `_liberation_screenshot_mobile`, `_liberation_screenshot_desktop_scrolled`, `_liberation_screenshot_mobile_scrolled`, `_liberation_html` postmeta, and products get matching `meta:_liberation_*` CSV columns. Shared constant: `src/lib/screenshot/meta-keys.ts`.
- The screenshot feature introduces two `ImportSession` stages: `screenshotting` (capture loop) and `stamping-metadata` (post-capture WXR/CSV rewrite). `data-liberation <url>` runs both by default; pass `--no-screenshots` to skip. MCP `liberate_extract` keeps them opt-in via `screenshots: true`.
- Screenshot capture default concurrency is 6 (parallel URL captures). Configurable via `--screenshots-concurrency N` on the default extract or `--concurrency N` on the `screenshot` subcommand. Clamped to [1, 10].
- Screenshot capture restarts the Playwright browser every N=100 URLs (configurable via `--browser-restart-every N`) to bound memory. Restarts happen at batch boundaries, not mid-batch.
- Same-origin enforcement: every captured URL must share origin with the `url` argument (or if only `urls[]` is given, all must share the first entry's origin). Throws `SameOriginViolation`. Mirrors `fetchSitemap` pattern.
- `validateOutputDir` rejects paths containing `..` or outside `process.cwd()`. Tests use a cwd-local `.tmp-test/` directory (gitignored) instead of `os.tmpdir()`.
- Tier 2 stamping rewrites `output.wxr` and `products.jsonl` via tmp + atomic rename. Idempotent: re-running overwrites existing `_liberation_*` keys rather than appending. Safe on crash mid-rewrite.
- Scrolled-state screenshots are skipped silently (not a failure) when the page's `scrollHeight` is shorter than `viewport.height * 1.5 + viewport.height` — short pages don't have a distinct scrolled state to capture.
