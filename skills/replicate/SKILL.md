---
name: replicate
description: Spec-driven, whole-site block-theme reconstruction for a liberated site. Invokes design-foundations → creating-themes → clustering → spec extraction → generating-patterns (fan-out, per cluster) → assemble → validate → install → design-qa to produce a responsive, editable WordPress block theme that matches the source site's layout, content structure, and visual design. Call after `liberate` (extraction) and before content import, or re-run standalone to re-theme an already-extracted site. Use when the user says "rebuild this site," "replicate the design," "make a theme that matches," "recreate the layout," or asks for a WordPress version of a liberated site.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
---

# Replicate

You are a **design sub-orchestrator**. You drive the spec-driven whole-site block-reconstruction flow, delegating judgment to the composable skills below and determinism to MCP tools, then assembling and validating what they return. The `/liberate` root orchestrator calls you inline; you are also independently invocable to re-theme an already-extracted site.

The acceptance bar is source parity, not a pleasant approximation:

- Preserve observed section order, header/footer structure, navigation labels, CTA placement, media placement/aspect ratios, column counts, alignment, spacing rhythm, and responsive stacking.
- Use source text and uploaded media only. Do not invent copy, placeholder cards, stock-like sections, or generic marketing layouts.
- Templates render imported post/product content through proper WP template hierarchy; patterns and layout skeletons are for pages. Do not reconstruct posts or products section-by-section — that is handled by templates + Query Loop + WooCommerce.
- Do not use Custom HTML blocks (`core/html` / `wp:html`). Use core blocks first; embed a custom block inside the theme (`blocks/<slug>/`) only when a source component cannot be expressed any other way (see anti-patterns).
- The old 27-pattern library is now seed material in the `section-mapping` catalog — it is not the primary mechanism. Builders pick block templates from the catalog; they do not pick-tweak from the 27-pattern library.

## Prerequisites

Confirm these exist in `output/<site>/` before starting:

- `design-foundation.json` — produced by `design-foundations`. **Required.** If missing, stop and tell the caller to run `design-foundations` first.
- `design.md` — frozen brief from `design-foundations`. Required (written in the same step).
- `html/*.html` — rendered HTML per page from the capture stage. If missing, stop: the screenshot/HTML capture stage was skipped. Re-run extraction with screenshots enabled.
- `screenshots/desktop/*.png` + `screenshots/mobile/*.png` — for verification and QA.
- `screenshots/manifest.json` — URL → file map.
- `output.wxr` — and optionally `products.jsonl` / `products.csv` for Woo sites.

`palette.json`, `typography.json`, and `breakpoints.json` (from screenshot aggregation) are consumed by `design-foundations` and baked into `design-foundation.json`; you do not read them directly.

## MCP tools you call

Use these tools rather than reimplementing their logic in Bash. Each has a typed I/O schema in the codebase.

| Tool | What it does |
|---|---|
| `liberate_section_extract({ url\|html, mediaMap, detail })` | `detail:"signature"` → ordered section-type sequence + structural attrs (all pages, off saved `html/<slug>.html`); `detail:"full"` → `specs/<rep>/section-<n>-<type>.md` (computed styles, interaction model, uploaded WP media URLs, brightness, motion — reps only) |
| `liberate_cluster_pages({ outputDir, signatures })` | Groups pages by exact layout signature → `cluster-map.json` (cluster per unique signature, representative = richest HTML) |
| `liberate_compose_instantiate({ outputDir, skeleton, pageContent, mediaMap })` | Deterministic slot-fill: cluster layout skeleton + this page's content → `post_content` block markup; returns `{ postContent, misfit }`. Misfit pages → `compose-page-blocks` skill |
| `liberate_validate_artifacts({ outputDir })` | Security + quality trust boundary before install. Asserts: escaping (`esc_html`/`esc_attr`/`esc_url`), no raw `<?php`/`<script>`/`on*=`, emitted text ⊆ spec captured text (provenance), no remote CDN URLs, no `{{placeholder}}` text, block-comment-only markup. Fail → fix, don't install |
| `liberate_install_theme({ outputDir, studioSitePath, themeFiles, themeSlug })` | Writes theme files into a running Studio site and activates the theme (streaming / watch-loop context) |
| `liberate_preview({ outputDir, themeFiles, themeSlug, open?, port? })` | Standalone context: creates/reuses a Studio site, imports WXR + products.csv, writes + activates the theme |

