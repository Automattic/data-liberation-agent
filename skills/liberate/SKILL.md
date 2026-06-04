---
name: liberate
description: Front door for the whole migration — detect → discover, then ALWAYS stop and ask the operator (AskUserQuestion) which reconstruct path to take (blocks+products, or theme replication) BEFORE running extraction/capture, then dispatch the matching sub-skill. The path question is a mandatory, non-skippable gate that fires right after discovery while the operator is still present — never auto-select, never defer it past extraction. Idempotent: re-running on an already-captured site skips straight to the path question.
---

# Liberate a website

The single front door for the whole migration pipeline. It captures the site **once** (detect → discover → extract → capture → products), then asks which reconstruct path to take and **dispatches the matching sub-skill inline** (shared context):

- **`replicate-with-blocks`** — project the source onto editable WordPress core blocks + WooCommerce. Best launchpad for a redesign.
- **`replicate-theme`** — carry the source markup near-verbatim + scope its own CSS into a high-fidelity, non-block-editable theme.

Each sub-skill owns its own reconstruct → install → QA → report; this skill owns capture + the path decision. **Idempotent:** re-running `/liberate <url>` on an already-captured site skips straight to the path question (so you can try the other path later with zero re-capture).

**Headless extraction-only (CI/batch):** `data-liberation <url>` runs steps 1–5 (capture only). The reconstruct (blocks or theme) is agent-only, via the dispatched sub-skill.

---

## Pipeline overview

```
/liberate <url>   ── front door, shared context ────────────────────────────────
│
├─ idempotent check: extraction already on disk?  (.discovery-complete / session.json stage / output.wxr + html/* + manifest.json)
│     ├─ YES → load cached inventory ──────────────────────────────────────┐
│     └─ NO  → 1 detect → discover    platform · sitemap · features · archetype inventory (CHEAP)
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────────┘
│  ▼
├─ CONFIRM + PATH CHECKPOINT  ◀── MANDATORY HARD STOP, BEFORE EXTRACTION — never skip, never auto-select
│     show discovery inventory + scope/cost estimate + a platform-informed recommendation,
│     then ALWAYS AskUserQuestion: blocks+products vs theme replication.
│     The operator's answer is the ONLY thing that authorizes the rest of the run.
│     Nothing expensive (extract/capture) runs until they have answered.
│     ▼
├─ EXTRACTION (deterministic — only after the path is chosen):
│     2 extract               pages/posts/products content + media refs
│     3 media: dedup+upload   → uploaded WP-library URLs (reused downstream)
│     4 capture               desktop+mobile screenshots · palette/type/breakpoints · html/<slug>.html
│     5 products → products.csv    WooCommerce import format
│     ▼
└─ RECONSTRUCT — dispatch the chosen sub-skill INLINE (shared context):
      blocks+products → replicate-with-blocks   (core blocks + WooCommerce + QA ladder → run-report.json)
      theme           → replicate-theme         (carry-and-scope islands + scoped CSS → compare → run-report-carry.json)
```

Capture is still shared across both paths, so the "try the other path with zero re-capture" property holds: re-running `/liberate <url>` after a full run hits the idempotent check, loads the cached inventory, and lands you straight back on the path question.

Each sub-skill owns its own reconstruct → install → QA → report, plus its own budget guard (`checkBudget` in `src/lib/replicate/budget-guard.ts`) and run-report (`buildRunReport` in `src/lib/replicate/run-report.ts`). This skill's deliverable is the captured `output/<site>/` + the dispatch; the chosen sub-skill produces the replica + its `run-report*.json`.

---

## Step-by-step workflow

### Step 0 — Idempotent check (run first)

Derive `output/<site>/` from the URL. If extraction is already complete — any of `.discovery-complete`, a `session.json` stage past extraction, or all of `output.wxr` + `html/*.html` + `screenshots/manifest.json` present — **skip Steps 1 and 3–6**, load the cached inventory (`session.json` / discovery output), and jump straight to the **Step 2 — Confirm + path checkpoint** below. Otherwise run Step 1, hit the checkpoint, then run Steps 3–6. (For a partial capture, prefer `resume: true`; see Resuming.)

### Step 1 — Detect & discover

1. Ask for the URL if not already provided.
2. Call `liberate_detect` to identify the platform.
3. Call `liberate_discover` to inventory the site. Show the counts and **platform features** to the operator.
   - `platformFeatures` flags: stores, bookings, forms, members areas, scheduling, forums, events.
   - Features marked `transferable: true` (e.g. stores) are handled during extraction.
   - Features marked `transferable: false` include a `wpRecommendation` (suggested WP plugin).
   - Narrate: "Detected Wix · 47 pages · 3 archetypes · 12 products · store (WooCommerce) · forms (WPForms recommended)."

