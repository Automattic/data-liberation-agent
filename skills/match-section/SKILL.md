---
name: match-section
description: Reach VISUAL parity for ONE section by guiding AI to apply the captured design data (colors, padding, margins, full-bleed, font sizes, line-heights, families, alignment) to that section's WordPress block markup, then VERIFYING by looking at the source section and the built section side-by-side and iterating until they are visually identical. Non-deterministic on purpose — deterministic emission gets the structure right but misses visual parity; this skill closes the gap with an AI eyes-on loop. The per-section EXECUTOR called by `match-page` (which runs the batch Phase-1 assessment first, then dispatches this per divergent section). Do not drive whole-page parity by hand-rolling per-section work — run `match-page` so the batch assessment happens first. Dispatched per section (subagent) by match-page/replicate-with-blocks/design-qa. Not user-invocable directly.
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - mcp__plugin_playwright_playwright__browser_navigate
  - mcp__plugin_playwright_playwright__browser_resize
  - mcp__plugin_playwright_playwright__browser_take_screenshot
  - mcp__plugin_playwright_playwright__browser_evaluate
---

## What you do

You make ONE section of the replica look visually identical to the same section on the source site. You are given everything the pipeline captured about that section. **Use it.** Then you LOOK at both — source section and your built section — and you do not stop until they match. Deterministic code already ran and got the structure roughly right; your job is the visual gap it cannot close.

This is an eyes-on loop, not a one-shot emit. Apply → render → **look at both images** → name every difference → fix → render → look again. Move to "done" ONLY when the two images are visually identical (allowing for font-substitution and text-reflow noise — NOT for wrong color, wrong size, wrong spacing, wrong alignment, dropped media, or wrong width).

## Inputs the orchestrator gives you

- `outputDir` (e.g. `~/Studio/_liberations/example.com`), `studioSitePath` (e.g. `~/Studio/example-com`), `themeSlug`, the page `slug` + `sourceUrl`, and the **section index** `i` within that page.
- The replica preview URL (e.g. `http://localhost:8881`).

Everything else you READ yourself from the captured data below.

## The captured data — this is your fuel. Read ALL of it for the section.

For section index `i` of the page:

1. **`outputDir/sections/<slug>.json`** → `sections[i]` — the `SectionSpec`. Read every field:
   - `backgroundColor` (rgb/rgba), `gradient`
   - `layout.padTopPx` / `layout.padBottomPx` / `layout.padding` / `layout.gap` / `layout.containerWidth` / `layout.columnCount`
   - `fullBleed` (true → section spans the viewport edge-to-edge)
   - `headings[]`, `headingSizes[]` (px), `headingLineHeights[]`, `headingFamilies[]`
   - `bodyText[]`, `bodyTextSizes[]`, `bodyLineHeights[]`, `bodyFamilies[]`
   - `buttonLabels[]` / `buttons[]`, `images[]` (url, width, height, alt), `cells[]`, `textAlign`, `mediaLayout`
   - **`styledHtml`** — a snapshot of the source subtree with every computed style inlined. This is your FIDELITY ORACLE: when in doubt about any value (a padding, a color, a font-size on a specific element), read it straight out of `styledHtml`. It is the source's exact rendered design.
2. **`outputDir/design-foundation.json`** — the theme's semantic tokens (color roles, type families, spacing). Prefer a token slug when the captured value maps to one; use an explicit value when it does not.
3. **`outputDir/theme/theme.json`** — the registered `fontFamilies` slugs, `fontSizes`, `color.palette` slugs you can reference.
4. **Source section image** — the cropped source screenshot for this section (see "Looking", below).

If a value is missing from the spec, get it from `styledHtml`. Do not guess.

**Captured px are measured at the desktop capture width (≈1440).** A FIXED dimension (a cover `minHeight`, a fixed section height) copied verbatim will be too tall at a narrower compare width — convert proportional dimensions to `vw` (e.g. a 733px hero at 1440 → `51vw`). Padding/font-size carried as `clamp()` already scale; fixed `minHeight`/`height` do not. Always compare at the SOURCE screenshot's real width so px line up.

**Lazy images:** below-fold cover/section images decode lazily — a screenshot taken before they load shows a GREY block (looks like a "lost background"). Scroll the whole page to force-load (the `scripts/_shot.ts` helper does this with `mouse.wheel`, not `page.evaluate`) BEFORE judging a missing/grey background, or you will chase a phantom.

## Apply it to the block markup — core attributes only

The section's blocks live in the page's `post_content` and in `outputDir/theme/theme/patterns/page-<slug>.php`. Edit the markup for THIS section. Map each captured axis to a CORE block attribute — these survive `@wordpress/blocks` canonicalization; inline `<figure style>` and ad-hoc wrapper styles do NOT (they get stripped — [[project_block_fixer_canonicalization_constraint]]):