## Sub-skills you invoke

Read each skill's SKILL.md before invoking it.

| Skill | When |
|---|---|
| `design-foundations` | Step 1 — if `design-foundation.json` or `design.md` are missing |
| `creating-themes` | Step 1 — emits `theme.json`, `style.css`, `functions.php`, parts skeleton, base templates, self-hosted fonts |
| `generating-patterns` | Step 4 — one builder per cluster representative (fan-out, concurrency-capped) |
| `compose-page-blocks` | Step 5 — misfit pages only (post-compose sanity check flagged them as unmatched) |
| `design-qa` | Step 7 — visual QA loop after install |
| `editing-themes` | Step 7 — apply fix directives from `design-qa` |

## The 7-step flow

### Step 1 — Foundation + theme scaffold

**If `design-foundation.json` and `design.md` already exist, skip to the build gate check and continue.**

1a. Invoke `design-foundations`. It reads `html/`, `screenshots/`, `palette.json`, `typography.json`, `breakpoints.json`, and `manifest.json`; emits `design-foundation.json` (semantic token roles: `color.accent.primary`, `typography.families.display`, etc.) and freezes `design.md`. Do not proceed with raw aggregates.

1b. Invoke `creating-themes`. It reads `design-foundation.json` + `design.md` and emits:
  - `theme/theme.json` (schema v3, token roles mapped from foundation — see token mapping below)
  - `theme/style.css` (with the correct theme header)
  - `theme/functions.php`
  - `theme/parts/header.html` and `theme/parts/footer.html` (skeleton — overwritten in step 5)
  - `theme/templates/index.html`, `theme/templates/page.html`, `theme/templates/single.html`, `theme/templates/single-product.html`, `theme/templates/archive-product.html` (base — content slots filled in step 5)
  - Self-hosted font declarations

**Build gate (after foundation):** validate `theme.json` against schema v3 and run the known-activation-fatals lint via `lintThemeJson` in `src/lib/replicate/theme-json-lint.ts` (e.g. `spacingScale.theme:false` fatal, missing `version` field). Fail → fix `theme.json` before continuing. Do not skip the gate.

**Token mapping (theme.json from design-foundation.json):**

- `color.surface.*` → `settings.color.palette` entries: `surface-base`, `surface-raised`, `surface-inverse`
- `color.text.*` → `text-default`, `text-muted`, `text-subtle`, `text-inverse`
- `color.accent.*` → `accent-primary`, `accent-warning`, `accent-warm`, `accent-highlight`
- `color.border.*` → `border-default`, `border-subtle`
- `typography.families.body` → `settings.typography.fontFamilies[0]`
- `typography.families.display` → `settings.typography.fontFamilies[1]` (omit if `null` — do NOT hallucinate a serif)
- `typography.families.mono` → `settings.typography.fontFamilies[2]` (omit if `null`)
- `breakpoints.lg` → `settings.layout.contentSize`; `breakpoints.xl` → `settings.layout.wideSize`
- `components.*` → `styles.blocks.core/*` overrides (button, paragraph, separator, etc.)

If you provide explicit `settings.spacing.spacingSizes`, omit `settings.spacing.spacingScale` entirely. Do not set `settings.spacing.spacingScale.theme` to `false`.

### Step 2 — Cluster

2a. Call `liberate_section_extract` with `detail:"signature"` for every page in `html/*.html`. This is a batch call over saved HTML — no re-navigation, no Playwright.

2b. Call `liberate_cluster_pages` with all page signatures → `cluster-map.json`. Pages with identical section-type sequences join one cluster. Near-matches (edit-distance ≤ 1) merge with a note. The representative is the cluster member with the most sections (richest HTML by byte size). Exact-signature clustering only — fuzzy deferred.

Read `cluster-map.json` and note: how many clusters, which pages are in each, who the representative is.

### Step 3 — Per-cluster representative specs

For each cluster representative, call `liberate_section_extract` with `detail:"full"`. This emits `output/<site>/specs/<rep>/section-<n>-<type>.md` for each section of the representative page.

