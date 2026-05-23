---
name: liberate
description: Extract content from a closed web platform and reconstruct it as a responsive, editable WordPress block theme — detect → discover → extract → capture → design → install → QA → run-report.json
---

# Liberate a website

The single front-door, root orchestrator for the whole migration pipeline. One shared agent context runs extraction through design — no subprocess spawning, no context fragmentation. Deterministic stages are MCP tool calls; judgment stages are inline sub-skill invocations; only the per-cluster section builders fan out to parallel subagents.

**Headless extraction-only (CI/batch):** `data-liberation <url>` runs steps 1–5 without the design phase. The design phase is agent-only via this skill.

---

## Pipeline overview

```
/liberate <url>   ── root orchestrator, shared context ─────────────────────────
│
│  EXTRACTION  (deterministic — existing MCP tools)
├─ 1  detect → discover            platform · sitemap · features · archetype inventory
├─ 2  extract                      pages/posts/products content + media refs
├─ 3  media: dedup + upload        → uploaded WP-library URLs (reused everywhere downstream)
├─ 4  capture                      desktop+mobile screenshots · palette/typography/breakpoints · html/<slug>.html
├─ 5  products → products.csv      WooCommerce import format
│
│  [ CONFIRM: show inventory + scope/cost/time estimate — wait for operator go-ahead ]
│
│  DESIGN  (replicate sub-orchestrator, invoked inline — shared context)
├─ 6  design-foundations   [SKILL] → design-foundation.json + design.md (frozen site-wide brief)
├─ 7  creating-themes      [SKILL] → theme.json · parts skeleton · base templates · style.css · self-hosted fonts
├─ 8  page clustering      [tool]  → cluster-map.json (pages grouped by layout signature; 1 representative each)
├─ 9  section extraction   [tool]  → specs/<rep>/section-<n>-<type>.md (computed styles · interaction model · media URLs · brightness · motion)
├─ 10 BUILD (fan-out)      [SKILL × K subagents]  generating-patterns: one builder per cluster representative
│                                   → layout skeletons as strings (concurrency-capped ~4–6; checkpointed by cluster-group)
├─ 11 assemble        [tool+SKILL] deterministic compose-instantiate per non-representative page
│                                   → compose-page-blocks SKILL for misfits only · dynamic block-header → templates + parts + post_content
├─ 12 validate-artifacts   [gate]  escaping (esc_*) · injection allowlist · provenance (text ⊆ spec) · drift · no remote URLs · no placeholders
├─ 13 install + import     [tool]  clean Studio site on full re-run · theme + WXR + products.csv · set front page
└─ 14 visual-QA loop       [SKILL] design-qa: replica desktop+mobile · responsive@390 (HARD gate) + qualitative · A/B/C · fix via editing-themes · ≤3 iters → run-report.json
```

The whole run is bounded by a **budget guard** (`checkBudget` in `src/lib/replicate/budget-guard.ts`) — configurable subagent/cluster/elapsed ceiling → pause-and-ask. The final deliverable is `run-report.json` + the replica URL (`buildRunReport` in `src/lib/replicate/run-report.ts`).

---

## Step-by-step workflow

### Step 1 — Detect & discover

1. Ask for the URL if not already provided.
2. Call `liberate_detect` to identify the platform.
3. Call `liberate_discover` to inventory the site. Show the counts and **platform features** to the operator.
   - `platformFeatures` flags: stores, bookings, forms, members areas, scheduling, forums, events.
   - Features marked `transferable: true` (e.g. stores) are handled during extraction.
   - Features marked `transferable: false` include a `wpRecommendation` (suggested WP plugin).
   - Narrate: "Detected Wix · 47 pages · 3 archetypes · 12 products · store (WooCommerce) · forms (WPForms recommended)."

### Step 2 — Extract

Call `liberate_extract` with an appropriate `outputDir`. Narrate per-URL progress.

**0 pages:** "No extractable pages found at `<url>`. The site may be behind auth or bot-protection — try CDP/admin extraction (`/diagnose`)." Stop.