| Captured | Apply as |
|---|---|
| heading/body font-size | `style.typography.fontSize` (px or a `clamp()` whose max = captured px) |
| line-height | `style.typography.lineHeight` (carry it WITH the size — never split them) |
| font-family | `fontFamily` slug (`display`/`body`/…); match the source face |
| font-weight / letter-spacing / transform / align | `style.typography.fontWeight`/`.letterSpacing`/`.textTransform`, `textAlign` |
| section padTopPx/padBottomPx, padding | `style.spacing.padding` on the section group |
| inter-band margin | `style.spacing.margin` |
| gap between columns/items | `style.spacing.blockGap` |
| backgroundColor | `backgroundColor` slug or `style.color.background` |
| text color | `textColor` slug or `style.color.text` |
| fullBleed = true | `align:full` on the section group + zero side padding |
| not full-bleed | constrained (content width from `layout.containerWidth`) |
| columnCount | a `core/columns` with that many `core/column` (do NOT flatten) |
| cover image focal point | inline `style="object-position:X% Y%"` DIRECTLY on the `<img>` tag — NOT `focalPoint` block JSON. Static-HTML patterns bypass server-side cover rendering, so `focalPoint` JSON does nothing; the inline `object-position` is what actually moves the crop. |

**Preserve ALL content** — every heading, paragraph, list item, button, image the source shows ([[feedback_never_lose_source_content]]). Never drop an image to "simplify."

## Render your change

After editing the section's markup:
1. Write the updated full `post_content` for the page to a temp file, then push it:
   `studio wp --path <studioSitePath> post update <pageId> --post_content="$(cat /tmp/section-content.html)"`
   (Get `<pageId>`: `studio wp --path <studioSitePath> post list --post_type=page --fields=ID,post_name --format=csv`.)
   Mirror the same block edit into `outputDir/theme/theme/patterns/page-<slug>.php` and the installed copy under `<studioSitePath>/wp-content/themes/<themeSlug>/patterns/` so the theme + editor stay in sync.
2. Flush: `studio wp --path <studioSitePath> cache flush`.

## Looking — the gate. You MUST do this every iteration.

1. **Source section image.** The full-page source screenshot is `outputDir/screenshots/desktop/<slug>.png`. FIRST read its real width (`identify -format "%w" <src>`) — it is often ~1008px, NOT 1440. Crop to this section's vertical band using the spec's `top` + `height` (`convert <src> -crop WxH+0+TOP +repage outputDir/screenshots/src-section-<i>.png`, width = the image's real width). Staging note: write all crops/screenshots under `outputDir/screenshots/` — `/tmp` is OUTSIDE the Playwright MCP allowed roots and will be rejected.
2. **Built section image.** Resize the Playwright viewport to the SOURCE screenshot's real width (e.g. 1008×900, not 1440) so the two are pixel-comparable — a width mismatch changes responsive crops and would create phantom "differences." Navigate to `<previewUrl>/<slug>/` (cache-bust with `?v=<n>`; for the front page the content may be at `<previewUrl>/`), then crop the rendered section to its bounding box (`browser_evaluate` the element's rect → `convert` crop) and save under `outputDir/screenshots/`.

   A composition difference that comes from the SOURCE's pre-cropped CDN asset (e.g. a Wix image served pre-cropped at a width you don't have the exact pixels for) is NOT a markup bug — note it as residual, don't chase it with markup changes.
3. **Read BOTH images** (Read tool on the two PNGs). Put them next to each other in your reasoning.
4. **Name every difference** — bluntly, itemized ([[feedback_honest_visual_assessment]]): background color? section padding (too tight / too loose)? heading size? line-height (cramped/overlapping)? body font wrong face? alignment (centered vs left)? full-bleed vs boxed? column count flattened? missing image? button style?
5. If ANY real difference remains → fix it in the markup (map back to the table above, pulling exact values from the spec / `styledHtml`), re-render, re-look. Loop.
6. Only when the two images are **visually identical** (modulo font-substitution + minor text reflow) do you finish this section.

**Do not rationalize a miss.** "Close enough", "known gap", "the source is just different" are not finishes — fix it or, if you genuinely cannot (a true WP rendering constraint), report it explicitly with both images, do not silently ship it.

## Output

Report: the section, the iterations you ran, the diffs you closed each round (before→after), the final source-vs-built crops, and STATUS = MATCHED (visually identical) / RESIDUAL (list the exact remaining differences + why you could not close them — for the operator). Never report MATCHED without having looked at both images in the final iteration.

## Stay generic

Derive every value from THIS section's captured data. Never hardcode a site's colors, fonts, filenames, copy, or section order ([[feedback_scripts_must_be_site_agnostic]]). The same loop must match any platform's section.