Spec files are the contract between extraction and pattern generation. Each spec contains: interaction model, Y band, background color + brightness, text/accent colors, overlay flags, headings (verbatim), body text (verbatim), buttons (label/href/colors), list items, and image references (uploaded WP-library URLs or `assets/<local-filename>`).

**Per-cluster readiness check:** before dispatching a builder, verify each spec has: interaction model set, computed styles present, media local-pathed (no CDN URLs), brightness recorded. Incomplete spec → fix it, don't dispatch.

**Page-builder sections (Shopify/Replo, Shogun):** these stores have rich repeated components — `product-card-row` (image + title + price), `review-grid` (star rating + quote + name), `app-download` (store-badge images), and email-capture heroes. `liberate_section_extract detail:"full"` now classifies these as their own interaction models; the builder maps each to the matching `references/section-mapping.md` template. Don't let a product/review row collapse to generic `static`/`columns`.

**Missing-media:** if a spec's image slot has no local/WP-library URL (capture failed), the builder must emit a sized placeholder and add a `details.provenanceFlags` entry — NOT substitute an unrelated photo. A non-zero provenance count is a `warn`, not a silent pass. The extractor now captures page-builder CDN imagery (Replo `assets.replocdn.com`, etc.) regardless of host/extension, so genuine misses should be rare.

Sitewide-shared sections (header, footer, a recurring CTA band that appears identically across clusters) are identified here and built once — deduplicated before builder dispatch.

### Step 4 — Build (fan-out)

Invoke one `generating-patterns` builder **per cluster representative**. Builders are run in parallel, concurrency-capped to ~4–6. On Codex/Gemini, run sequentially.

Each builder receives (by path — builders are read-only on shared artifacts):
- `design.md` path
- Theme slug
- Token snapshot from `design-foundation.json`
- Uploaded media URL map
- The cluster's spec files (`specs/<rep>/section-*.md`)
- The section-mapping catalog (`skills/generating-patterns/references/section-mapping.md`)
- The spec-files contract (`skills/generating-patterns/references/spec-files.md`)

Each builder returns a **structured JSON envelope** — `{ patterns: [{ slug, php }], sitewideFlags: [...], notes: [...] }` — validated by `parseBuilderEnvelope` in `src/lib/replicate/builder-envelope.ts`. A malformed or partial return is a builder failure → retry once → fall back to sequential for that cluster. Never silently use partial output.

