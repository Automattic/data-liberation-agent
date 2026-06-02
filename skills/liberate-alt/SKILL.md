---
name: liberate-alt
description: Parity-first ALTERNATE reconstruction path for an already-liberated site. Instead of projecting the source onto editable WordPress blocks (the `replicate` path), it CARRIES the source page near-verbatim and SCOPES the source's own CSS under a per-site wrapper, producing a high-fidelity but NON-block-editable theme. Reuses an existing run's captured `html/`, `sections/`, and `media/`; swaps only the reconstruct→theme stage; writes a parallel `theme-alt/` + `output-alt.wxr` and installs into a SEPARATE Studio site so you can A/B its parity against the block path on the same captured data. Use when block-path parity falls short and the user asks to "try the alt path", "carry the HTML", "scope the source CSS", run `/liberate-alt`, or compare carry-and-scope vs. blocks.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# Liberate (Alt) — Carry-and-Scope Parity Path

You are an **alternate reconstruct orchestrator**. You take an already-liberated site and rebuild it by carrying the source markup near-verbatim and scoping the source's own CSS, rather than projecting onto core blocks. The goal is maximum visual parity for direct A/B comparison against the block path (`replicate`).

**Read this first — what you are trading.** The alt path emits each page region as a single `core/html` island. These pages are **raw-HTML-editable, not block-editable**. You are deliberately trading all block editability for fidelity. Do not "improve" the output by converting islands to blocks — that is the block path's job, and the whole point here is to NOT do that.

**Honesty bar.** Per [[feedback_honest_visual_assessment]] and [[feedback_never_guess_always_look]]: when you report parity, render source and alt at the same width, crop both, read both, and itemize the real differences bluntly BEFORE claiming any win. Never assert parity you have not looked at.

## Prerequisites

Confirm these exist in `output/<site>/` (a prior `/liberate` run). If missing, stop and tell the user to run `/liberate <url>` first — the alt path does NOT re-capture:

- `html/*.html` — rendered source HTML per page (the carry source). **Required.**
- `screenshots/desktop/*.png` + `screenshots/mobile/*.png` + `screenshots/manifest.json` — source truth for the parity compare. **Required.**
- `output.wxr` — the block path's WXR; used as the base you patch into `output-alt.wxr`.
- `sections/*.json` — optional in v1 (the splitter keys off the DOM, not specs), but read if present.
- `media/` — downloaded assets (carried images may still point at the source domain in v1; see Known limitations).

## MCP tool you call

| Tool | What it does |
|---|---|
| `liberate_reconstruct_pages_alt({ outputDir, studioSitePath, themeName?, pages })` | **The alt reconstruct.** For each `{ slug, sourceUrl, title, isHome? }`: loads `html/<slug>.html` (or fetches `sourceUrl`), `collectCss` (inline + external sheets over HTTP, cached to `<outputDir>/css/<slug>.css`), splits header/main/footer, carries each region verbatim into a `core/html` island, scopes the source CSS (chrome → `body.lib-alt-site` site-wide; main → `body.lib-alt-site.lib-alt-page-<slug>`), treeshakes against the carried DOM, and writes a minimal block theme to `<studioSitePath>/wp-content/themes/<slug>-alt/` (parts/header.html, parts/footer.html, templates/, assets/css/site.css + page-*.css, functions.php, theme.json, style.css). Returns `{ themeRoot, themeSlug, pages: [{ slug, title, isHome, postContent }] }` where `postContent` is the page's main island. |

You also reuse the shared install/import/compare tools: `liberate_preview` (provision Studio site), `liberate_import` (WXR import), `liberate_compare` (source-vs-rendered pixel diff). Read their schemas in `src/mcp-server.ts` before calling.

> **The MCP server does NOT hot-reload.** `liberate_reconstruct_pages_alt` is a new tool — if the server was started before it was added, restart the MCP server first or the tool will be missing. (See AGENTS.md.)

## The flow

### 1. Resolve the run and build the page list

