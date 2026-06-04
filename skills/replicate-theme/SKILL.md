---
name: replicate-theme
description: Parity-first carry-and-scope theme reconstruction — dispatched by `/liberate` after capture. Instead of projecting the source onto editable WordPress blocks (the `replicate-with-blocks` path), it CARRIES the source page near-verbatim and SCOPES the source's own CSS under a per-site wrapper, producing a high-fidelity but NON-block-editable theme. It owns only the reconstruct→theme stage (capture already happened in `/liberate`); writes `output-carry.wxr` + a `<site>-carry` theme and installs into a Studio site named after the source. Use when the user picks "theme replication" at the `/liberate` checkpoint, or asks to "carry the HTML", "scope the source CSS", or maximize visual parity vs. blocks.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
disable-model-invocation: true
---

# Replicate Theme — Carry-and-Scope Parity Path

You are the **carry-and-scope reconstruct orchestrator**. `/liberate` dispatches you inline after it has captured the site; you rebuild it by carrying the source markup near-verbatim and scoping the source's own CSS, rather than projecting onto core blocks. The goal is maximum visual parity. You own only the reconstruct→theme stage — capture already happened in `/liberate`.

**Read this first — what you are trading.** This path emits each page region as a single `core/html` island. These pages are **raw-HTML-editable, not block-editable**. You are deliberately trading all block editability for fidelity. Do not "improve" the output by converting islands to blocks — that is the block path's (`replicate-with-blocks`) job, and the whole point here is to NOT do that.

**Honesty bar.** Per [[feedback_honest_visual_assessment]] and [[feedback_never_guess_always_look]]: when you report parity, render source and built at the same width, crop both, read both, and itemize the real differences bluntly BEFORE claiming any win. Never assert parity you have not looked at.

## Entry contract — capture already happened