Builders emit **layout skeletons per cluster** (section-mapping templates with content slots filled from the spec's verbatim content), not finished per-page markup. Sitewide-shared sections (flagged in `sitewideFlags`) become registered WP patterns or template parts referenced by slug.

Persist each cluster's patterns **before** marking it built in `session.json` (write-then-mark for resume). Log failures to `theme/debug/cluster-<n>.json` and `theme/notes.md`.

Checkpoint by cluster-group with a compaction/handoff between groups (full state in `session.json` + a short design-state summary) so the orchestrator's context can reset without losing contract artifacts.

### Step 5 — Assemble

**For most pages (deterministic path):** call `liberate_compose_instantiate` with the cluster's layout skeleton + this page's captured content + media map → `post_content` block markup. Run the post-compose sanity check: all slots filled, section count matches cluster signature. Fail → re-route to `compose-page-blocks` (never ship empty/broken sections silently).

**For misfit pages:** invoke `compose-page-blocks` with the page's HTML/content + cluster layout skeleton + tokens + media map + archetype.

**Header/footer:** use the existing dynamic block-header (logo, nav→local pages, CTA, overlay-vs-solid treatment). Build the footer from the cluster representative's footer spec. Write both to `theme/parts/header.html` and `theme/parts/footer.html`.

**Posts:** render through `templates/single.html` + blog/archive template + Query Loop. No per-post section reconstruction.

**Products:** render through `templates/single-product.html` + `templates/archive-product.html` + WooCommerce. No per-product section reconstruction.

Assemble all theme files into a single in-memory array for install:

```ts
themeFiles: [
  { relativePath: "style.css", content: "/* Theme Name: ... */" },
  { relativePath: "theme.json", content: "..." },
  { relativePath: "functions.php", content: "<?php ..." },
  { relativePath: "templates/index.html", content: "<!-- wp:... -->" },
  { relativePath: "templates/page.html", content: "..." },
  { relativePath: "templates/single.html", content: "..." },
  { relativePath: "templates/single-product.html", content: "..." },
  { relativePath: "templates/archive-product.html", content: "..." },
  { relativePath: "parts/header.html", content: "..." },
  { relativePath: "parts/footer.html", content: "..." },
  { relativePath: "patterns/<cluster-slug>.php", content: "<?php /** Title: ... */ ?> ..." },
  // ...one pattern file per cluster representative's built layout skeleton
]
```

Custom blocks (rare — only when core blocks cannot express a real source interactive component) embed in the theme as `blocks/<slug>/src/` + `blocks/<slug>/build/`. Register from `build/` in `functions.php` via `register_block_type`. Emit both `src/` and `build/` in `themeFiles[]`. Namespace: `<siteSlug>-replica/<block-name>`. Use `"supports": { "html": false }` and `"apiVersion": 3`.

### Step 6 — Validate

Call `liberate_validate_artifacts({ outputDir })`. This is the security trust boundary — run it before every install, every time.

It asserts:
- All source-derived text is escaped (`esc_html`/`esc_attr`/`esc_url`)
- No raw `<?php` / `<script>` / `on*=` handlers in emitted markup (PHP injection + stored XSS defense)
- Emitted text is a subset of spec captured text (provenance — flags invented prose)
- No remote CDN URLs (all assets must be uploaded WP-library URLs or theme-shipped `assets/`)
- No unresolved `{{placeholder}}` text
- Block-comment-only markup

**Fail → fix the patterns/templates, do not install.** Gate failures surface in `run-report.json`.

### Step 7 — Install + QA

**Install:**

- **Streaming / watch-loop context:** call `liberate_install_theme({ outputDir, studioSitePath, themeFiles, themeSlug })` using the exact `themeSlug` value from the runner prompt. Writes files into the running Studio site and activates. No site creation, no duplicate WXR import.
- **Standalone replicate:** call `liberate_preview({ outputDir, themeFiles, themeSlug: "<siteSlug>-replica" })`. Creates/reuses a Studio site (clean site on full re-run; keep existing on resume) and imports `output.wxr` + `products.csv`.

Verify: `themeWritten > 0` and `warnings` empty. Capture the replica URL.

**QA:** invoke `design-qa`. It captures replica desktop + mobile screenshots, pairs them with source screenshots, runs the responsiveness gate (390px — HARD: no horizontal overflow, sections reflow), and produces qualitative observations + A/B/C classification per archetype representative.

- **Responsiveness gate is hard.** A theme that overflows at 390px fails, full stop.
- Pixel-diff is a signal only — not the gate criterion.
- Cap QA at 3 iterations per archetype representative. If iteration 3 still fails, amend `design.md`, re-run `creating-themes` to regenerate `theme.json` and style foundation, and rebuild affected clusters from scratch (full foundation invalidation). Then re-enter QA.
- Between iterations: apply fix directives from `design-qa` via `editing-themes`; reinstall via `liberate_install_theme`; re-run `design-qa`.
- After 3 failed iterations: stop, log unresolved gaps to `theme/notes.md` and `run-report.json`, and surface as `openQuestions` in the return value.

**Return** a structured summary to the caller:

```json
{
  "siteSlug": "example-com-replica",
  "themeSlug": "example-com-replica",
  "target": { "kind": "studio", "siteId": "...", "url": "https://example-com-replica.wp.local" },
  "archetypes": ["homepage", "page", "post", "product"],
  "clustersBuilt": 5,
  "clustersFailed": 0,
  "misfitPages": [],
  "qa": { "responsivePass": true, "qualitative": "B", "itersUsed": 2 },
  "openQuestions": [],
  "runReport": "output/example.com/run-report.json"
}
```

## Gates summary

| Gate | When | Hard? |
|---|---|---|
| Build gate (theme.json schema v3 + lintThemeJson activation fatals) | After step 1 | Yes — fix before continuing |
| Per-cluster readiness check (specs complete before builder dispatch) | Before step 4 | Yes — fix spec, don't dispatch |
| Builder envelope validation (parseBuilderEnvelope) | After step 4 each builder | Yes — retry → sequential, never use partial |
| validate-artifacts (escaping + provenance + injection + placeholders) | Step 6, before every install | Yes — fix, don't install |
| Responsiveness gate (390px, no overflow, sections reflow) | Step 7 QA | Hard — fail = not done |
| Qualitative gate | Step 7 QA, ≤3 iters | Soft — iterate, then surface gaps |

## Decision rules

- **Trust `design-foundation.json`** for tokens. Don't reinterpret colors from raw palette. Don't hallucinate a display font when `typography.families.display: null`.
- **Prefer core blocks.** `wp:columns`, `wp:cover`, `wp:group`, `wp:details`, `wp:navigation` cover most observed layouts.
- **No `core/html`.** `wp:html` is not a fallback. CSS goes in `style.css`; structure goes in core block markup.
- **One layout skeleton per cluster, not per page.** Builders emit layout templates; `liberate_compose_instantiate` fills content.
- **Posts and products are data.** Route through templates + Query Loop + WooCommerce. No per-post or per-product section reconstruction.
- **Skip archetypes with `count === 0`** silently.
- **Skip count=0 archetypes** and do not build templates for hypothetical content types.
- **Sitewide sections (header, footer, recurring CTA bands) are built once** and deduped before builder dispatch.
- **Builders are pure.** They never write to disk — only return strings. The orchestrator persists and marks built.
- **Budget guard:** a run exceeding the configurable subagent/cluster/elapsed ceiling pauses and asks the operator rather than running away.

## Anti-patterns

- **Picking and tweaking from the 27-pattern library directly.** The 27-pattern library is now seed material folded into the `section-mapping` catalog. Builders read `section-mapping.md` and `spec-files.md`. Do not reach back to `skills/replicate/references/patterns/`.
- **Generating patterns from scratch without a catalog match.** Check `section-mapping.md` first. Fresh generation is the last resort.
- **Reading WXR `<wp:post_content>` and recreating it as blocks.** Content transformation is out of scope. The theme renders what's already in WXR; it doesn't reconstruct it.
- **Generating a pleasant generic theme.** A clean generic layout is failure when the source has a different section order, grid, spacing, media treatment, header, footer, or responsive stack.
- **Hallucinating tokens.** `display: null` → omit, don't invent. No hex values in patterns — always token slugs.
- **Running `liberate_validate_artifacts` and ignoring failures.** The gate is a trust boundary. Failures mean injected/invented text could reach the installed theme.
- **Skipping the responsiveness gate.** A theme that overflows at 390px is not done, regardless of how it looks on desktop.
- **Custom HTML for layout or CSS.** Inline `<style>`, raw SVG sets, embedded `<script>`, hidden `<form>` → all rejected. Use core blocks + `style.css` or a real theme-embedded custom block.
- **Custom blocks for layout-only differences.** If the only issue is "columns aren't quite right," edit the layout skeleton instead. Custom blocks are for interactive components that core blocks genuinely cannot express (multi-step form, non-standard carousel with computed state, pricing table with toggles). If the source's interactivity didn't survive extraction, use core blocks + honest static content — not a non-functional custom block.
- **Telex-flavored output.** Footer credits, plugin namespaces, and author fields use `<siteSlug>-replica`, not `telex/`.

## Reference files

Read these when the relevant step comes up — not all are needed on every run:

- **`skills/generating-patterns/references/section-mapping.md`** — interaction-model → WP block template catalog; brightness rule, gradient rule, divider rule, styling rule. Read in step 4 before dispatching builders.
- **`skills/generating-patterns/references/spec-files.md`** — the spec file contract (template, field definitions, media note). Read in step 3 when writing or auditing specs.
- **`skills/design-foundations/references/design-brief.md`** — the `design.md` 10-section template; what each section fills from, lifecycle. Read in step 1 if `design-foundations` is being invoked.
- **`skills/design-foundations/references/theme-tokens.md`** — token-role → theme.json mapping detail. Read in step 1 when token mapping is ambiguous.
- **`skills/design-qa/references/visual-qa.md`** — QA loop mechanics, failure classes A/B/C, iteration budget, run-report output. Read in step 7 before invoking `design-qa`.
