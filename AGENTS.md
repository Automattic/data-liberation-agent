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

A fifth artifact, `sections/<slug>.json` (`SectionSpecsStore`), is a per-URL capture-once cache rather than shared run state, so it does NOT need the lockfile: each file is independent and written atomically (unique tmp + rename). The screenshot/capture phase runs `extractFull` on the settled desktop page (1440×900) and persists the `SectionSpec[]` here, keyed by `slugify(url)` and self-describing (records `sourceUrl` + a `SECTION_SPECS_SCHEMA` version). The reconstruction phase (`liberate_reconstruct_pages`) reads this instead of re-running Playwright, falling back to a live extract only on a cache miss — absent, corrupt, schema drift, or a slug collision (recorded `sourceUrl` ≠ requested) — and persisting the live result for the next run. Bump `SECTION_SPECS_SCHEMA` whenever `SectionSpec`'s shape changes so stale caches invalidate instead of silently degrading fidelity.

Adapters call `ImportSession.loadOrCreate(outputDir, id, opts, { resume })` and pass the session to `runExtractionLoop` via `ExtractionLoopOpts.session`. The shared loop updates stage + per-entity counts automatically.

## Shopify GraphQL Path

When `adminToken` is present, `shopifyAdapter.extract` fetches products via the Shopify Admin GraphQL API (pinned to `2025-04`) instead of the public JSON API. The GraphQL path:

- Requires a `*.myshopify.com` hostname — throws if a custom storefront domain is derived and `shopDomain` wasn't passed explicitly.
- Paginates via `endCursor` stored in `session.cursors['shopify:products:endCursor']` (resumable).
- Tracks already-emitted product handles in `session.cursors['shopify:products:emittedHandles']` for idempotent CSV output across crashes.
- Falls back to the JSON API + URL loop on any GraphQL failure.
- Has `MAX_PAGES = 10000` and a non-advancing cursor guard to prevent infinite loops.

## Non-obvious Details

- **MCP server runs `tsx src/mcp-server.ts` as ONE long-lived process — editing `src/` does NOT hot-reload it.** ESM modules are cached per process, so a re-called `liberate_*` tool keeps running the code that was loaded at server start. After editing handler/lib source, either restart the MCP server (so all callers pick it up) or, for a quick one-off re-run, drive the handler from a fresh `tsx` process (import the handler, pass a minimal `HandlerContext` with `textResult`/`errorResult`). Unit tests (`vitest`) always use the on-disk source, so they reflect edits immediately — the staleness is only the running MCP server.
- **`tsx scripts/*.ts` that call `page.evaluate` must create the page via `newShimmedPage` from `scripts/_pw.ts`** — tsx's esbuild keepNames rewrites named functions to `__name(...)`, which is undefined in the browser context Playwright serializes into (`ReferenceError: __name is not defined`). The shim installs a `__name` identity via `addInitScript`. vitest-run code is unaffected (its transform doesn't keepNames).
- WXR builder targets WXR 1.2 spec compliance
- Page-reconstruction full-width vs constrained DEFERS TO THE SOURCE: `SectionSpec.fullBleed` (a section carrying an IMAGE — foreground or background, height ≥ 100px — spanning ≥ 92% of the viewport) drives the page's `main`/`post-content` layout type. Any non-chrome (`footer`/`nav`) full-bleed section → `default` (full-width); otherwise `constrained`. This is independent of `heroIsCover`, which only controls the transparent overlay header. Specs without `fullBleed` default to constrained (back-compat).
- `classifyUrl` types: `homepage`, `post`, `product`, `gallery`, `event`, `page` (no `category`/`author`/`other`)
- Media filename collision handling uses numeric suffixes (`-2`, `-3`), not hashes
- `detect-platform` uses domain-level URL patterns and HTTP fingerprinting (headers + HTML markers) — no path-based detection
- Shopify variant weights are normalized to kilograms regardless of source unit (`kg`, `g`, `lb`, `oz`) via `normalizeWeightToKg`
- Shopify simple-product sale price uses `compareAtPrice > price` semantics — when set, `compareAtPrice` becomes `regularPrice` and `price` becomes `salePrice`
- `WooProduct` has first-class `seoTitle`, `seoDescription`, `costOfGoods` fields plus an open `meta` record; the CSV builder emits `meta:_yoast_wpseo_title`, `meta:_yoast_wpseo_metadesc`, `meta:_wc_cog_cost` columns always, plus `meta:<key>` columns for any custom keys
- `diffContent` in `src/lib/qa/content-differ.ts` measures extraction *loss* (origin items not in WXR), not hallucination — `missingImages` etc. reflect content that failed to make it into the output
- Screenshots live at `output/<site>/screenshots/{desktop,mobile}/<slug>.png` and `<slug>.scrolled.png` (post-scroll viewport capture). Rendered HTML is at `output/<site>/html/<slug>.html`. The join back to extracted content is filesystem-only via `output/<site>/screenshots/manifest.json`, which maps URL → files. Nothing is injected into WXR or products.csv — orchestration tooling (comparisons, design diffs, Claude Code flows) correlates by URL between manifest and `output.wxr` / `products.jsonl`.
- The screenshot feature adds one `ImportSession` stage: `screenshotting`. `data-liberation <url>` runs it by default; pass `--no-screenshots` to skip. MCP `liberate_extract` keeps it opt-in via `screenshots: true`.
- Screenshot capture default concurrency is 6 (parallel URL captures). Configurable via `--screenshots-concurrency N` on the default extract or `--concurrency N` on the `screenshot` subcommand. Clamped to [1, 10].
- Screenshot capture restarts the Playwright browser every N=100 URLs (configurable via `--browser-restart-every N`) to bound memory. Restarts happen at batch boundaries, not mid-batch.
- Same-origin enforcement: every captured URL must share origin with the `url` argument (or if only `urls[]` is given, all must share the first entry's origin). Throws `SameOriginViolation`. Mirrors `fetchSitemap` pattern.
- `validateOutputDir` rejects paths containing `..` or outside `process.cwd()`. Tests use a cwd-local `.tmp-test/` directory (gitignored) instead of `os.tmpdir()`.
- Scrolled-state screenshots are skipped silently (not a failure) when the page's `scrollHeight` is shorter than `viewport.height * 1.5 + viewport.height` — short pages don't have a distinct scrolled state to capture.
- Screenshot capture aggregates per-site design tokens into three files at run end: `output/<site>/palette.json` (dominant colors ranked by urls-desc), `output/<site>/typography.json` (font metrics per selector, deduped + ranked), and `output/<site>/breakpoints.json` (union of `@media min-width` / `max-width` integer px values). Collected by `SiteAnalysisAggregator` in `src/lib/screenshot/aggregator.ts`. Cross-origin stylesheets are skipped silently (their `.cssRules` throw); same-origin CSS contributes. These files are consumed by downstream replica/theme-generation workflows. Resume merges with prior-run aggregates.
