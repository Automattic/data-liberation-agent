# Data Liberation — How It Works

> A conceptual walkthrough of the `data-liberation-agent` pipeline: what happens, in what order, which steps are deterministic code vs. AI judgment, and the two reconstruction pathways. Written for understanding the *shape* of the system, not the code.

---

## The one-paragraph mental model

Data Liberation takes a live site on a **closed platform** (Wix, Squarespace, Shopify, Webflow, GoDaddy, Hostinger, HubSpot, Weebly) and turns it into a **WordPress site you own** — content as importable WXR, products as WooCommerce CSV, and the *look* of the site rebuilt as a WordPress block theme. It does this in two big movements: a **deterministic extraction** phase that faithfully pulls content, media, and design measurements out of the source (no AI, fully reproducible, resumable), and a **hybrid reconstruction** phase that rebuilds the site's pages — deterministic code emits the structure and the AI closes the visual-parity gap, with **measured gates** keeping both honest. Between the two sits a single operator decision — *which* reconstruct path to take — and it is asked **early**, right after the cheap discovery step and **before** the expensive extraction, so the choice is made while the operator is still at the keyboard.

The guiding principle the whole system is built around: **never lose or invent source content.** Text is carried verbatim or placeholdered — never paraphrased — and a provenance gate hard-fails anything that doesn't trace back to what was actually captured.

---

## The two phases and the central boundary

```
┌─────────────────────────── PHASE 1: EXTRACTION ───────────────────────────┐
│  100% DETERMINISTIC — reproducible, resumable, no AI in the loop           │
│  Detect → Discover                                                         │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓
        ╔══════════════ PATH CHECKPOINT (operator, MANDATORY) ═══════════════╗
        ║  Fires AFTER discovery, BEFORE extraction — a non-skippable hard    ║
        ║  stop. Show inventory + recommendation, AskUserQuestion:            ║
        ║  blocks+products vs theme replication. Never auto-select.           ║
        ║  The operator's answer is the ONLY thing that authorizes the rest.  ║
        ╚════════════════════════════════════════════════════════════════════╝
                                    ↓
┌──────────────── PHASE 1 (cont.): EXTRACTION — after the path is chosen ────┐
│  100% DETERMINISTIC — reproducible, resumable, no AI in the loop           │
│  Extract → Media → Capture                                                 │
│  Produces: output.wxr, products.csv, media/, screenshots, design tokens,  │
│            per-section specs   (capture is SHARED by both paths)           │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌────────────────────────── PHASE 2: RECONSTRUCTION ────────────────────────┐
│  HYBRID — deterministic emitter + AI polish, behind measured gates        │
│  Dispatch the chosen sub-skill inline:                                     │
│  Design foundation → Theme → Cluster → Section specs → BUILD (AI fan-out) │
│  → Assemble/reconstruct → Validate (GATE) → Install → Visual-QA loop      │
│  Produces: a running WordPress block theme that matches the source        │
└────────────────────────────────────────────────────────────────────────────┘
```

**The single most important idea in the whole system is the deterministic/AI boundary.** Everything that *can* be done by deterministic code *is*. AI is reserved for the parts that genuinely need judgment or "eyes on the rendered result":

- **Deterministic** = anything where there's a correct answer derivable from the source: what platform this is, which URLs exist, what the page text/media/prices are, what colors/fonts/breakpoints the CSS uses, where the section boundaries fall, how to emit a column layout into block markup, whether emitted text traces back to the source, whether the page reflows on mobile.
- **AI-driven** = anything requiring interpretation or visual comparison: inferring a coherent *design system* from raw measurements, building a block pattern that captures a section's intent, looking at "source vs. built" side-by-side and iterating until they match, deciding how to rebuild a genuinely bespoke section.

The system is best described as **"deterministic emitter + AI polish."** Code gets the structure and content right; AI closes the visual gap; gates verify both.

---

## Three ways to invoke it

All three share the same `src/lib/` and `src/adapters/` core.

1. **Agent-first `/liberate` skill (the primary runtime).** A Claude Code / Codex agent runs the pipeline end-to-end. `/liberate` is the **single front door**: it detects + discovers, then **stops at a mandatory path checkpoint** to ask the operator which reconstruct path to take, *then* captures the site once (the rest of Phase 1) and **dispatches the matching sub-skill inline** (shared context). The path question fires before extraction so the operator chooses while still present. This is the intended main path — *AI agents are the runtime*, and the AI stages ship as **skills**, not as model calls baked into `src/`.
2. **CLI (`data-liberation <url>`).** Headless, CI-friendly. Runs the deterministic extraction phase **only** (Phase 1 capture; screenshots by default, `--no-screenshots` to skip). The reconstruct (Phase 2 — blocks or theme) is agent-only; there is no headless rebuild.
3. **MCP server.** Exposes the deterministic operations as `liberate_*` tools that any MCP client (or the skills) call. *Caveat:* the MCP server is one long-lived process — editing `src/` does not hot-reload it, so a newly-added tool (e.g. `liberate_reconstruct_pages_carry`) is missing until the server restarts.

> **Two reconstruct paths.** Right after discovery (and before extraction), `/liberate` branches at a mandatory operator checkpoint to one of two reconstruct sub-skills:
> - **`replicate-with-blocks`** — the block path (editable core blocks + WooCommerce).
> - **`replicate-theme`** — the carry-and-scope path (high-fidelity, non-block-editable). Its code and artifacts are namespaced `carry`: `output-carry.wxr`, the `<site>-carry` theme, `liberate_reconstruct_pages_carry`.
>
> Both sub-skills are `disable-model-invocation: true` — `/liberate` dispatches them inline; users don't invoke them directly.

---

# PHASE 1 — Extraction (deterministic)

This phase is a clean, reproducible state machine. It can be killed and resumed at any point. Nothing here calls an LLM.

The run is tracked by an `ImportSession` stage machine that moves through:

```
initial → discovering → [PATH CHECKPOINT] → extracting → downloading-media → screenshotting → finalizing → complete
                                                                                    ↘ error (from any stage)
```