### Step 2 — Confirm + path checkpoint — MANDATORY HARD STOP (fires here, before any extraction)

> **This checkpoint is NOT optional and NOT skippable, and it fires RIGHT HERE — immediately after discovery, before extraction/capture.** You ask **while the operator is still present and paying attention**; that is the whole point of placing it before the long deterministic extraction, not after. You **MUST** stop and ask the operator to choose the reconstruct path via **AskUserQuestion** before running Step 3 (extract) or anything downstream. There is no "default path." You do **not** auto-select on the operator's behalf, no matter how strong the inventory signal is — a recommendation is a hint inside the question, never a decision. Starting extraction (or dispatching a sub-skill) without having asked this question is a defect. The **only** thing that authorizes the rest of the run is the operator's answer to this AskUserQuestion.

**Red flags — if you catch yourself thinking any of these, STOP and ask:**
- "Discovery's done, I'll kick off extraction and ask about the path later." → No. Extraction is the expensive part; ask BEFORE it, while the operator is here.
- "The platform clearly calls for blocks/theme, so I'll just run it." → No. Recommend *inside* the question; let them pick.
- "They already said blocks last time / earlier in the convo." → A prior run's choice does not carry over; ask again.
- "This is obviously a store, blocks is the only sensible path." → Still ask. The operator may want fidelity over editability.
- "I'll extract first so the operator has more data when they decide." → Discovery already gives platform · counts · features — enough to choose. Don't burn extraction to defer the question.

Show the discovery inventory (pages · archetypes · products · platform features) and a scope/cost/time estimate. Make a **platform-informed recommendation** (mark it `(Recommended)` as the first option), then call **AskUserQuestion** with these two options:

1. **Migrate content into blocks + products** — WordPress-native blocks + navigation + WooCommerce product pages. Best launchpad for a redesign. (Reconstructs product pages.)
2. **Theme replication** — carry-and-scope: highest-fidelity replica of the source, raw-HTML-editable (not block-editable). (Imports product *data*; product pages fall back to default WooCommerce, not a carried replica.)

Recommendation examples: a store with many products → recommend (1); a fixed-layout Wix marketing site, no store, where pixel-fidelity matters → recommend (2). **The operator's selection is the sole go-ahead** (this replaces the old proceed/confirm gate). Only after they answer do you run Steps 3–6 (extraction/capture) and then Dispatch.

### Step 3 — Extract

Call `liberate_extract` with an appropriate `outputDir`. Narrate per-URL progress.

**0 pages:** "No extractable pages found at `<url>`. The site may be behind auth or bot-protection — try CDP/admin extraction (`/diagnose`)." Stop.

### Step 4 — Media dedup + upload

Media references are deduped and uploaded to the WP media library. Uploaded URLs are the canonical media references used everywhere downstream (specs, templates, `post_content`).

### Step 5 — Capture

Runs automatically during or after extract: desktop+mobile screenshots, `palette.json` / `typography.json` / `breakpoints.json`, and `html/<slug>.html` per URL. Clustering in the blocks path runs off the already-saved `html/<slug>.html` — no re-navigation.

Default concurrency: 6. Configure via `--screenshots-concurrency N` or `--concurrency N`.

### Step 6 — Products → CSV

If products were extracted, compile `products.jsonl` → `products.csv` (WooCommerce import format). Report: "Also extracted N products → products.csv."

### Dispatch (inline)

Invoke the chosen sub-skill **inline via the Skill tool** (shared context; each sub-skill reads `output/<site>/` from disk and owns its own install → QA → report):

- blocks+products → **`replicate-with-blocks`**
- theme replication → **`replicate-theme`**

The reconstruct phase (clustering, foundations, theme, build, validate, install, visual-QA for blocks; carry-and-scope + compare for theme) lives **entirely in the dispatched sub-skill** — this front door ends here.


---

## Operator interaction states

| Stage | State | Response |
|---|---|---|
| extraction | 0 pages | Stop + "No extractable pages found at `<url>`. Try CDP/admin extraction (`/diagnose`)." |
| extraction | adapter fail | Log + pointer to `/diagnose` |
| checkpoint | operator picks a path | Dispatch the chosen sub-skill (`replicate-with-blocks` / `replicate-theme`) inline |
| reconstruct | gate fail · clusters failed · QA divergence · budget ceiling | Owned by the dispatched sub-skill — see its SKILL.md (`replicate-with-blocks`'s validate-artifacts + QA-ladder gates + budget guard; `replicate-theme`'s parity compare) |