### Step 3 — Media dedup + upload

Media references are deduped and uploaded to the WP media library. Uploaded URLs are the canonical media references used everywhere downstream (specs, templates, `post_content`).

### Step 4 — Capture

Runs automatically during or after extract: desktop+mobile screenshots, `palette.json` / `typography.json` / `breakpoints.json`, and `html/<slug>.html` per URL. Clustering in step 8 runs off the already-saved `html/<slug>.html` — no re-navigation.

Default concurrency: 6. Configure via `--screenshots-concurrency N` or `--concurrency N`.

### Step 5 — Products → CSV

If products were extracted, compile `products.jsonl` → `products.csv` (WooCommerce import format). Report: "Also extracted N products → products.csv."

### Confirmation checkpoint

After discovery (step 1), pause and show:
- Inventory: pages · estimated clusters · products
- Estimated scope, cost, and time
- Ask to proceed before the long design phase

This mirrors the existing `liberate` confirm step and complements the mid-run budget guard.

### Step 6 — Design foundations

Invoke `design-foundations` inline (shared context). Reads tokens, scaffold, representative HTML, and screenshots → emits `design-foundation.json` + `design.md` (frozen brief — only QA iteration 3 may amend, which invalidates the theme and all built clusters and re-enters this step).

### Step 7 — Create theme

Invoke `creating-themes` inline. Reads `design-foundation.json` + `design.md` → emits `theme.json`, `style.css`, `functions.php`, parts skeleton, base templates, self-hosted fonts. Header/footer come from the existing dynamic block-header + captured footer spec.

### Step 8 — Page clustering

Call `liberate_cluster_pages`. Computes layout signatures off the saved `html/<slug>.html` (ordered section-type sequence + structural attrs). Pages with identical signatures join one cluster. The representative is the cluster member with the richest structure. Emits `cluster-map.json`.

**Content model:**
- **Pages** (homepage + content pages) → section-by-section reconstruction (steps 8–11) into reusable layout.
- **Posts** → `single.html` + blog/archive template + Query Loop. Imported post content renders through the template.
- **Products** → `single-product.html` + `archive-product.html` + WooCommerce. No per-product reconstruction.

### Step 9 — Section extraction

Call `liberate_section_extract` on each cluster representative. Full detail: `specs/<rep>/section-<n>-<type>.md` (computed styles, interaction model, uploaded media URLs, brightness, motion, divider/gradient flags). Browser-based; runs only on representatives.

**Per-cluster readiness check before dispatch:** rep specs complete (interaction model set, computed styles present, media local-pathed, brightness recorded). Incomplete → fix spec, don't dispatch.

### Step 10 — Build (fan-out)

Fan out one `generating-patterns` builder subagent per cluster representative (concurrency-capped ~4–6). Builders:
- Receive shared artifacts **by path** (`design.md`, theme slug, token snapshot, media URL map, their specs). Read-only on shared artifacts.
- Return a **structured JSON envelope**: `{ patterns: [{ slug, php }], sitewideFlags: [...], notes: [...] }`. A malformed return is a builder failure — never silent corruption.
- Emit **layout skeletons** (section-mapping templates with content slots), not finished per-page markup. Sitewide-shared sections (header, footer, CTA band) are promoted to registered WP patterns / template parts.

**Checkpointing by cluster-group:** the design phase processes clusters in groups with a compaction/handoff between groups (state in `session.json` + a short design-state summary) to bound orchestrator context. Crash mid-build resumes at the next unbuilt cluster (write-then-mark).

**On Codex/Gemini:** step 10 runs sequentially (no fan-out). All other steps are identical.

**Builder subagent failure:** retry once → fall back to sequential for that cluster → persist subagent input + returned markup to `theme/debug/cluster-<n>.json`, log to `theme/notes.md`.

### Step 11 — Assemble

For each non-representative page, call `liberate_compose_instantiate` (deterministic): fills the cluster's layout skeleton with that page's captured content + uploaded media → `post_content`. Building cost scales with **K clusters, not N pages**.