- Locate `output/<site>/`. Read `screenshots/manifest.json` (URL → files) to enumerate pages; cross-reference `output.wxr` for each page's title and slug. Mark the homepage `isHome: true` (the `/` URL, or the WXR item that is the front page).
- Produce `pages: [{ slug, sourceUrl, title, isHome? }]` covering every content page. Verify each `html/<slug>.html` exists; skip (and log) any page with no captured HTML.

### 2. Provision a SEPARATE Studio site (clean A/B)

- Do NOT reuse the block path's Studio site — a separate site keeps the comparison clean. Create/reuse a Studio site named `<site>-alt` via `liberate_preview` (it creates the site; you will overwrite its theme in the next step). Capture the returned `studioSitePath` (`~/Studio/<siteName>`).
- If `liberate_preview` insists on importing a WXR/theme to create the site, let it create the site with the block theme; you replace the theme + content below.

### 3. Run the alt reconstruct

- Call `liberate_reconstruct_pages_alt({ outputDir: "output/<site>", studioSitePath, themeName: "<Site> (Alt)", pages })`.
- It writes the `theme-alt` theme into the site and returns per-page `postContent` islands. Note the returned `themeSlug`.

### 4. Build `output-alt.wxr` (patch islands into the base WXR)

The alt pages' content is the returned islands, not block markup. Produce `output/<site>/output-alt.wxr` by copying `output.wxr` and, for each returned page, REPLACING that item's `<content:encoded>` body with the page's `postContent` island (match by `<wp:post_name>` == slug; the home page may be matched by being the front page). Preserve everything else (titles, dates, IDs, menus, media items) verbatim — do NOT drop content ([[feedback_never_lose_source_content]]).

- Wrap the island in `<![CDATA[ ... ]]>` exactly as WXR encodes post content.
- Do this with a small, auditable transform (a one-off `tsx` script or careful per-item edit), NOT a greedy regex over the whole file. Verify the item count and every slug round-trips before and after.

### 5. Install + import + activate

- Activate the alt theme in the Studio site (`wp theme activate <themeSlug>` via the site's CLI, or `liberate_install_theme` if it fits).
- Import `output-alt.wxr` into the alt site (`liberate_import`), replacing the block content. Set the static front page (`wp option update show_on_front page` + `page_on_front` to the home page) — mirror the block path's front-page handling so `/` renders the home reconstruction.

### 6. Render, screenshot, and compare — the parity verdict

- Screenshot the alt site (desktop + mobile) for every page.
- Run `liberate_compare` (or the existing replica-screenshot + diff tooling) against the SOURCE screenshots in `screenshots/`. Emit `output/<site>/run-report-alt.json` with a per-page and overall parity score, mirroring the block path's `run-report.json` shape.
- **Report the alt score directly NEXT TO the block path's score** for the same pages. This is the deliverable — the evidence for whether carry-and-scope actually wins, and by how much.
- Then do the honest visual pass: for the 2–3 worst pages, crop source and alt at the same width side by side, read both, and itemize the real differences. State plainly where alt still falls short.

## Known limitations (state these in the report; do not let them masquerade as success)

- **Media not liberated (v1).** Carried image URLs are NOT rewritten to WP media — they load from the source domain. Visually this still renders (helps parity), but the images are not self-hosted. `mediaUrlMap` is empty in v1.
- **CSS `url()` parity gap.** Background images referenced by relative or query-string `url()` in source CSS are not rewritten and point at the source domain (or 404 if the source is down).
- **Non-semantic chrome.** On sites without `<header>`/`<footer>` tags (many Wix/Squarespace), `splitRegions` returns empty chrome, so there are no separate header/footer template parts — the whole body rides in the main island (still renders, but chrome is not a reusable part).
- **Dynamic behavior dropped.** Scripts are stripped; carousels, menus, and scroll effects won't animate. Static computed layout is carried.
- **CSS weight.** Per-page sheets carry the source's (treeshaken) CSS; shared utility rules duplicate across the chrome and page sheets. Acceptable for an exploratory parity path.

## When you finish

Summarize: the alt vs block parity scores side by side, the honest itemized gaps on the worst pages, and which limitations above materially affected the result. Recommend whether carry-and-scope is worth pursuing past v1 based on the evidence — not on the concept.