The one human-in-the-loop gate in this otherwise-deterministic phase sits **between `discovering` and `extracting`**: `/liberate` stops and asks the operator which reconstruct path to take before any extraction runs (see [The path checkpoint](#the-path-checkpoint-operator-decision)). The headless CLI has no such gate — it just runs the deterministic stages straight through.

### Step 1 — Detect (`liberate_detect`)
Identify which closed platform the URL belongs to. Done by a **layered fingerprint**, in confidence order:
1. **URL patterns** (e.g. `*.wixsite.com`, `*.myshopify.com`) — highest confidence.
2. **HTTP headers** (e.g. `X-Wix-Request-Id`, `X-Powered-By: Webflow`).
3. **HTML source markers** (CDN hostnames like `wixstatic.com`, platform JS globals).
4. **Path probes** (fallback HEAD requests to platform-specific admin paths).

Detection is **domain-level + fingerprint**, deliberately *not* path-based. Output: `{ platform, confidence, signals }`.

### Step 2 — Discover (`liberate_discover`)
Build the inventory: walk the sitemap, read navigation, collect every URL and classify it. The **URL classifier** assigns each URL one of: `homepage`, `post`, `product`, `gallery`, `event`, `page`. Output is a full URL list with per-type counts, the site's nav structure, and site metadata (title, tagline, language).

> **Discovery is where Phase 1 pauses for the operator.** Detect + discover are cheap and already yield everything the path recommendation needs (platform · page/product counts · features), so the **path checkpoint fires right here** — before the expensive Extract → Media → Capture run. See [The path checkpoint](#the-path-checkpoint-operator-decision). Steps 3–5 below only run *after* the operator has chosen.

### Step 3 — Extract (`liberate_extract`)
The heart of extraction. For each URL, the matching **platform adapter** fetches and parses the page into structured content (title, slug, body, excerpt, date, media references, categories/tags, author, detected type). This runs through a **shared extraction loop** that handles:

- **Slug claiming** — derive the WordPress `post_name` from the URL; collision-suffix duplicates (`-2`, `-3`).
- **Concurrent fetch, sequential write** — pages are fetched in parallel batches, but written to the WXR sequentially for consistency. An adaptive tuner adjusts page delay and media concurrency from observed timing.
- **Stratified limiting** — when `--limit N` is set, it round-robins across content types so products don't starve out pages, and pins primary-nav targets in so the reconstructed menu doesn't break.
- **Streaming output** — content can be flushed per-URL so the WXR doesn't balloon in memory.

The output is assembled by the **WXR builder** targeting **WXR 1.2** spec compliance: pages, posts, products, attachments, nav menu items, categories, tags, authors.

**Platform-specific note — Shopify has two tiers.** Without an admin token, products come from the public JSON API. *With* an admin token, it uses the **Shopify Admin GraphQL API** (pinned to `2025-04`) for richer product data — resumable via stored cursors, idempotent on product handles, with a fallback to the JSON path on any GraphQL failure.

### Step 4 — Media (download + dedup)
Every referenced image/PDF is downloaded, **hash-deduplicated**, and saved locally. Filename collisions get numeric suffixes (not hashes). Each asset's status is tracked in a media store (`success`/`error`/`ignored`) with a retry cap, so media survives mid-run crashes and resumes cleanly. Later phases rewrite source-CDN URLs to the local/WP-library copies through a CDN→local map.

### Step 5 — Capture (`liberate_screenshot`) — *this is what makes design rebuild possible*
This phase is the bridge from "content" to "design." For each page it:

- Renders the page in a real browser (Playwright) at **desktop (1440×900) and mobile** viewports, after **dismissing overlays** (cookie/consent banners) and triggering lazy-load.
- Saves a full-page screenshot plus a **post-scroll** capture (`<slug>.scrolled.png`) — short pages skip the scrolled shot silently.
- Optionally saves the **rendered HTML** to `html/<slug>.html`.
- Runs `extractFull` on the settled desktop page to produce a **`SectionSpec[]`** — the page broken into sections, each with its computed styles, geometry, interaction model (hero/cover, columns, gallery, review-grid, price-list, product-card-row, …), brightness, and media URLs. These are cached per-URL under `sections/<slug>.json` (capture-once, schema-versioned).
- Aggregates **site-wide design tokens** across all pages: `palette.json` (dominant colors), `typography.json` (font metrics per selector), `breakpoints.json` (the `@media` widths the site actually uses), plus CSS variables.

The join from content back to design is **filesystem-only**, via `screenshots/manifest.json` mapping each URL → its files. Nothing is injected into the WXR — downstream tooling correlates by URL.

Capture defaults: concurrency 6, browser restarts every 100 URLs to bound memory, and **same-origin enforcement** — every captured URL must share the origin of the entry URL.

> **Everything above is deterministic.** Given the same source site, you get the same WXR, the same media, the same screenshots, the same section specs. This is the reproducible foundation the AI phase builds on.

---

# PHASE 2 — Reconstruction (hybrid: deterministic emitter + AI polish)

Now the captured artifacts become a living WordPress site. This is where AI enters — but tightly fenced by measured gates. The **path that gets here was already chosen** back at the checkpoint (which fired between discovery and extraction); Phase 2 proper begins when `/liberate` **dispatches the chosen sub-skill inline** after capture.

### The path checkpoint (operator decision)

> **This checkpoint fires after discovery and BEFORE extraction — it is a mandatory, non-skippable hard stop, not an after-capture confirmation.** It's placed early on purpose: discovery is cheap and already yields the inventory the recommendation needs, so the operator commits the path *before* the long extraction runs — while they still have attention. (Earlier versions asked this after capture; that was wrong — it either wasted the extraction or fired once the operator had walked away.)

The front door shows the discovery inventory + a scope/cost estimate + a **platform-informed recommendation**, then asks the operator (via `AskUserQuestion`) to pick one of **two reconstruct paths**. The recommendation is a hint *inside* the question (marked `(Recommended)`), **never** an auto-selection — no matter how strong the platform signal, `/liberate` does not choose on the operator's behalf. *The operator's answer is the sole go-ahead* — it replaces the old proceed/confirm gate, and starting extraction without it is a defect. Only after the operator chooses does `/liberate` run the rest of Phase 1 (extract → media → capture → products) and then dispatch the matching sub-skill inline (shared context); each sub-skill reads `output/<site>/` from disk and owns its own reconstruct → install → QA → report (plus its own budget guard and `run-report*.json`).

| Operator picks | Dispatches | What you get | Products |
|---|---|---|---|
| **Migrate content into blocks + products** | **`replicate-with-blocks`** (Pathway A) | Editable WordPress core blocks + navigation + WooCommerce; best launchpad for a redesign | Product **pages reconstructed** |
| **Theme replication** | **`replicate-theme`** (Pathway B) | Highest-fidelity carry-and-scope replica; raw-HTML-editable, **not** block-editable | Product **data** imported; product pages fall back to default WooCommerce (no carried replica) |

*Recommendation heuristic:* a store with many products → lean blocks (1); a fixed-layout Wix marketing site with no store where pixel-fidelity matters → lean theme (2). The choice is **reversible at zero cost**: capture is idempotent, so re-running `/liberate <url>` on an already-captured site skips straight back to this checkpoint — you can try the other path later without re-capturing.

## Pathway A — Block reconstruction (`replicate-with-blocks`)

**Goal:** rebuild the site as *editable* WordPress core blocks (columns, groups, cover, gallery, …) styled by theme tokens — so the result is a real, maintainable WordPress site, not a frozen snapshot. Dispatched by `/liberate`, or run standalone to re-theme an already-extracted site. The steps below all live inside `replicate-with-blocks` (a seven-step flow, broken out finer here); it delegates judgment to the sub-skills (`design-foundations`, `creating-themes`, `generating-patterns`, `design-qa`) and determinism to MCP tools.

### Step 6 — Design foundation  🤖 AI
Read the captured palette, typography, and breakpoints and **infer a coherent design system** — semantic color roles, type scale, spacing — written to `design-foundation.json` + a human-readable `design.md`. This is the one place raw measurements become *design intent* (e.g. "this green is the brand primary," not just "this hex appears 40 times"). The foundation is then **frozen** as a site-wide brief; later stages defer to it rather than re-deriving styling per page.

*Why AI here:* clustering colors and naming roles is interpretation, not lookup. Raw measurements alone conflate (e.g. several near-greens that are really one brand color).

### Step 7 — Create theme  ⚙️ Deterministic
Map the frozen foundation into a scaffolded block theme: `theme.json`, `style.css`, `functions.php`, template-part skeletons, base templates, self-hosted fonts. This is a mechanical translation from foundation → theme files, audited by a `theme.json` lint gate.

### Step 8 — Cluster pages (`liberate_cluster_pages`)  ⚙️ Deterministic
Group pages that share a layout. Each page has a **layout signature** (its ordered sequence of section types + structural attributes); pages with **identical signatures** join one cluster. This is exact-match, not fuzzy. The point: build each distinct layout once, then apply it to all its members. Output: `cluster-map.json`.

### Step 9 — Section extraction (`liberate_section_extract`)  ⚙️ Deterministic (browser-eval)
For each cluster's **representative** page, produce detailed per-section specs (`specs/<rep>/section-<n>-<type>.md`) from computed styles + geometry: the interaction model, verbatim text, media URLs, background/brightness. These spec files are the **contract** between extraction and the AI builders — the builders are only allowed to use what's in them.

### Step 10 — BUILD: pattern generation (`generating-patterns`)  🤖 AI, fanned out
For each cluster representative, an AI **builder subagent** reads the design brief + section specs + a catalog of section→block templates, and emits a **WordPress block pattern** — layout skeleton with content slots filled from the spec. Builders run **in parallel** (concurrency-capped, ~4–6 on Claude Code; sequential on other runtimes), each in its own isolated workspace so file writes don't collide, returning a structured JSON envelope of patterns + flags + notes. Progress is checkpointed by cluster-group so a crash resumes at the next unbuilt cluster.

**The cardinal rule, enforced here:** all visible prose is **source-verbatim or placeholdered, never paraphrased.** Paraphrased body copy hard-fails the validation gate downstream.

*Why AI here:* mapping a captured section to the right combination of blocks that expresses its intent is design judgment. The deterministic emitter (next step) gets structure right but a builder produces the richer, intentional pattern.

### Step 11 — Assemble / reconstruct pages (`liberate_reconstruct_pages`)  ⚙️ Deterministic
This is the deterministic **emitter** at the core of the hybrid. For **every** content page (not just representatives), it reads that page's **own** section specs and renders them to core blocks via per-interaction-model renderers (`renderCover`, `renderColumns`, `renderReviewGrid`, `renderProductCardRow`, …). It fills content slots with **verbatim** spec text, applies **design-foundation tokens** (color slugs and font families — never inlined hex/px, so the editor's canonicalization doesn't fight it), installs the page's media into the WP library, and rewrites image URLs through the media map. Output: `patterns/page-<slug>.php` + `templates/page-<slug>.html`.

A built-in **content-loss guard**: if a structured render would drop content or coverage falls below a text floor, that section falls back to emitting sanitized **source HTML as a `core/html` island** instead — faithful but not block-editable — and flags itself.

> The full-width vs. constrained layout decision **defers to the source**: a section carrying a large image spanning ≥92% of the viewport marks the page full-bleed; otherwise constrained.

### Step 12 — Validate (`liberate_validate_artifacts`)  ⚙️ Deterministic — **HARD GATE**
The trust boundary. Nothing installs unless it passes. It asserts:
- **Escaping** — all source-derived text is properly escaped (`esc_html`/`esc_attr`/`esc_url`).
- **No injection** — no raw `<?php`, `<script>`, or `on*=` handlers (PHP-injection + XSS defense).
- **Provenance** — every emitted text string is a **subset of captured source text**. This is what catches *invented* prose — the anti-hallucination gate.
- **No remote URLs** — every asset reference is a WP-library or theme asset, nothing left pointing at the source CDN.
- **No unresolved placeholders**, block-comment-valid markup, no design drift.

A validation backstop also exists as a **block-markup oracle** (the real WordPress block parser) confirming the markup round-trips.

### Step 13 — Install (`liberate_install_theme`, `liberate_import`, `liberate_preview`)  ⚙️ Deterministic
Write the theme into a local WordPress (Studio / Playground), import the WXR content and products CSV, activate the theme, set the front page, flush rewrites. Now there's a running site to look at.

> *Operational gotcha:* a media-heavy WXR can trip Studio's ~120s import-silence timeout (looks like a "DB connection" error). The fix is a per-item heartbeat in the importer; some flows slim attachments out of the WXR and install media separately.

### Step 14 — Visual-QA loop (`design-qa`)  🤖 AI + ⚙️ measured gates
The closing loop that actually makes the result *look right*. It screenshots the rebuilt site (desktop + mobile) and runs three layers:

1. **Responsiveness gate (HARD, deterministic).** No horizontal overflow, sections reflow at 390px, nothing stuck past the fold. Fail = stop.
2. **Visual-parity gate (HARD, *measured* — not vibes).** Per-section parity records: background color delta (ΔE2000, threshold ~10), column-count match, media present, "is this an unstyled island where there should be a styled layout." **Every record carries the sampled evidence backing it** — spec-captured values are ground truth; vision is fallback only. These records produce the run's verdict in `run-report.json` (✓ / ⚠ / ✗).
3. **Accessibility checks** (contrast, alt text) — warn, don't block.

When a section diverges, it climbs an **escalation ladder**, cheapest fix first:

| Rung | What it does | Det/AI |
|------|--------------|--------|
| **R1** | CSS/theme tweak (band color, spacing) via `editing-themes` | 🤖 small |
| **R2** | Rebuild the block markup from spec (restore flattened columns/grids) via `editing-blocks` | 🤖 |
| **R3** | Re-extract the section spec (the spec itself was wrong — "Class A") | ⚙️ |
| **R4a** | AI canonical-block rebuild from richer inputs (source HTML, styled HTML, screenshots, spec, tokens) via `rebuild-section` — must pass 4 gates: block oracle, canonicalization round-trip, re-measured parity = match, no content loss | 🤖 |
| **R4b** | Deterministic **styled-island floor**: carry verbatim source HTML as a `core/html` island with scoped CSS — pixel-faithful but not block-editable. The last resort for genuinely bespoke sections | ⚙️ |

After ~5 rungs on a section, a **circuit-breaker** stops and asks the operator (raise budget / accept the divergence / abandon). Divergences get classified — **Class A** (spec wrong), **Class B** (template dropped info), **Class C** (a real WordPress rendering constraint that simply can't be matched, which a human accepts). The system refuses to silently ship a flattened result as if it were a match — a "known gap" must be explicitly accepted.

---

## Pathway B — Carry-and-scope (`replicate-theme`)

**Goal:** maximum *visual* fidelity, accepting that the result is **not** block-editable. Dispatched by `/liberate` when the operator picks "theme replication." It does **not** capture — it has a strict **entry contract**: capture already happened in `/liberate`, so if the carry inputs are missing it STOPs and tells the operator to run `/liberate <url>` first (a capture gap to surface, never silently re-run).

Instead of re-emitting the page as core blocks, the carry path **carries the source's rendered HTML near-verbatim** into `core/html` islands and **scopes the source's own CSS** under per-site / per-page body-class wrappers. Conceptually:

1. **Resolve run + build page list** (⚙️) — read `screenshots/manifest.json` + `output.wxr` to enumerate every page **and post** (`{slug, sourceUrl, title, isHome?, postType?, htmlSlug?}`); join posts to their captured `post--<name>.html` files.
2. **Provision the Studio site** (⚙️) — `liberate_preview` creates a Studio site named plainly `<site>` (the `-carry` suffix is on the *theme*, not the site). Provisions from a **media-free slimmed WXR** (drop `attachment` items) to dodge Studio's ~120s import-silence timeout; media is installed separately next.
3. **Carry-and-scope reconstruct** (⚙️, `liberate_reconstruct_pages_carry`) — for each page: load `html/<slug>.html`, `collectCss`, split header/main/footer, carry each region verbatim into a `core/html` island, **scope the CSS** (chrome → site-wide `body.lib-carry-site`; main → per-page `body.lib-carry-site.lib-carry-page-<slug>`), **tree-shake** against the carried DOM, **rewrite internal links** to local permalinks (shared `buildPageLinkMap`), and **self-host media** — install the run's assets and rewrite carried `<img>`/`srcset`/`url()` to the local WP library (shared `installRunMediaMap`). Writes a **real FSE block theme** (`wp_is_block_theme()` → true) to `<site>-carry/` with `parts/header.html`, `parts/footer.html`, `templates/` (incl. `single.html` for posts), per-page CSS, and a `functions.php` with `is_front_page()`/`is_page()`/`is_single()` body-class + enqueue conditions.
4. **Build `output-carry.wxr`** (⚙️) — copy the *full* `output.wxr` and, per page/post, replace only that item's `<content:encoded>` with its island (matched by `<wp:post_name>`), via a small auditable per-item transform (not a greedy regex). Verify the item count + XML round-trip.
5. **Content swap + activate** (⚙️) — don't re-import (the importer skips existing GUIDs); instead `studio wp eval-file` a script that finds each post by `post_name` across `['page','post']` and `wp_update_post`s its content. Activate the carry theme, set the static front page, flush rewrites.
6. **Parity comparison** (🤖 + measured, `liberate_compare`) — screenshot the carry site (desktop + mobile) and compare against the source screenshots, emitting `run-report-carry.json`. Then the **honest visual pass**: crop source vs built for the 2–3 worst pages, read both, and itemize the real gaps.

**What the carry path handles cleanly:** media is self-hosted (no source-CDN dependency); internal links are rewritten to local permalinks; **posts are carried** (scoped via `is_single()` through a shared `single.html`); it produces a genuine FSE block theme (only the page/post *body* is the single `core/html` island); classic-Wix mobile DOM is carried in a viewport-isolated iframe and Wix pro-galleries reflow to a mobile grid.

**Where the carry path still struggles (state these in the report, don't let them masquerade as success):**
- **Missing Wix section background-fills** — *the dominant remaining gap on the latest Wix eval* (corneliusholmes, 2026-06-04). Section-level background colors/gradients that Wix applies via JS or non-carried wrappers don't make it into the scoped CSS, so bands that should be filled render transparent/white. This now outweighs scale-offset as the top carry fidelity issue.
- **Wix scale offset** — previously the dominant gap, now **substantially mitigated**. Carried Wix layouts render *larger* than the source at the same width (Wix's responsive scaling is JS-driven and absent in static carry), pushing content below the fold. Largely closed by `:where()` scoping (desktop ~0.72→0.88) and replicating the source's body classes to unlock reflow (mobile ~0.62→0.73).
- **Dynamic behavior dropped** — scripts stripped, so carousels/menus/scroll effects don't animate.
- **CSS-file `url()` backgrounds** rewrite only on exact map-key matches; relative/query-string `url()`s can still point at the source.
- **Non-semantic chrome** — sites without `<header>`/`<footer>` tags (many Wix/Squarespace) get no separate header/footer parts; the whole body rides in one island.

### Choosing a pathway

| | **Block path** (`replicate-with-blocks`) | **Carry path** (`replicate-theme`) |
|---|---|---|
| Output | Editable WP core blocks + theme tokens | `core/html` islands + scoped source CSS (real FSE theme shell) |
| Editable in WP editor? | **Yes** | No (raw-HTML editable only) |
| Visual fidelity | High, *responsive-guaranteed* | Very high on desktop, but inherits source quirks (missing Wix section bg-fills; scale-offset, now mostly mitigated) |
| Responsiveness | Hard gate guarantees mobile reflow | Whatever the source's static/scoped CSS does |
| Products | Product pages reconstructed | Product **data** only; pages fall back to default WooCommerce |
| Report | `run-report.json` (verdict-first) | `run-report-carry.json` (parity-compare shaped) |
| Best for | A real WordPress site you'll keep editing | Pixel-faithful replica / A/B comparison against the source |
| Det/AI split | Deterministic emit + AI polish, gated | Deterministic carry + AI comparison |

**Honest finding:** the carry-vs-block gap is site-dependent. On some dynamic (Wix/JS) sites the pixel A/B is a **tie within capture noise** — re-capturing the *same* built site can move the overall score ±0.02 and swing individual dynamic pages (blog feeds, galleries) 0.10–0.12 from lazy-load/animation timing, a spread that can *exceed* the gap. But it is **not always a tie**: on the latest Wix eval (corneliusholmes, 2026-06-04) the carry path beat blocks decisively — homepage **0.995 vs 0.26**, desktop average **0.969** — a margin far outside capture noise. So report the carry path's wins as **correctness wins** (self-hosted media, local links, posts rendering — each verified visually/by HTTP) separately from **pixel-score wins** (sometimes within noise, sometimes a clear lead). It serves as a **fidelity ceiling / comparison baseline** that calibrates how good the block path's rebuild is.

---

## Resume & state — why a run can always be killed and restarted

Extraction is built to survive crashes. Several files cooperate, all written under a single extraction lockfile:

- **`extraction-log.jsonl`** — append-only, the source of truth for "did we already process this URL."
- **`session.json`** — the stage, original options, per-entity counts, and adapter pagination cursors. Single-writer, atomic rename; a corrupt file is preserved as `.corrupt.<ts>`, never silently deleted.
- **`media-stubs.json`** — per-asset status with a retry cap.
- **`products.jsonl`** — streaming product output that *appends* on resume.

Plus a per-URL **`sections/<slug>.json`** cache (capture-once, schema-versioned) so the expensive browser section-extract doesn't re-run on resume — the reconstruction phase reads this cache and only falls back to a live extract on a miss.

This is why the whole thing is restartable: the deterministic phase records exactly what it has done, and the reconstruction phase checkpoints by cluster-group.

---

## The fidelity contract (the thing it's most opinionated about)

Three mechanisms, layered, enforce "faithful, nothing lost, nothing invented":

1. **Verbatim-or-placeholder** — builders may never paraphrase source prose.
2. **Provenance gate** — emitted text must be a subset of captured source text; invented prose hard-fails before install.
3. **Measured parity + content-coverage** — a section that drops content or fails a *measured* parity check is caught, and either escalated up the ladder or dropped to a faithful (if non-editable) styled island, with the gap explicitly recorded — never silently flattened and shipped as a match.

This is a deliberate stance: the system would rather *show you an honest gap* than quietly degrade fidelity.

---

## Quick reference — artifacts in `output/<site>/`

| File / dir | Phase | What it is |
|---|---|---|
| `output.wxr` | Extract | WordPress import file (pages/posts/products/media/menus) |
| `products.csv` / `products.jsonl` | Extract | WooCommerce product import |
| `media/` + `media-stubs.json` | Media | Downloaded assets + per-asset status |
| `extraction-log.jsonl`, `session.json` | Resume | What's processed + run state |
| `redirect-map.json` | Extract | Old URL → new slug mapping |
| `screenshots/{desktop,mobile}/*.png` | Capture | Full-page + scrolled renders |
| `screenshots/manifest.json` | Capture | URL → files join (the only content↔design link) |
| `html/<slug>.html` | Capture | Rendered source HTML (feeds the carry path + fallbacks) |
| `palette.json`, `typography.json`, `breakpoints.json` | Capture | Aggregated design tokens |
| `sections/<slug>.json` | Capture | Cached per-page section specs |
| `design-foundation.json` + `design.md` | 🤖 Foundation | Inferred design system (frozen brief) — block path |
| `theme/` | Theme | The generated block theme (block path) |
| `<site>-carry` theme + `output-carry.wxr` | Theme | The carry-and-scope theme + content-swapped WXR (carry path) |
| `cluster-map.json` | Cluster | Pages grouped by layout signature |
| `specs/<rep>/section-*.md` | Section extract | Per-section contract for builders |
| `patterns/page-<slug>.php`, `templates/*.html` | Assemble | Reconstructed page markup |
| `run-report.json` (block) / `run-report-carry.json` (carry) | QA | Verdict + per-section parity records |

---

## Stage-at-a-glance: deterministic vs AI

| Stage | Tool / skill | Det / AI |
|---|---|---|
| Detect platform | `liberate_detect` | ⚙️ |
| Discover URLs | `liberate_discover` | ⚙️ |
| Extract content | `liberate_extract` | ⚙️ |
| Download media | (media install) | ⚙️ |
| Capture screenshots + specs + tokens | `liberate_screenshot` | ⚙️ |
| Infer design system | `design-foundations` | 🤖 |
| Scaffold theme | `creating-themes` | ⚙️ |
| Cluster pages | `liberate_cluster_pages` | ⚙️ |
| Extract section specs | `liberate_section_extract` | ⚙️ |
| Build patterns (fan-out) | `generating-patterns` | 🤖 |
| Reconstruct pages | `liberate_reconstruct_pages` | ⚙️ |
| Validate (gate) | `liberate_validate_artifacts` | ⚙️ |
| Install + import | `liberate_install_theme`, `liberate_import` | ⚙️ |
| Visual QA + escalation | `design-qa`, `match-page`, `match-section`, `rebuild-section` | 🤖 + measured ⚙️ |
| Carry-and-scope reconstruct | `liberate_reconstruct_pages_carry` | ⚙️ |
| Carry parity comparison | `liberate_compare` | 🤖 + measured ⚙️ |

---

## Skills and the design patterns they use

The AI side of the pipeline ships as **Claude Code skills**, and each skill is composed from reusable *skill-patterns* — behavioral techniques for grounding, critique, control, and composition (catalog: [skillpatterns.ai](https://skillpatterns.ai/)). Listing the patterns a skill uses is the fastest way to understand *how it thinks*, not just what it does. Below, **clear-fit** patterns (the mechanism is actually present in the SKILL.md) are listed per skill, grouped by role; plausible/partial ones are folded into the cross-cutting notes.

### Orchestrators (drive the whole flow)

#### `liberate`
*Front door: detect → discover, then a **mandatory path checkpoint** (before extraction) that dispatches a reconstruct sub-skill; capture (extract → media → capture → products) runs after the path is chosen.*

- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — detect → discover → **path checkpoint** → extract → media → capture → products → dispatch
- [Bounded option generation](https://skillpatterns.ai/patterns/bounded-option-generation/) — the checkpoint offers two distinct reconstruct paths with explicit trade-offs
- [Human in the loop](https://skillpatterns.ai/patterns/human-in-the-loop/) — the path checkpoint is a non-skippable hard stop fired *before* extraction (never auto-selected); "picking a path IS the go-ahead"; drafts-by-default import; ask before importing authors
- [Decision capture](https://skillpatterns.ai/patterns/decision-capture/) — shows inventory + scope/cost estimate + a platform-informed recommendation
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — dispatches `replicate-with-blocks` or `replicate-theme` inline (shared context)
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — capture stages are `liberate_*` MCP calls (`liberate_detect`/`_discover`/`_extract`/`_verify`)
- [Externalized working state](https://skillpatterns.ai/patterns/externalized-working-state/) — Step-0 idempotent check (`.discovery-complete` / `session.json` / `output.wxr`) skips re-capture; `resume:true`
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — always run `liberate_verify` after extraction (stale CDN URLs, failed pages, media gaps)
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — 0 pages → point to `/diagnose`; GraphQL→JSON fallback; capture-health fallback pages flagged
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — notable findings logged to `DISCOVERIES.md`
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — alt text carried verbatim, flagged for human fill, never AI-generated (provenance)
- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — per-platform setup (Squarespace CDP, Shopify two-tier admin, Webflow token, GoDaddy W+M, Wix)

#### `replicate-with-blocks`
*Block path (dispatched by `liberate`): spec → fan-out → assemble → validate → install → QA. Editable core blocks + WooCommerce.*

- [Role priming](https://skillpatterns.ai/patterns/role-priming/) — "you are a design sub-orchestrator"
- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — explicit 7-step flow
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — per-step sub-skill table (foundations, themes, patterns, qa, editing-themes)
- [Specialist fan-out](https://skillpatterns.ai/patterns/specialist-fan-out/) — one builder per cluster representative, concurrency-capped ~4–6
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — MCP-tools table, "use these rather than reimplementing in Bash"
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — `parseBuilderEnvelope`, theme.json schema-v3 build gate
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — `liberate_validate_artifacts` trust boundary
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — "never claim a match you haven't measured"
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — "'close enough' is a STOP sign"; under-claim, never over-claim
- [Circuit breaker](https://skillpatterns.ai/patterns/circuit-breaker/) — "3 iterations is a checkpoint, not an exit"
- [Externalized working state](https://skillpatterns.ai/patterns/externalized-working-state/) — write-then-mark resume in `session.json`
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — coverage-gated `core/html` verbatim fallback
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — extensive Anti-patterns section (flattening, hallucinated tokens, page-list nav)
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — "trust design-foundation.json, don't reinterpret palette"
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — "content transformation is out of scope"; entry contract STOPs if capture missing
- [Capability detection](https://skillpatterns.ai/patterns/capability-detection/) — "on Codex/Gemini run sequentially"
- [Gap-to-target scoring](https://skillpatterns.ai/patterns/gap-to-target-scoring/) — R1→R4 escalation ladder, re-measure until it matches

#### `replicate-theme`
*Carry path (dispatched by `liberate`): carry source HTML into `core/html` islands + scope source CSS. High-fidelity, non-block-editable.*

- [Role priming](https://skillpatterns.ai/patterns/role-priming/) — "you are the carry-and-scope reconstruct orchestrator"
- [Decision capture](https://skillpatterns.ai/patterns/decision-capture/) — "what you are trading"; "known limitations — state these in the report"
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — entry contract: STOP if capture missing (don't self-capture); don't convert islands to blocks
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — reuses the shared install/import/compare MCP tools
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — `liberate_reconstruct_pages_carry`, shared `buildPageLinkMap` / `installRunMediaMap`
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — verify fixes landed: local nav hrefs, `wp-content/uploads` srcs, rewritten URLs return HTTP 200
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — "itemize real differences bluntly BEFORE claiming a win"
- [Confidence calibration](https://skillpatterns.ai/patterns/confidence-calibration/) — separate correctness wins from within-noise pixel wins; report the multi-capture spread
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — media-free slimmed WXR to dodge the import timeout; chrome-less sites → one island
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — named known limitations (missing Wix section bg-fills, scale-offset, `url()` backgrounds) watched, not shipped as wins
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — encodes persisted cross-run findings (the honesty bar, the Studio import-timeout workaround)

#### `match-page`
*Whole-page parity orchestration with a replayable log.*

- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — replay → batch-assess → iterate divergent bands
- [Externalized working state](https://skillpatterns.ai/patterns/externalized-working-state/) — `parity-log.json` survives a reconstruct
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — replays logged intents onto a new build
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — dispatches `match-section` per divergent band
- [Specialist fan-out](https://skillpatterns.ai/patterns/specialist-fan-out/) — per-band `match-section` subagents
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — crop source+built per band and look before reporting MATCHED
- [Circuit breaker](https://skillpatterns.ai/patterns/circuit-breaker/) — "≤3 fix cycles per band"; whole-page cap
- [Self-tuning](https://skillpatterns.ai/patterns/self-tuning/) — `promoteToEmitter` graduates recurring fixes into the emitter
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — the @1440 false-positive trap (compare the screenshot, not the numbers)
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — explicit `parity-log.json` entry schema

### Builders & emitters (produce the markup / design system)

#### `design-foundations`
*Infer the semantic design system from captures.*

- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — must pass `liberate_design_foundation_validate {ok:true}`
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — mandatory validate MCP call; consumes the deterministic scaffold
- [Signal vs. noise](https://skillpatterns.ai/patterns/signal-noise-pre-commitment/) — "HTML/CSS first, screenshots only for ambiguity"
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — "browser-computed CSS is the source of truth"
- [Decision capture](https://skillpatterns.ai/patterns/decision-capture/) — every filled role needs an evidence entry; `openQuestions[]`
- [Confidence calibration](https://skillpatterns.ai/patterns/confidence-calibration/) — leave a slot `null` rather than guess; flag ties
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — known scaffold-pollution failure modes, corrected every run
- [Exemplars over instruction](https://skillpatterns.ai/patterns/exemplars-over-instruction/) — worked input→output example with good vs bad evidence
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — Anti-patterns ("skipping validate", "hallucinating tokens") as self-checks
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — uncapturable fonts auto-substitute, recorded as an openQuestion
- [Progressive disclosure](https://skillpatterns.ai/patterns/progressive-disclosure/) — escalating evidence ladder (aggregates → HTML → screenshots)

#### `generating-patterns`
*Builder subagent: section specs → one block pattern.*

- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — "where the source text lives, in order: `spec.headings` … `spec.bodyText`"
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — "⛔ ALL copy is source-verbatim or placeholdered — NEVER paraphrased"
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — "enforced by `liberate_validate_artifacts` — you may not bypass the gate"
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — structured return envelope; malformed = builder failure
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — sized placeholder + flag for missing media, never substitute
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — the getsnooz invented-testimonials post-mortem
- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — pattern-file PHP header spec, slug/category conventions
- [Exemplars over instruction](https://skillpatterns.ai/patterns/exemplars-over-instruction/) — layout examples (hero split, Z-pattern, 3-column grid, FAQ)

#### `compose-page-blocks`
*Misfit-page fallback: rendered HTML → `post_content`.*

- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — output must round-trip `parse_blocks()`
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — `output-verify.ts` discards any hallucinated phrase
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — copy must be reproduced VERBATIM, never reworded
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — "you are NOT generating a theme"; no inline colors / `wp:html` mirrors
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — anti-patterns (HTML-only reading, invented tokens, over-emitting)
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — read the source HTML to ground each section in real markup
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — `[copy not captured]` placeholder when text is missing
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — deterministic `heuristic-blocks.ts` runs first; you're skipped for trivial shapes

#### `creating-themes`
*Scaffold a block theme from the foundation.*

- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — theme.json v3, FSE file structure, `enqueue_block_assets`
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — read `references/block-html.md` first (REQUIRED)
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — creating vs modifying; minimal template set
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — font substitution, "never a bare `sans-serif`"
- [Exemplars over instruction](https://skillpatterns.ai/patterns/exemplars-over-instruction/) — concrete style.css header, fonts snippet, landing-page examples

### Visual-parity & QA (keep the result honest)

#### `design-qa`
*Post-install QA loop: responsiveness + measured parity + escalation.*

- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — banned phrases ("looks good", "close enough") as STOP signs
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — "a 'match' requires measured evidence per section; no evidence ⇒ `fail (unverified)`"
- [Gap-to-target scoring](https://skillpatterns.ai/patterns/gap-to-target-scoring/) — 0–10, "what a 10 looks like", re-score before→after
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — `SectionParity` five-signal rubric; verdict re-derives from records
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — per-URL JSON contract; `passed` is the computed run-report verdict
- [Circuit breaker](https://skillpatterns.ai/patterns/circuit-breaker/) — ladder/cost ceiling → stop-and-ask the operator
- [Human in the loop](https://skillpatterns.ai/patterns/human-in-the-loop/) — only operator `acceptance: {by:'human', proof}` ships a divergent section
- [Specialist fan-out](https://skillpatterns.ai/patterns/specialist-fan-out/) — R4a dispatches editing-themes / editing-blocks / rebuild-section subagents
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — `liberate_replicate_verify`, `evaluateResponsive`, `liberate_compare`
- [Stakes-scaled rigor](https://skillpatterns.ai/patterns/stakes-scaled-rigor/) — hard parity gates vs soft a11y warnings
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — vision must catch what gates can't (semantic misclass, unstyled islands)

#### `match-section`
*Per-section eyes-on apply→render→look→fix loop.*

- [Role priming](https://skillpatterns.ai/patterns/role-priming/) — "you are the per-section executor"
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — "Looking — the gate. You MUST do this every iteration"
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — "'close enough' / 'known gap' are not finishes"
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — "`styledHtml` is your fidelity oracle — don't guess"
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — Playwright render + crop loop
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — fixed-dimension / lazy-image / pre-crop traps
- [Disconfirmation](https://skillpatterns.ai/patterns/disconfirmation/) — "name every difference bluntly; lead with what's WRONG"
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — stay generic, never hardcode a site's colors/fonts/filenames

#### `rebuild-section`
*R4a: rebuild one section into canonical editable blocks.*

- [Role priming](https://skillpatterns.ai/patterns/role-priming/) — "dispatched for one section; your job is R4a"
- [Encoded reasoning](https://skillpatterns.ai/patterns/encoded-reasoning/) — four acceptance gates (oracle, round-trip, parity, coverage)
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — "you cannot self-accept — acceptance is the measured re-score"
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — output must survive a `@wordpress/blocks` round-trip
- [Anti-sycophancy](https://skillpatterns.ai/patterns/anti-sycophancy/) — "never ship a flatten or unstyled island as a 'known gap'"
- [Graceful degradation](https://skillpatterns.ai/patterns/graceful-degradation/) — falling to R4b is "the correct outcome, not a failure"
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — read `styledHtml` for layout, source HTML for exact content
- [Failure mode preloading](https://skillpatterns.ai/patterns/failure-mode-preloading/) — the divergence-signal list tells you exactly what's wrong
- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — "reproduce the source; do not invent content or redesign"

#### `qa`
*Compare extracted WXR vs source, score, fix loop.*

- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — seven phases (Initialize → … → Final Report)
- [Gap-to-target scoring](https://skillpatterns.ai/patterns/gap-to-target-scoring/) — 0–100 weighted health score, before→after delta
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — `runQa` / `readWxr` / `diffContent` from `src/lib/`
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — "re-run comparison; if a fix made things worse, revert"
- [Stakes-scaled rigor](https://skillpatterns.ai/patterns/stakes-scaled-rigor/) — Quick / Standard / Exhaustive tiers tune which grades get fixed
- [Circuit breaker](https://skillpatterns.ai/patterns/circuit-breaker/) — "after every 5 fixes evaluate; hard cap 20 attempts"
- [Human in the loop](https://skillpatterns.ai/patterns/human-in-the-loop/) — "show the report first; ask before applying fixes"
- [Schema-locked output](https://skillpatterns.ai/patterns/schema-locked-output/) — `QaResult` structure; `qa-log.jsonl`
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — escalates to `/diagnose` ("QA finds symptoms; diagnose finds the cause")
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — platform content-loss patterns → `DISCOVERIES.md`

### Platform & maintenance

#### `adapt`
*Build a new platform adapter for an unsupported platform.*

- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — Recon → Build → Register → Test → Document
- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — the `PlatformAdapter` contract (`id`/`detect`/`discover`/`extract`)
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — "read `webflow.ts` as the simplest reference"
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — `liberate_map_apis`, `liberate_probe` for API discovery
- [Disconfirmation](https://skillpatterns.ai/patterns/disconfirmation/) — dry-run verify: are titles correct? is content complete?
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — add a `DISCOVERIES.md` entry for what you learned
- [Clarification gate](https://skillpatterns.ai/patterns/clarification-gate/) — "ask the user for a live site URL to reverse-engineer against"

#### `diagnose`
*Debug failed or low-quality extractions.*

- [Decomposition](https://skillpatterns.ai/patterns/decomposition/) — Triage → Investigate → Fix → Verify → Document
- [Tool offloading](https://skillpatterns.ai/patterns/tool-offloading/) — "start with `liberate_verify`" (replaces manual log grepping)
- [Signal vs. noise](https://skillpatterns.ai/patterns/signal-noise-pre-commitment/) — "read the logs first — don't guess"
- [Disconfirmation](https://skillpatterns.ai/patterns/disconfirmation/) — "probe before fixing; don't mask failures"
- [Prove it works](https://skillpatterns.ai/patterns/prove-it-works/) — re-extract + `/qa`, compare failure counts before/after
- [Stakes-scaled rigor](https://skillpatterns.ai/patterns/stakes-scaled-rigor/) — "one fix at a time; change one thing, re-test"
- [Skill chaining](https://skillpatterns.ai/patterns/skill-chaining/) — escalates to/from `/qa`
- [Long-term memory](https://skillpatterns.ai/patterns/long-term-memory/) — platform quirks → `DISCOVERIES.md`
- [Exemplars over instruction](https://skillpatterns.ai/patterns/exemplars-over-instruction/) — error→cause→fix tables

#### `editing-themes`
*Minimal, targeted edits to an existing block theme.*

- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — "NEVER recreate/overwrite files the user didn't ask for; never rewrite theme.json/functions.php"
- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — update theme.json not raw CSS; register template parts
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — read `creating-themes/references/block-html.md` first
- [Characterization baseline](https://skillpatterns.ai/patterns/characterization-baseline/) — read theme.json/style.css/functions.php before editing; verify templates still resolve after

#### `editing-blocks`
*Minimal, targeted edits to an existing block.*

- [Scope guardrails](https://skillpatterns.ai/patterns/scope-guardrails/) — "don't convert static/dynamic or change the block name/slug unless asked"
- [Scoped conventions](https://skillpatterns.ai/patterns/scoped-conventions/) — keep block.json/edit.js/save.js (or render.php) in sync; plain-JS-not-Interactivity rule
- [Trusted sources](https://skillpatterns.ai/patterns/trusted-sources/) — read `references/` (artefact-templates, inner-blocks, interactivity-api) first
- [Characterization baseline](https://skillpatterns.ai/patterns/characterization-baseline/) — read all block files before editing; verify it still registers and renders after

### Cross-cutting observations

- **The QA/parity family** (`design-qa`, `match-section`, `match-page`, `rebuild-section`, `qa`) is where `Prove it works` + `Gap-to-target scoring` + `Anti-sycophancy` cluster hardest — all share the "measure, don't assert; lead with what's wrong" discipline.
- **The orchestrators** (`liberate`, `replicate-with-blocks`, `replicate-theme`, `match-page`) own the composition patterns: `Decomposition` + `Skill chaining` + `Specialist fan-out` + `Circuit breaker` + `Externalized working state`. `liberate` is the front door (discover → path choice → capture → dispatch → `Bounded option generation` + `Human in the loop`, the choice gated *before* extraction); the two reconstruct sub-skills do the heavy lifting.
- **The WP-generic creating/editing skills** (`creating-themes`, `editing-themes`, `editing-blocks`, `generating-patterns`) form the `Scoped conventions` + `Trusted sources` (a `references/` dir) + `Scope guardrails` cluster.
- **`Tool offloading` is near-universal** — every skill that calls a `liberate_*` MCP tool or a `src/lib/` helper rather than reimplementing the logic is offloading deterministic work to keep judgment in the context window. This *is* the deterministic/AI boundary expressed as a pattern.
- **`Long-term memory`** surfaces as `DISCOVERIES.md` writes — the in-repo log of platform quirks and extraction techniques the orchestrators append to.