Invoke `compose-page-blocks` skill **only** for misfits (unmatched slots, extra/missing sections — those that don't cleanly map). A post-compose sanity check (all slots filled, section count matches the cluster signature) fails loud — never ships empty/broken sections silently.

### Step 12 — Validate artifacts (gate)

Call `liberate_validate_artifacts` (ports `validate-artifacts.js`, hardened). This is the **security trust boundary** and must pass before install:

- **Escaping:** asserts `esc_html` / `esc_attr` / `esc_url` on all source-derived text.
- **Injection allowlist:** rejects raw `<?php` / `<script>` / `on*=` handlers (PHP injection + stored XSS defense, including builder prompt-injection via source content).
- **Provenance:** emitted text ⊆ spec captured text (flags invented prose, never ships it silently).
- **Drift:** spec↔pattern consistency.
- **No remote URLs, no unresolved `{{placeholders}}`, block-comment-only markup.**

Gate fail → fix source, rerun — never install a failing theme. Log to `run-report.json`.

### Step 13 — Install + import

Clean Studio site on full re-run (or wipe replica content); resume keeps the existing site. Install theme, import WXR + `products.csv`, set front page. Returns replica URL.

### Step 14 — Visual QA loop

Invoke `design-qa` inline. Captures replica desktop+mobile screenshots, compares against source screenshots.

**Gates (in order):**
1. **Responsiveness** (HARD): no horizontal overflow + sections reflow at 390px (automated Playwright check). Must pass to ship.
2. **Qualitative:** vision review across ≤3 iterations per archetype representative — classify A/B/C, emit fix directives, invoke `editing-themes` / `editing-blocks` / `creating-blocks` to resolve. Pixel-diff is a signal, **not** the gate.

After ≤3 iterations (or on gate failure), emit `run-report.json` + replica URL. Iteration 3 `design.md` amendment invalidates theme + all built clusters and re-enters step 6.

---

## Operator interaction states

| Stage | State | Response |
|---|---|---|
| extraction | 0 pages | Stop + "No extractable pages found at `<url>`. Try CDP/admin extraction (`/diagnose`)." |
| extraction | adapter fail | Log + pointer to `/diagnose` |
| design | no page archetype | Templates-only run (posts + products render through base templates; no page reconstruction) |
| design | gate fail | Don't install — report to `run-report.json` with problem + cause + fix |
| design | some clusters failed | Built-with-gaps — list gaps in `run-report.json`; install what passed |
| budget guard | ceiling hit | "Built N clusters / dispatched M subagents (~est. $X, Y min). Continue · stop and report what's done · raise the ceiling?" |

Progress is the agent's own narration — no Ink TUI in agent mode. The headless extraction CLI keeps its existing Ink surfaces (`discover.tsx`, `screenshot.tsx`).

---

## `run-report.json` — verdict-first

Read top-down to answer "is this good?":

1. `verdict` — overall ✓ / ⚠ / ✗ + per-archetype.
2. `summary` — clusters built/failed · pages composed/misfit · responsive pass/fail · provenance flags · fallback/low-confidence pages · est. cost/usage.
3. `details[]` — per-cluster + per-page status, gate results, QA notes, known gaps.

---

## Resuming

If the user asks to resume (e.g. "resume", "continue", "it crashed"):

1. Ask for the URL if not provided — `outputDir` is derived from it.
2. Call `liberate_extract` with `resume: true` for extraction; `session.json` tracks design stage + per-cluster build status so the design phase resumes at the next unbuilt cluster.
3. If extraction was already complete (`.discovery-complete` exists), skip straight to reporting and offer to import or re-run design.

The `resume` flag causes extraction to:
- Skip platform detection/discovery if a completed WXR already exists
- Skip URLs already successfully processed (tracked in `extraction-log.jsonl`)
- Rebuild media dedup hashes from existing files
- Append to the existing WXR rather than starting fresh

---

## Output-quality contract

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
