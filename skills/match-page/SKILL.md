---
name: match-page
description: Orchestrate whole-PAGE visual parity. PHASE 1 (always first) — one batch pass that measures EVERY section's built design against the captured source design across all axes (margin, padding, font-size, line-height, color, full-bleed, alignment) and emits a per-section × per-axis diff table. PHASE 2 — iterate match-section on the divergent sections only, worst-first, re-measuring each until it matches. This is the entry point for reaching design parity on a page; do NOT hand-roll per-section work without running the Phase 1 batch assessment first. Dispatched by replicate/design-qa; calls match-section per section.
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Edit
  - Agent
  - mcp__plugin_playwright_playwright__browser_navigate
  - mcp__plugin_playwright_playwright__browser_resize
  - mcp__plugin_playwright_playwright__browser_evaluate
---

## Why this exists

Reaching design parity by improvising per-section edits is slow, inconsistent, and prone to runaways. The fix is a fixed two-phase shape: **measure the whole page once, THEN iterate only the sections that diverge.** Phase 1 is cheap (one render + one DOM measurement); it tells you exactly which sections need work and on which axes, so Phase 2 is targeted, not exploratory.

## Inputs

`outputDir` (e.g. `output/example.com`), `studioSitePath`, `themeSlug`, page `slug` + `sourceUrl`, `previewUrl` (e.g. `http://localhost:8881`; front page renders at `/`). Captured specs: `outputDir/sections/<slug>.json` → `sections[]` (ordered by `top`; each carries `top`, `height`, `backgroundColor`, `layout.padTopPx/padBottomPx/gap`, `fullBleed`, `headingSizes`/`headingLineHeights`/`headingFamilies`, `bodyTextSizes`/`bodyLineHeights`/`bodyFamilies`, `cells`, `textAlign`, plus `styledHtml` — the computed-style oracle). Source screenshot: `outputDir/screenshots/desktop/<slug>.png` (read its real width with `identify`; compare at THAT width).

**CRITICAL — compare against the SOURCE SCREENSHOT, not the captured numbers.** The captured `SectionSpec` values (`headingSizes`, `padTopPx`, `height`, …) are measured at the **1440px desktop capture**; the page renders and is compared at the source screenshot width (often **1008px**), and the deterministic emitter scales type/spacing by `vw`/`clamp`. So built `26px` is a captured `36px` scaled at 1008 — NOT a divergence. Diffing built-render against captured-@1440 numbers produces all false positives and causes thrash. The TRUTH for visual parity is **built render vs source render at the same width** (pixels vs pixels). Use the captured numbers only as the values to APPLY in Phase 2, never as the comparison target.

## PHASE 1 — Batch assessment (ALWAYS do this first; one pass)

1. Read the source screenshot width: `identify -format "%w" outputDir/screenshots/desktop/<slug>.png`. Render the built page ONCE at THAT width: `npx tsx scripts/_shot.ts "<previewUrl>/<slug>/?v=1" outputDir/screenshots/built-<slug>.png <srcWidth>` (it scrolls to settle lazy images; do not use the Playwright MCP screenshot — it times out on tall pages).
2. Get the built band boundaries: `browser_navigate` at `<srcWidth>×900`, then `browser_evaluate` to list the band container's children (the `.entry-content`/`.wp-block-post-content` children — a MIX of `<div class="wp-block-cover">` heroes and `<section class="wp-block-group">` bands) with each one's `getBoundingClientRect()` top + height. That gives N built bands in document order.
3. For EACH band, crop the SAME vertical range from BOTH the source screenshot and the built screenshot (`magick <img> -crop <W>x<H>+0+<top> +repage out.png`; source band tops scale from the built tops by the page-height ratio, or detect bg-color band boundaries) and READ the two crops side by side. Flag the band DIVERGENT on the axes you can SEE: background color, heading size/weight relative to the band, body text size, alignment (centered vs left), inter-element spacing, full-bleed vs boxed, dropped media/content, button style. This is a visual judgement per band, not a number diff.
4. **Print the per-band verdict table** (band → divergent axes, or DONE). Bands that look identical are DONE — do not touch them.

This whole phase is ONE render + N band crops. It replaces eyeballing the whole page and guessing, and it does NOT chase captured @1440 numbers.

## PHASE 2 — Iterate divergent sections (worst-first)

For each divergent section, ordered by composite descending:

1. Run **`match-section`** for that section index (dispatch a subagent pointed at `skills/match-section/SKILL.md`, OR apply inline if you are already that executor): apply the captured values for the divergent axes (from the spec / `styledHtml`) as canonicalization-safe core block attributes, render, and eyes-on compare source-crop vs built-crop until visually identical.
2. **Re-measure ONLY that section** (re-run the Phase-1 measurement for its index) to confirm its divergent cells cleared. Do not re-render/re-measure the whole page each time.
3. **Bounds (anti-runaway):** at most 3 fix cycles per section; if a section still diverges after 3, record it RESIDUAL (with the remaining axes + why) and move on — do NOT keep grinding one section. Cap the whole page at a sane total (e.g. ≤ 2× the section count of cycles); if hit, stop and report.

Mechanics for applying + rendering are in `skills/match-section/SKILL.md` (post_content via `studio wp post update`, mirror into both theme pattern copies, `cache flush`). Preserve ALL content; never touch the nav template, footer part, or a section already marked DONE.

## Output

- The Phase-1 diff table (before): every section × axis, divergent cells flagged.
- Per divergent section: the axes fixed (before→after) and final MATCHED/RESIDUAL.
- The Phase-1 table re-run at the end (after) showing remaining divergences.
- Total cycles spent (so a runaway is visible).

Never report the page MATCHED without the after-table showing zero unaccepted divergent cells.