`/liberate` dispatches you **after** extraction, so `output/<site>/` already holds the carry inputs. **Assume they exist.** If any required input is missing/incomplete, STOP and tell the operator to run `/liberate <url>` first — do NOT capture here (that's a `/liberate` capture gap to surface, not silently re-run).

**The carry inputs you consume (all produced by `/liberate`'s extraction):**

- `html/*.html` — rendered source HTML per page (the carry source). **Required.** Posts are captured as `post--<name>.html`.
- `screenshots/desktop/*.png` + `screenshots/mobile/*.png` + `screenshots/manifest.json` — source truth for the parity compare. **Required.**
- `output.wxr` — the base WXR you patch into `output-carry.wxr`.
- `redirect-map.json` — `[{from,to}]` source-path → local-permalink map. Drives the internal-link rewrite (nav + body hrefs → local). Without it, links pass through to the source domain.
- `media/` + `media-stubs.json` — downloaded assets and their CDN-URL→filename records. The reconstruct installs these into the site and rewrites carried `<img>`/`url()` to the local WP library.
- `sections/*.json` — optional (the splitter keys off the DOM, not specs), but read if present.

## MCP tool you call

| Tool | What it does |
|---|---|
| `liberate_reconstruct_pages_carry({ outputDir, studioSitePath, themeName?, pages })` | **The carry reconstruct.** For each `{ slug, sourceUrl, title, isHome?, postType?, htmlSlug? }`: loads `html/<htmlSlug ?? slug>.html` (or fetches `sourceUrl`), `collectCss` (cached to `<outputDir>/css/<slug>.css`), splits header/main/footer, carries each region verbatim into a `core/html` island, scopes the source CSS (chrome → `body.lib-carry-site` site-wide; main → `body.lib-carry-site.lib-carry-page-<slug>`), treeshakes against the carried DOM. It also **rewrites internal links** to local permalinks (shared `buildPageLinkMap` over `redirect-map.json`) and **installs the run's media + rewrites carried `<img>`/`url()` to the local WP library** (shared `installRunMediaMap` → `installMediaForUrl`). Writes a real FSE block theme to `<studioSitePath>/wp-content/themes/<derived-slug>-carry/` (parts/header.html, parts/footer.html, templates/ incl. `single.html` for posts, assets/css/site.css + page-*.css, functions.php with `is_front_page()`/`is_page()`/`is_single()` body-class + enqueue conditions, theme.json, style.css). Returns `{ themeRoot, themeSlug, themeFilesWritten, mediaInstalled, mediaErrors, fetchErrors, pages: [{ slug, title, isHome, postType, postContent }] }`. |

The tool reuses the SAME helpers as the block `replicate-with-blocks` path — `buildPageLinkMap` (`src/lib/replicate/page-link-map.ts`) and `installRunMediaMap` (`src/lib/replicate/run-media-map.ts`). Don't reimplement link/media logic in the orchestrator.

You also reuse the shared install/import/compare tools: `liberate_preview` (provision Studio site), `liberate_import` (WXR import), `liberate_compare` (source-vs-rendered pixel diff). Read their schemas in `src/mcp-server.ts` before calling.

> **Theme slug derives from `outputDir`.** Run with `outputDir: output/<site>` and the theme installs to `wp-content/themes/<site>-carry` (the `-carry` suffix is on the THEME name only — the Studio *site* name is just `<site>`, see step 2). `installMediaForUrl` self-hosts the run's media directly. (Known gap: the slug should really derive from `studioSitePath`, not `outputDir`.)

> **The MCP server does NOT hot-reload.** `liberate_reconstruct_pages_carry` is a new tool — if the server was started before it was added, restart the MCP server first or the tool will be missing. (See AGENTS.md.)

## The flow

**Committed scripts that drive this (all site-generic, all paths from argv):**

| Script | Does |
|---|---|
| `carry-reconstruct-drive.ts <out> --slim` | Step 2: slim `output.wxr` for provisioning (drop attachment items, flip draft→publish), backing the full WXR up to `output.wxr.full`. |
| `scripts/carry-reconstruct-drive.ts` | Steps 1 + 3 + 4 in one run: build the page list, drive `reconstructPagesCarryHandler` (theme + media + islands + `_swap.php`), write `output-carry.wxr`, restore `output.wxr` from `.full`. Pass `<outputDir> --list` (instead of `<studioSitePath>`) to just build + inspect the page list cheaply (no handler load). `EXCLUDE=slug1,slug2` drops junk/unwanted pages (404, sitemap, thank-you, or per-site curation). |
| `scripts/carry-replica-shots.ts` | Step 6: screenshot the live carry site into a replica dir for `liberate_compare`. |

The reconstruct tool can't run via the MCP server (long-lived, no hot-reload), so these tsx scripts run the on-disk handler directly. The page-list + WXR-patch logic is the tested lib `src/lib/replicate/carry-page-list.ts` (`buildCarryPageList` / `buildOutputCarryWxr`) — the single source of truth shared by the driver and its `--list` inspector.

### 1. Resolve the run and build the page list

The driver builds this internally via `buildCarryPageList` (in the tested lib `src/lib/replicate/carry-page-list.ts`) — you don't hand-assemble it; run `… <outputDir> --list` to inspect what will carry first. The join it performs, for reference: read `screenshots/manifest.json` (URL → files), cross-reference `output.wxr`(.full) for each `page`/`post` item's `post_name` (slug) + title, and produce `pages: [{ slug, sourceUrl, title, isHome?, postType?, htmlSlug? }]`:
  - **Pages**: `slug` = WP `post_name`, `postType: 'page'`, `htmlSlug` = slug. The front page is captured as `homepage` (matched by root-URL `<link>` OR `post_name` `home`/`homepage`).
  - **Posts**: `slug` = bare WP `post_name`, `postType: 'post'`, `htmlSlug` = the manifest slug (e.g. `post--world-teacher-day`). The WXR post `<link>` drops `/post/` but the manifest URL keeps it; join by exact `post--<post_name>.html` then prefix-match (`%`-encoded / truncated slugs).
  - Pages with no captured `html/<htmlSlug>.html` are skipped + logged.

### 1a. Scope: full carry vs hybrid (blog-dominant sites)

`buildCarryPageList` covers every captured page AND post — correct for **small** sites. But on a **blog/news-dominant** source (hundreds of posts), carrying every post is the wrong trade: the carry path emits one scoped-CSS sheet **per** carried page, so N-hundred posts bloat the theme to tens of MB of near-duplicate blog-template CSS (see "CSS weight" below), and a pixel-carried article gains nothing over native rendering. Posts are text + images — they belong in a normal blog template fed by the WXR content already extracted.

**Hybrid (default for content-heavy sites):** carry only the custom/marketing pages (homepage + service/about/landing — the bespoke designs); let posts, the blog index/archives, events, and tag/category pages stay **native** (imported from the WXR at provision, rendered by the theme's block templates). Scope the carry set with `EXCLUDE=` on `carry-reconstruct-drive.ts` (drop `/news`, `/blog`, `/the-dose`, post archives, …) — run `--list` first to confirm what carries. The capture must cover the carried pages in FULL (a representative-only sample can't carry — `/liberate` Step 5 makes capture scope depend on this choice); surface the gap, don't silently skip.

**Two native-side jobs the carry tool does NOT do — own them when going hybrid:**

1. **Working blog templates.** The emitted `single.html` is shaped around carried-post *islands*; with no posts carried, verify native posts + archives actually render, and if not add standard block templates — `single.html` (post-title + post-content + post meta), `home.html`/`index.html` + `archive.html` (a `core/query` loop) — scoped to the carry theme. Native blog should look clean-and-native, NOT pixel-matched to the source feed.
2. **Native-post media localization.** The carry tool rewrites carried-island `<img>`/`url()` to the local library, but **native post bodies keep their source-CDN URLs** — the images ARE downloaded + installed by step 3's media install, only the *content references* aren't rewritten. After step 3, run `npx tsx scripts/localize-native-post-media.ts output/<site> <studioSitePath>` to rewrite native `post_content` to the local copies (source→local map from `media-stubs.json`'s recorded `localUrl`s). [[feedback_never_lose_source_content]]

### 2. Provision the Studio site

- **Slim first:** `npx tsx scripts/carry-reconstruct-drive.ts output/<site> --slim`. A media-heavy WXR (hundreds of attachments) trips Studio's ~120s blueprint-import silence timeout (surfaces as `Error establishing a database connection`; the half-created site is removed) — see [[project_studio_import_heartbeat]]. The `--slim` mode (lib `slimWxrForProvision`) slims `output.wxr` IN PLACE (drops every `attachment` `<item>`, flips draft→publish) and backs the full WXR up to `output.wxr.full`. The reconstruct installs media separately (step 3), so the provisioned site loses nothing — and **step 3's driver restores `output.wxr` from `.full` at the end**, so the slim is transient and the dir is never left lossy (a later blocks run / `liberate_verify` still sees the full WXR).
- Provision via `liberate_preview({ outputDir })` — it reads the now-slimmed `output.wxr`. The site is named `<site>` (e.g. `~/Studio/<site>`, no path suffix); if a blocks-path site already exists with that name, `studio.ts` uniques it (`<site>-2`, …), so both paths on one extraction yield distinct sites without clobbering. `liberate_preview` returns `path` (the resolved Studio WP root) — pass it straight through as `studioSitePath` in step 3 (no need to re-derive `~/Studio/<site>`).

### 3. Run the carry reconstruct (steps 1 + 3 + 4, one command)

- `npx tsx scripts/carry-reconstruct-drive.ts output/<site> <studioSitePath> "<Site> (Carry)"` — use `liberate_preview`'s returned `path` as `<studioSitePath>`. This runs `reconstructPagesCarryHandler` on the on-disk source (the MCP server can't — it doesn't hot-reload) and, in one pass: builds the page list (step 1), installs the run's media + self-hosts it (`installMediaForUrl` — one site, one stub store, no cross-site stamping), rewrites links + img/url to local, writes the theme, writes the islands + `_swap.php`, writes `output-carry.wxr` (step 4), and restores `output.wxr` from `.full`. The theme slug derives from `outputDir` → `<site>-carry` (theme name only — distinct from the un-suffixed *site* name); the driver prints `THEMESLUG=…` and the `mediaInstalled`/`mediaErrors`/`fetchErrors` counts.
- **Verify the fixes landed**, don't assume: the homepage island should have local `/…/` nav hrefs (not `https://<source>/…`) and `…/wp-content/uploads/…` img srcs (not the CDN); a post island should have `is_single('<slug>')` in functions.php; spot-check a few rewritten image URLs return HTTP 200.

### 4. `output-carry.wxr` (handled by the step-3 driver)

The step-3 driver already writes this (`buildOutputCarryWxr`): it copies the FULL `output.wxr.full` (with attachments — this is the import deliverable, NOT the slimmed provision WXR) and, for each island, REPLACES that item's `<content:encoded>` body with the island (matching `page` AND `post` items by `<wp:post_name>` == slug), preserving everything else (titles, dates, IDs, menus, media items) verbatim ([[feedback_never_lose_source_content]]). The island is CDATA-wrapped (any `]]>` escaped as `]]]]><![CDATA[>`) via a per-item **function** replacer — not a greedy regex, not a string replacement (avoids the `$&`/`$1` footgun, see [[project_capture_document_nesting_bug]]). The driver prints `items`/`patched`/`cdataBalanced`; confirm the item count round-trips and `xmllint --noout output/<site>/output-carry.wxr` passes.

### 5. Swap content into the live site + activate

- **Do NOT re-import `output-carry.wxr` to update content** — the WXR importer skips items whose GUID already exists, so it won't overwrite content already in the site. Instead swap directly. The step-3 driver already wrote the islands + a `_swap.php` into `<studioSitePath>/wp-content/uploads/_carry-islands/`; run it: `studio wp --path <studioSitePath> --user=admin eval-file /wordpress/wp-content/uploads/_carry-islands/_swap.php` (VFS path — Studio mounts the site at `/wordpress`; `--user=admin` gives `unfiltered_html` so KSES doesn't strip carried markup). It finds each post by `post_name` across `['page','post']` and `wp_update_post`s its `post_content`, publishing it.
- Activate the carry theme (`studio wp --path <studioSitePath> theme activate <themeSlug>`). Set the static front page (`option update show_on_front page` + `option update page_on_front <homepage id>`) and `rewrite flush`.

### 5a. Enrich product marketing (stores only)

- If the run has products, run `npx tsx scripts/enrich-product-marketing.ts output/<site> <studioSitePath>` AFTER products are imported + media is installed. It rebuilds the CDN→local media map from the attachments' `_dla_source_url` meta (one query — covers already-installed media, which `installRunMediaMap` would miss), reconstructs each product's marketing sections into core blocks (joining section-image URLs to the library by basename so the structured renderers emit them instead of falling back to islands), writes them to each product's `post_content` (joined by SKU) and the short blurb to the excerpt, in one bulk DB pass. It prints a per-product `N core blocks, M html islands` line; expect mostly core blocks (islands only for sections too complex to reconstruct without losing content).
- **Verify:** load a product page — the buy box (gallery + title + price + add-to-cart) is functional Woo, and the rich marketing renders full-width below it (not a thin blurb). A product that comes out thin means its section specs weren't captured (re-capture) or its marketing is JS-rendered.

### 6. Render, screenshot, and compare — the parity verdict

- Screenshot the built site (desktop + mobile) for every page: `npx tsx scripts/carry-replica-shots.ts output/<site> <carryBaseUrl> output/<site>/replica-carry`. It navigates via `redirect-map.json` (posts move `/post/<slug>` → `/<slug>/`, which WP further 301s to its date permalink, so the bare source path would rely on WP's flaky canonical-redirect guessing), and keys the replica manifest by the SOURCE url so `liberate_compare` joins origin↔replica by pathname.
- Run `liberate_compare({ originDir: "output/<site>/screenshots", replicaDir: "output/<site>/replica-carry" })` against the SOURCE screenshots. Emit `output/<site>/run-report-carry.json` with a per-page and overall parity score, mirroring the block path's `run-report.json` shape.
- **Report the carry score directly NEXT TO the block path's score** for the same pages. This is the deliverable — the evidence for whether carry-and-scope actually wins, and by how much.
- Then do the honest visual pass: for the 2–3 worst pages, crop source and built at the same width side by side, read both, and itemize the real differences. State plainly where the carry theme still falls short.

## What v2/v3 fixed (don't re-describe these as gaps)

- **Media is self-hosted.** The reconstruct installs the run's media into the site and rewrites carried `<img src>`/`srcset` and HTML `url()` to the local `/wp-content/uploads/…` library — no source-CDN dependency. (Requires the run's stub store; see the harness caveat.)
- **Internal links are local.** Nav + body hrefs are rewritten to imported permalinks via the shared `buildPageLinkMap`. Genuinely-external/unmapped targets (RSS feeds, social, pages you didn't extract) are correctly left alone.
- **Posts are carried.** `postType: 'post'` scopes via `is_single()` and renders through one shared `single.html`; per-post CSS still scopes individually by body class.
- **It is a real FSE block theme.** `wp_is_block_theme()` → true (theme.json v3 + block templates + parts). Only the page/post *body* is a single `core/html` island (the deliberate non-block-editable trade).
- **WooCommerce store pages get chrome + rich product marketing (v4).** When the run has products, the reconstruct emits `templates/single-product.html` + `templates/archive-product.html` wrapped in a dedicated `header-store` part + canonical footer. **`archive-product.html`** wraps `wp:woocommerce/legacy-template` (classic shop grid + sorting/pagination). **`single-product.html`** uses MODERN WC product blocks for the buy box (`product-image-gallery` + `core/post-title` + `product-rating` + `product-price` + `product-summary` + `add-to-cart-form` + `product-meta`) so order is controllable, then renders the product's rich source marketing FULL-WIDTH below via `core/post-content`. That post_content is produced by **`scripts/enrich-product-marketing.ts`** (flow step 5a): it reconstructs each product page's marketing sections (everything but the gallery/hero Woo reproduces + footer chrome) into CORE blocks via the block path's `reconstructPagePattern` (with a per-section `core/html` fallback where reconstruction would drop content), and sets the short Shopify blurb as the product excerpt (shown by `product-summary`). theme.json carries the captured palette/font tokens (`loadCarryDesignTokens`) so the core blocks resolve their color/font references. The source's "you may also like" lands at the end of the marketing (the standalone `woocommerce/related-products` block does not render on this template). Provision also sets `woocommerce_coming_soon=no` (WC 8.x+ ships it ON). If NO header can be isolated, the handler emits a `warnings[]` entry and store pages fall back to WC's bare defaults. Product *data* fidelity still depends on the extraction tier (Tier 1 = no variant images / collections→categories); marketing fidelity depends on the captured section specs (a JS-rendered comparison table whose columns weren't captured renders sparse).

## Known limitations (state these in the report; do not let them masquerade as success)

- **CSS-file `url()` backgrounds only rewrite on exact map-key match.** Carried HTML `<img>`/inline `url()` rewrite robustly (incl. Wix transform URLs — `rewriteMediaUrls` applies map entries longest-source-first so a base URL doesn't mangle a transform URL into `<local>.jpg/v1/fill/…`). But background images in the scoped CSS sheets are only rewritten when the exact URL is a map key; relative/query-string `url()`s can still point at the source.
- **`data-pin-media` (Pinterest) transform URLs still mangle** — invisible (not rendered), harmless; the candidate collector doesn't scan that attribute.
- **Non-semantic chrome (headers ride inline).** On sites without top-level `<header>`/`<footer>` tags (many Wix/Squarespace — and Shopify, whose `<header>` is wrapped deeply enough that `splitRegions` doesn't lift it), the separate header/footer parts come back empty and the chrome rides INLINE in each page's main island. Content pages render fine (their island carries the header); WooCommerce store pages — which have no island — instead use the extracted `header-store` part (see "store pages get chrome" above).
- **Dynamic behavior dropped.** Scripts are stripped; carousels, menus, scroll effects won't animate. Static computed layout is carried.
- **Wix scale offset (the dominant fidelity gap).** Carried Wix layout renders larger than the source capture at the same width (Wix's responsive scaling is JS-driven and absent in static carry), pushing content below the fold. Worst on the homepage. This — not media/links — is the open lever.
- **CSS weight.** Per-page sheets carry treeshaken source CSS; on chrome-less Wix the full chrome CSS duplicates into every page/post sheet (50 sheets × ~150KB). Acceptable for a parity path.

## When you finish

Summarize the carry vs block parity scores side by side and the honest itemized gaps on the worst pages.

**Pixel scores on dynamic (Wix/JS) sites carry real capture noise — quantify it before claiming a win.** Capturing the SAME built site 2–3 times moved the overall score ±0.02, and individual dynamic content pages (blog feeds, galleries) swung 0.10–0.12 from lazy-load/animation timing. On corneliusholmes that spread *exceeded* the carry-vs-block gap → the numeric A/B is a **tie**, even though the carried pages are content-faithful. So: report the multi-capture spread, and separate **correctness wins** (self-hosted media, local links, posts rendering — verify each visually/by HTTP) from **pixel-score wins** (often within noise). Recommend next steps from the evidence — the Wix scale offset is the highest-leverage open item, not media or links.
