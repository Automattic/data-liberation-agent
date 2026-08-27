---
name: liberate
description: Front door for liberating a website. A URL becomes a complete, portable HTML site — detect, discover, liberate every route, then hand back a local copy that runs on its own. That portable site IS the deliverable; HTML is the contract. WordPress reconstruction (blocks+products or theme replication) is an OPTIONAL downstream step offered only when the operator asks for WordPress — never assumed, never required, never a precondition for liberating. A local directory of owned HTML/CSS/JS that the operator wants turned into a WordPress block theme dispatches liberate-local. Idempotent: re-running on an already-liberated site reuses what is on disk.
---

# Liberate a website

The front door for liberation. **Liberating a website means producing a complete, portable HTML copy of it** — every retained route, its CSS, assets, navigation, responsive behavior, and the client-side behavior it needs — in a directory that runs on its own.

**HTML is the contract.** The liberated site is the deliverable. It is not an intermediate representation on the way to some other platform, and it does not assume any destination.

**It routes on the input type:**

- **A URL** (a live site you don't control) → liberate it: detect → discover → liberate every route → serve the result locally. Stop there. That is a complete outcome.
- **A local directory** (a folder of owned HTML/CSS/JS) → there is nothing to liberate; the operator already owns the source. This input only makes sense when they want it turned into a **WordPress block theme**, which is owned entirely by **`liberate-local`** (read & follow `skills/liberate-local/SKILL.md`).

**WordPress is optional and downstream.** After a URL is liberated, the operator may want it reconstructed in WordPress. Offer that only when they ask for WordPress or have already said that WordPress is the destination. Two reconstruct paths exist:

- **`replicate-with-blocks`** — project the source onto editable WordPress core blocks + WooCommerce. Best launchpad for a redesign.
- **`replicate-theme`** — carry the source markup near-verbatim + scope its own CSS into a high-fidelity, non-block-editable theme.

**Idempotent:** re-running `/liberate <url>` on an already-liberated site reuses what is on disk instead of re-hitting the network, so a later WordPress reconstruct costs nothing extra.

**Headless (CI/batch):** `data-liberation <url>` performs the whole liberation and serves the result. `--no-serve` writes the site and exits. WordPress reconstruction is agent-only, via the sub-skills.

---

## Pipeline overview

```
/liberate <input>   ── front door, shared context ──────────────────────────────
│
├─ ROUTE ON INPUT TYPE  ◀── do this FIRST, before anything else
│     ├─ <input> resolves to an existing LOCAL DIRECTORY?
│     │     └─ YES → the operator owns this source; the only sensible job is
│     │              WordPress theme conversion → dispatch liberate-local INLINE → DONE
│     └─ otherwise treat as a URL ▼
│
├─ idempotent check: already liberated on disk?  (website/ + capture-receipt.json / artifact.json)
│     ├─ YES → reuse it ───────────────────────────────────────────────────┐
│     └─ NO  → 1 detect → discover    platform · sitemap · features · archetype inventory (CHEAP)
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────────┘
│  ▼
├─ 2 LIBERATE  ── the deliverable ──────────────────────────────────────────────
│     every retained route → hydrated HTML + CSS + assets, references rewritten
│     local, navigation and anchors resolving locally
│     ▼
├─ 3 SERVE + REPORT   runnable local copy · routes liberated/reused/failed ·
│     unresolved dependencies · anything the source withheld
│     ▼
│  ✅ DONE. The portable HTML site is a complete outcome. Stop here unless the
│     operator wants another destination.
│
└─ OPTIONAL — WordPress destination, only when the operator asks for WordPress:
      ask which reconstruct path (AskUserQuestion), then run the WordPress-path
      steps (extract → media → products) and dispatch the chosen sub-skill INLINE:
        blocks+products → replicate-with-blocks   (core blocks + WooCommerce + QA ladder → run-report.json)
        theme           → replicate-theme         (carry-and-scope islands + scoped CSS → compare → run-report-carry.json)
```

Liberation output is shared across every downstream destination, so trying a different destination later never re-hits the network.

Each reconstruct sub-skill owns its own reconstruct → install → QA → report, plus its own budget guard (`checkBudget` in `src/lib/replicate/budget-guard.ts`) and run-report (`buildRunReport` in `src/lib/replicate/run-report.ts`). This skill's deliverable is the liberated site; a chosen sub-skill produces the WordPress replica + its `run-report*.json`.

---

## Step-by-step workflow

### Step R — Route on input type (run before everything)

Before any detection, idempotent check, or extraction, decide which path the input takes:

- **Local directory** — if the input resolves to an **existing local directory** (an absolute or relative filesystem path to a folder of owned HTML/CSS/JS), there is nothing to liberate: the operator already has the source. The job is WordPress theme conversion, so dispatch `liberate-local` inline: **read & follow `skills/liberate-local/SKILL.md`** in this same shared context. That sub-skill owns the entire local pipeline (resolve inputs → optional data-model → `liberate_convert_local_site` → parity report). When it returns, you are done — **do not** run any of the URL steps below.
- **URL** — anything else (a `http(s)://` URL, or a bare host like `example.com`) takes the **URL** path: continue to Step 0. If the input has no scheme and is not a directory, treat it as a URL and normalize it (prepend `https://`).

Disambiguation rule when it's genuinely unclear: a value that **exists on disk as a directory** is local; otherwise it's a URL. A path that doesn't exist as a directory and looks like a host/URL is a URL — don't error, treat it as remote.

`liberate-local` is `user-invocable: false` (hidden from the user's autocomplete) and `disable-model-invocation: true`, so it only ever runs via this front door — the Skill tool will reject a direct `Skill({ skill: 'liberate-local' })` call. Dispatch = read its `SKILL.md` and execute its workflow inline.

### Step 0 — Idempotent check (run first, URL path)

Call `liberate_paths({ url })` to resolve the output directory (`siteDir`). Do not hardcode `output/<site>/` relative to cwd — the default output base is `~/data-liberation/<host>`. If the site is already liberated — `website/` plus `capture-receipt.json` / `artifact.json` present in the resolved `siteDir` — **skip Steps 1 and 2**, report what is already on disk, and go straight to Step 3. For a partial run, prefer `resume: true` (see Resuming) so existing routes are reused instead of recaptured.

### Step 1 — Detect & discover

1. Ask for the URL if not already provided.
2. Call `liberate_detect` to identify the platform.
3. Call `liberate_discover` to inventory the site. Show the counts and **platform features** to the operator.
   - `platformFeatures` flags: stores, bookings, forms, members areas, scheduling, forums, events.
   - Features marked `transferable: true` (e.g. stores) are handled during extraction.
   - Features marked `transferable: false` include a `wpRecommendation` (suggested WP plugin).
   - Narrate: "Detected Wix · 47 pages · 3 archetypes · 12 products · store (WooCommerce) · forms (WPForms recommended)."

### Step 2 — Liberate the site

Call `liberate_capture` with the resolved `outputDir` (pass `resume: true` to reuse routes already on disk). Narrate per-route progress.

This liberates every retained route into `<siteDir>/website/`: hydrated HTML, CSS, media, fonts, and required client runtime, with references rewritten to local paths so navigation and same-page anchors resolve inside the copy. It writes `capture-receipt.json` (routes, assets, layout geometry) and `diagnostics.json` (failures, unresolved dependencies) beside it.

**0 routes:** "Nothing could be liberated at `<url>`. The site may be behind auth or bot-protection — try CDP/admin access (`/diagnose`)." Stop.

Liberate **every** route in the retained set. A representative sample is not a liberated site; sampling is only acceptable when the operator explicitly asks for a scoped subset, and you must say plainly that the result is partial.

### Step 3 — Serve and report

Serve the liberated site locally and give the operator the URL so they can click through it themselves.

Report honestly, distinguishing outcomes that do not imply each other:

- Routes liberated, reused, and failed, against routes discovered.
- Unresolved dependencies and media from `diagnostics.json`.
- Anything the source withheld (auth-gated, bot-blocked, or client-only behavior that did not survive).

Do not describe a site as complete or one-for-one on the strength of route counts alone. Route coverage is not visual fidelity, and neither proves that interactive behavior survived.

**This is the end of liberation.** The portable HTML site is a complete deliverable. Do not offer, assume, or start a WordPress reconstruct unless the operator asks for WordPress.

### Optional — WordPress destination

Run this **only** when the operator has asked for WordPress. Show the liberation inventory (pages · archetypes · products · platform features) plus a scope/cost/time estimate, then call **AskUserQuestion** to choose the reconstruct path. Recommend **Theme replication** by default; recommend **Blocks + products** when the site is clearly a store or you have a strong, specific reason. Use this copy verbatim, listing the recommended option first with ` (Recommended)` appended:

- question: `How should the site be reconstructed in WordPress?`
- option label: `Blocks + products`
  description: `WordPress-native blocks + navigation + WooCommerce product pages. Best launchpad for a redesign. (Reconstructs product pages.)`
- option label: `Theme replication`
  description: `Carry-and-scope: highest-fidelity replica of the source, raw-HTML-editable (not block-editable). (Imports product data; product pages fall back to default WooCommerce, not a carried replica.)`

Never auto-select the path. A recommendation belongs inside the question; the operator's answer is the only thing that authorizes the reconstruct.

Then run the WordPress-path steps against the already-liberated site:

1. **Extract** — call `liberate_extract` with the same `outputDir` for pages/posts/products content and media refs, producing the WXR. Reuses the liberated HTML rather than re-hitting the network.
2. **Media dedup + upload** — deduped and uploaded to the WP media library; the uploaded URLs are the canonical references downstream (specs, templates, `post_content`).
3. **Products → CSV** — if products were extracted, compile `products.jsonl` → `products.csv` (WooCommerce import format). Report: "Also extracted N products → products.csv."

### Dispatch (inline)

All three sub-skills this front door dispatches — the two reconstruct skills plus `liberate-local` (dispatched at Step R for the local-directory input) — are `disable-model-invocation: true` by design, so they only ever run from this front door, never spontaneously. That means **the Skill tool cannot invoke them**: a `Skill({ skill: 'replicate-theme' })` call is rejected with `cannot be used with Skill tool due to disable-model-invocation`. So **dispatch = Read the chosen sub-skill's `SKILL.md` and execute its workflow inline in this same shared context** (each sub-skill reads the resolved output directory from disk — use the `siteDir` returned by `liberate_paths` — and owns its own install → QA → report):

- blocks+products → read & follow `skills/replicate-with-blocks/SKILL.md`
- theme replication → read & follow `skills/replicate-theme/SKILL.md`

The reconstruct phase (clustering, foundations, theme, build, validate, install, visual-QA for blocks; carry-and-scope + compare for theme) lives **entirely in the dispatched sub-skill** — this front door ends here.


---

## Operator interaction states

| Stage | State | Response |
|---|---|---|
| routing | input is a local directory | Dispatch `liberate-local` inline (read & follow its SKILL.md); skip all URL steps |
| liberation | 0 routes | Stop + "Nothing could be liberated at `<url>`. Try CDP/admin access (`/diagnose`)." |
| liberation | adapter fail | Log + pointer to `/diagnose` |
| liberation | routes failed or dependencies unresolved | Report them plainly; do not claim a complete copy |
| liberation | done | Serve the site, report coverage, and stop — WordPress is not implied |
| WordPress (optional) | operator asked for WordPress and picked a path | Dispatch the chosen sub-skill (`replicate-with-blocks` / `replicate-theme`) inline |
| reconstruct | gate fail · clusters failed · QA divergence · budget ceiling | Owned by the dispatched sub-skill — see its SKILL.md (`replicate-with-blocks`'s validate-artifacts + QA-ladder gates + budget guard; `replicate-theme`'s parity compare) |

Progress is the agent's own narration — no Ink TUI in agent mode. The headless CLI keeps its existing Ink surfaces (`discover.tsx`, `screenshot.tsx`).

---

## Run report (WordPress paths only)

Liberation itself reports through `capture-receipt.json` + `diagnostics.json`. The reports below exist only when a WordPress reconstruct ran.

Each reconstruct path emits its **own** report — `run-report.json` from `replicate-with-blocks`, `run-report-carry.json` from `replicate-theme` (each carries a `mode` field). The blocks-path `run-report.json` is verdict-first; read top-down to answer "is this good?":

1. `verdict` — overall ✓ / ⚠ / ✗ + per-archetype.
2. `summary` — clusters built/failed · pages composed/misfit · responsive pass/fail · sections divergent/accepted · pages unverified · provenance flags · fallback/low-confidence pages · est. cost/usage.
3. `details[]` — per-cluster + per-page status, gate results, QA notes, operator-accepted divergences (with proof).

The theme-path `run-report-carry.json` is parity-compare shaped — see `replicate-theme`.

---

## Resuming

If the user asks to resume (e.g. "resume", "continue", "it crashed"):

1. Ask for the URL if not provided — `outputDir` is derived from it.
2. Call `liberate_capture` with `resume: true`; routes already on disk are reused instead of recaptured, so only the missing ones cost network time.
3. If the site is already fully liberated, say so, serve it, and stop. Offer a WordPress reconstruct only if the operator asks for WordPress.

On the optional WordPress path, `liberate_extract`'s `resume` flag causes extraction to:
- Skip platform detection/discovery if a completed WXR already exists
- Skip URLs already successfully processed (tracked in `extraction-log.jsonl`)
- Rebuild media dedup hashes from existing files
- Append to the existing WXR rather than starting fresh

---

## Output-quality contract (WordPress paths)

These guarantees are enforced by the reconstruct sub-skills (mainly `replicate-with-blocks`'s validate-artifacts + QA gates; alt-text + copyright apply to both paths):

- A source section matching **no** catalog interaction-model maps to a **faithful generic** (`columns`/`group`) and is **flagged** in the run-report — never silently forced into a wrong-specific template.
- Capture-health fallback pages (hero+gallery) and misfit pages routed to `compose-page-blocks` are labeled **low-confidence / fallback** in the run-report.
- **Alt text:** carry the source's alt verbatim. Images with missing/empty alt are **flagged in run-report** for human fill — never AI-generated (provenance rule).
- **Contrast:** the brightness rule guarantees legibility. The validate-artifacts gate **warns** on sub-WCAG-AA (4.5:1) text in the run-report. It does not hard-fail or auto-adjust — the source itself may fail AA, and faithfulness wins.
- **Copyright:** third-party sites get the `style.css` "Benchmark reference only — not for publication." header.

---

## Discoveries

If you encounter something notable while liberating — a new API endpoint, a platform quirk, a workaround for blocked content, a better acquisition technique — add an entry to `DISCOVERIES.md` at the top of the repo.

---

## Verification

After liberation, always read `diagnostics.json` and report failed routes, unresolved dependencies, and unresolved media. Click-through of the served copy is the operator's own check.

On the optional WordPress path, also run `liberate_verify` on the output directory once extraction completes. This checks:
- Stale CDN URLs still embedded in content (Shopify, Squarespace, Webflow, Wix CDN domains)
- Failed page extractions and failed media downloads
- Quality score breakdown (high/medium/low)
- Media files on disk vs media attachments in the WXR
- Redirect map completeness

Report the verification results and flag anything that needs attention before importing.

---

## Platform-specific notes

### Squarespace

Squarespace sites benefit significantly from **admin extraction via CDP**. Without it, you only get public content — no drafts, no unlisted pages, and Squarespace 7.1 fluid engine sites often return empty content from the `?format=json` API.

**Guide the user through admin setup:**

1. Ask the user to launch Chrome with remote debugging:
   ```
   google-chrome --remote-debugging-port=9222
   ```
   (On macOS: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222`)
2. In that Chrome window, navigate to their Squarespace site and **log in to admin**.
3. Once logged in, run extraction with `--cdp-port 9222` (CLI) or `cdpPort: 9222` (MCP).

The admin session gives the adapter access to:
- Squarespace's admin API responses (richer metadata, structured content)
- Draft and unlisted pages not visible publicly
- `__NEXT_DATA__` hydration payloads on 7.1 sites
- Automatic fallback to DOM extraction if JSON data is sparse

**Always offer CDP-based extraction for Squarespace.** Public-only extraction works but produces lower quality results.

### Wix

Extraction uses Playwright (headless browser) to intercept Wix's internal API calls and extract window globals. This is slower but captures content that isn't available via HTTP alone. Large sites may take several minutes.

### Webflow

Webflow requires a Webflow API token. Ask the user for their token and pass it via `--token` (CLI) or the `token` parameter (MCP).

### Shopify

Shopify has **two extraction tiers**. Always offer the richer one first and fall back only if the user can't produce an Admin API token.

**Tier 1 — Public JSON API (no credentials)**

Works for any public Shopify storefront. Pulls pages, blog posts, and products via the public `/pages.json`, `/blogs.json`, and `/products.json` endpoints plus HTML fallback for theme-rendered content. No token needed. Product data is limited to what the public API exposes — you lose compareAtPrice sale semantics, real stock policy, cost of goods, variant images, and collections.

**Tier 2 — Admin GraphQL (richer product data)**

When the user has admin access to their store, offer to use Shopify's Admin GraphQL API. This yields:
- `compareAtPrice` → proper sale/regular price mapping on simple + variable products
- `inventoryPolicy` + `inventoryItem.tracked` → real stock status (oversell-aware)
- `inventoryItem.unitCost` → cost of goods written to `meta:_wc_cog_cost`
- `inventoryItem.measurement.weight` → unit-normalized weight (kg)
- Variant-level images
- Collections → WooCommerce categories
- SEO metafields (`meta:_yoast_wpseo_title` / `_yoast_wpseo_metadesc`)
- Cursor-based pagination with mid-run resume

**Guide the user through admin setup:**

1. Direct them to Shopify Admin → **Settings → Apps and sales channels → Develop apps**.
2. Create a new custom app (name it "Data Liberation" or similar).
3. Under **Configuration → Admin API access scopes**, enable at minimum:
   - `read_products` (required)
   - `read_inventory` (for cost-of-goods + stock)
   - `read_online_store_pages` / `read_online_store_navigation` (for pages)
   - `read_content` (for blog articles)
4. Click **Install app** to generate the Admin API access token — copy it immediately, Shopify only shows it once.
5. Pass the token as `adminToken` (MCP) or via the adapter opts. **You do not need to ask the user for the shop domain** — `liberate_discover` auto-detects the `*.myshopify.com` hostname from the storefront HTML (`Shopify.shop` JS global) and stores it as `inventory.shopDomain`, even for sites served on custom domains.

**When to use which tier:**
- User has a Shopify login and some admin comfort → **prompt for Tier 2** and walk them through the custom app flow above
- User just wants "get my stuff out" and doesn't want to touch admin → **Tier 1 is fine** but tell them upfront what they'll lose (sale pricing, cost of goods, richer categories)
- User has a custom storefront domain (e.g. `shop.brand.com`) → Tier 2 still works because of auto-detection; do NOT ask them for the myshopify.com subdomain manually unless the detector failed

**If `liberate_discover` did not populate `inventory.shopDomain`** (rare — the site may be behind Cloudflare or heavy bot protection that blocks HTML fetch), ask the user directly:
"I couldn't auto-detect the myshopify.com subdomain. Can you paste the URL you see when you log into your Shopify admin? It looks like `https://admin.shopify.com/store/<name>` — the `<name>` is what I need."

Pass the admin-resolved value as `shopDomain` alongside `adminToken`.

**GraphQL failures fall back to Tier 1 automatically** — if the token is wrong or the scopes are insufficient, the adapter logs a warning and continues with the public JSON path, so the user's extraction still produces output.

### GoDaddy Websites & Marketing

Public-crawl adapter for GoDaddy's **legacy** Websites & Marketing platform (also called "Go Daddy Website Builder" in page sources). Not to be confused with the newer Airo AI Builder.

GoDaddy offers **no data export** from W+M — this adapter rescues content by crawling the public site. Detection looks for the `Go Daddy Website Builder` generator meta tag, the `img1.wsimg.com/isteam/` CDN pattern, and the `X-SiteId` header.

Discovery fetches the three standard W+M sub-sitemaps individually so blog posts can be tagged precisely (W+M's `/news,-updates/f/<slug>` URL shape doesn't match the generic classifier):
- `sitemap.website.xml` — pages
- `sitemap.blog.xml` — blog posts
- `sitemap.ols.xml` — products (**v1.1**, not yet implemented)

**Blog post bodies are hydrated client-side from a `window._BLOG_DATA` JSON blob.** The adapter parses this blob and converts the Draft.js ContentState (`post.fullContent`) into HTML — preserving paragraphs, headings, lists, blockquotes, code blocks, links, and images. Title, publish date, categories, and featured image are also pulled from `_BLOG_DATA` rather than HTML meta tags (higher fidelity).

Pages use DOM-based extraction: strip `HEADER_SECTION`, `FOOTER_*`, cookie banners, and the first-section title/image widgets (`*_SECTION_TITLE_RENDERED`, `*_IMAGE_RENDERED0`) which would otherwise duplicate the `<wp:post_title>` and media attachment.

**v1 limitations:** No GoDaddy Online Store (OLS) product extraction yet — sites with a store are flagged, but products need a real store URL for testing before v1.1 ships.

---

## General notes

- Liberation produces `website/` (the portable HTML site), `capture-receipt.json`, `diagnostics.json`, and `artifact.json` under the resolved `siteDir`. That directory is self-contained and needs no WordPress to open, serve, or inspect.
- The notes below apply only to the optional WordPress path.
- Extraction produces a WXR file (WordPress import format) + a media directory + a redirect map.
- If the site has products, a `products.csv` (WooCommerce format) and `products.jsonl` are also produced.
- All content is imported as **drafts by default** — the user reviews and publishes manually (the WXR a user imports into their production WordPress). This is `liberate_extract`'s `contentStatus` default (`'draft'`). **When building a replica/preview** (the design phase — a Studio replica whose nav must resolve), pass `contentStatus: 'publish'` to `liberate_extract`/`liberate_extract_one` so imported pages/posts are live instead of 404ing. Attachments always use WP's `inherit` regardless.
- The WordPress import step supports `importAuthors: true` to create WP user accounts per author, or `importAuthors: false` (default) to assign all content to the authenticated user. Ask before importing.
- If no environment import skill is available, validate the WordPress connection with `liberate_setup` first, then call `liberate_import` with REST API credentials. If the environment provides an import skill (e.g. `import-liberated-data`), use `delegate: true` with both `liberate_setup` and `liberate_import`.
