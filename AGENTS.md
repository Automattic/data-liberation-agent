# AGENTS.md — Instructions for AI Agents

## Overview

`data-liberation-agent` extracts content from closed web platforms (Wix, Squarespace, Webflow, Shopify) and produces WordPress-compatible WXR files. All four platform adapters are implemented.

Three entry points — MCP server (11 tools), CLI (`src/cli.ts`), and Claude Code plugin (`claude plugin add .`) — all share `src/lib/` and `src/adapters/`. The plugin just wraps the MCP server.

The `scripts/` directory contains legacy standalone extraction scripts (Wix via Playwright, Squarespace via CDP). These predate the adapter system and are kept for reference.

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