Progress is the agent's own narration — no Ink TUI in agent mode. The headless extraction CLI keeps its existing Ink surfaces (`discover.tsx`, `screenshot.tsx`).

---

## Run report (per path)

Each reconstruct path emits its **own** report — `run-report.json` from `replicate-with-blocks`, `run-report-carry.json` from `replicate-theme` (each carries a `mode` field). The blocks-path `run-report.json` is verdict-first; read top-down to answer "is this good?":

1. `verdict` — overall ✓ / ⚠ / ✗ + per-archetype.
2. `summary` — clusters built/failed · pages composed/misfit · responsive pass/fail · sections divergent/accepted · pages unverified · provenance flags · fallback/low-confidence pages · est. cost/usage.
3. `details[]` — per-cluster + per-page status, gate results, QA notes, operator-accepted divergences (with proof).

The theme-path `run-report-carry.json` is parity-compare shaped — see `replicate-theme`.

---

## Resuming

If the user asks to resume (e.g. "resume", "continue", "it crashed"):

1. Ask for the URL if not provided — `outputDir` is derived from it.
2. Call `liberate_extract` with `resume: true` for extraction; `session.json` tracks stage so capture resumes where it stopped. Reconstruct resume (per-cluster build status, etc.) is the chosen sub-skill's concern.
3. If extraction was already complete (`.discovery-complete` exists), skip straight to the **Step 2 — Confirm + path checkpoint** (the idempotent path) and offer to run a reconstruct path. If only discovery completed and the run stopped before the checkpoint, re-run discovery (cheap) and ask the path question — extraction must not start until the operator has chosen.

The `resume` flag causes extraction to:
- Skip platform detection/discovery if a completed WXR already exists
- Skip URLs already successfully processed (tracked in `extraction-log.jsonl`)
- Rebuild media dedup hashes from existing files
- Append to the existing WXR rather than starting fresh

---

## Output-quality contract

These guarantees are enforced by the reconstruct sub-skills (mainly `replicate-with-blocks`'s validate-artifacts + QA gates; alt-text + copyright apply to both paths):

- A source section matching **no** catalog interaction-model maps to a **faithful generic** (`columns`/`group`) and is **flagged** in the run-report — never silently forced into a wrong-specific template.
- Capture-health fallback pages (hero+gallery) and misfit pages routed to `compose-page-blocks` are labeled **low-confidence / fallback** in the run-report.
- **Alt text:** carry the source's alt verbatim. Images with missing/empty alt are **flagged in run-report** for human fill — never AI-generated (provenance rule).
- **Contrast:** the brightness rule guarantees legibility. The validate-artifacts gate **warns** on sub-WCAG-AA (4.5:1) text in the run-report. It does not hard-fail or auto-adjust — the source itself may fail AA, and faithfulness wins.
- **Copyright:** third-party sites get the `style.css` "Benchmark reference only — not for publication." header.

---

## Discoveries

If you encounter something notable during extraction — a new API endpoint, a platform quirk, a workaround for blocked content, a better extraction technique — add an entry to `DISCOVERIES.md` at the top of the repo.

---

## Verification

After extraction completes, always run `liberate_verify` on the output directory. This checks:
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

- The extraction produces a WXR file (WordPress import format) + a media directory + a redirect map.
- If the site has products, a `products.csv` (WooCommerce format) and `products.jsonl` are also produced.
- All content is imported as **drafts by default** — the user reviews and publishes manually (the WXR a user imports into their production WordPress). This is `liberate_extract`'s `contentStatus` default (`'draft'`). **When building a replica/preview** (the design phase — a Studio/Playground replica whose nav must resolve), pass `contentStatus: 'publish'` to `liberate_extract`/`liberate_extract_one` so imported pages/posts are live instead of 404ing. Attachments always use WP's `inherit` regardless.
- The WordPress import step supports `importAuthors: true` to create WP user accounts per author, or `importAuthors: false` (default) to assign all content to the authenticated user. Ask before importing.
- If no environment import skill is available, validate the WordPress connection with `liberate_setup` first, then call `liberate_import` with REST API credentials. If the environment provides an import skill (e.g. `import-liberated-data`), use `delegate: true` with both `liberate_setup` and `liberate_import`.
