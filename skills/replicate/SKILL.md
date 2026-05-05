---
name: replicate
description: Replicate a liberated site's layout, structure, and theme as a WordPress block theme + patterns + (when needed) custom blocks, installed into a target Studio or Playground site so the imported WXR/products content renders the way the source site looked. Call after `liberate` (extraction) and `design-foundations` (token roles), before content import. Use when the user says "rebuild this site," "replicate the design," "make a theme that matches," "recreate the layout," or asks for a WordPress version of a liberated site. The skill is HTML/CSS-first: it reads rendered HTML, source chrome, aggregate tokens, and representative archetype evidence to compose the theme; screenshots are used for ambiguity checks and verification, not as the default input for every decision.
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

You produce a WordPress block theme that makes an imported liberation site match the source site's content structure and layout as exactly as WordPress blocks allow. The default evidence path is HTML/CSS-first: rendered HTML tells you structure and real content, aggregate analysis supplies tokens, and screenshots are used only when HTML/CSS evidence is ambiguous or during verification.

The acceptance bar is source parity, not a pleasant approximation:

- Preserve observed section order, header/footer structure, navigation labels, CTA placement, media placement/aspect ratios, column counts, alignment, spacing rhythm, and responsive stacking.
- Use source text and imported media only. Do not invent copy, placeholder cards, stock-like sections, or generic marketing layouts.
- Templates must render imported post content inside a layout shell that matches the source archetype. Patterns are for repeated global/section structures observed in source evidence, not a replacement for page content import.
- Do not use Custom HTML blocks (`core/html` / `wp:html`). Use existing WordPress core blocks first, create theme-embedded custom blocks only when a source component cannot be represented with core blocks, and put CSS in `style.css` or theme.json/block styles.
- When HTML/CSS evidence is enough, implement from that evidence. When layout, crop, overlap, or responsive behavior is unclear, open the paired source screenshot and resolve the ambiguity before installing.

This skill is an **orchestrator**, not a generator. The actual theme/pattern/block file generation is delegated to the `creating-themes`, `generating-patterns`, and `creating-blocks` skills. Your job is to:

1. Inventory what archetypes exist in the source.
2. Decide which templates and patterns to build.
3. Drive the WordPress skills with the right inputs per archetype.
4. Install the result into a target.
5. Verify visually and refine.

## Prerequisites

Before you start, confirm these exist in `output/<site>/`:

- `design-foundation.json` — produced by the `design-foundations` skill. Required.
- `palette.json`, `typography.json`, `breakpoints.json` — produced by screenshot aggregation.
- `screenshots/desktop/*.png` (and `.scrolled.png` where present) and `screenshots/mobile/*.png`.
- `html/*.html` — rendered HTML per page.
- `screenshots/manifest.json` — URL → file map.
- `output.wxr` — and optionally `products.jsonl` for Woo sites.

If `design-foundation.json` is missing, **stop and tell the agent to run the `design-foundations` skill first.** Do not proceed with raw aggregates — the foundation does the semantic role assignments you need (`color.accent.primary`, `typography.families.display`, etc.). You'll consume those role names directly when emitting `theme.json`.

If rendered HTML is missing, **stop and tell the agent the screenshot/HTML capture stage was skipped.** Re-run extraction with screenshots enabled. If screenshots are missing but HTML and aggregate token files exist, proceed with the HTML/CSS-first pass and note that visual verification is limited until screenshots are available.

## MCP tool contracts

The following tools are provided by the data-liberation MCP server. Use them rather than reimplementing equivalents in Bash.

### `liberate_replicate_inventory({ outputDir })`

Reads the WXR + products.jsonl + manifest and returns the archetype inventory:

```json
{
  "outputDir": "output/example.com",
  "siteSlug": "example-com",
  "archetypes": {
    "homepage": { "count": 1, "urls": ["https://example.com/"] },
    "page": { "count": 8, "urls": [...] },
    "post": { "count": 14, "urls": [...] },
    "product": { "count": 22, "urls": [...] },
    "gallery": { "count": 0, "urls": [] },
    "event": { "count": 0, "urls": [] }
  },
  "representatives": {
    "homepage": [{ "url": "...", "slug": "...", "screenshot": "...", "html": "...", "htmlBytes": 47821, "wxrItemId": 12 }],
    "page": [{ "url": "...", "slug": "...", "screenshot": "...", "html": "...", "htmlBytes": 38291, "wxrItemId": 7 }, ...],
    ...
  },
  "designFoundationPath": "design-foundation.json",
  "designFoundationExists": true,
  "productCount": 22,
  "hasProducts": true,
  "hasWxr": true,
  "notes": ["No homepage entry in WXR; index.html template will be inferred from other archetypes."]
}
```

`representatives` returns up to 3 URLs per archetype, ranked by rendered HTML byte size (proxy for "more sections"). Use these as the inspection targets in Step 2.

### `liberate_preview({ outputDir, themeFiles?, blockPlugins?, themeSlug?, open?, port? })`

The existing preview tool — extended with optional replica-install params. When you pass `themeFiles[]`/`blockPlugins[]`/`themeSlug`, the tool:

1. Creates (or reuses) a Studio site if Studio CLI is installed; otherwise spins up Playground.
2. Imports `output.wxr` + `products.csv` (using the existing import path).
3. Writes theme files to `wp-content/themes/<themeSlug>/...`.
4. Writes each block plugin to `wp-content/plugins/<slug>/...`.
5. Activates the plugins, then activates the theme.

Param shapes:

```ts
themeFiles: Array<{ relativePath: string, content: string }>   // rooted at theme dir
blockPlugins: Array<{ slug: string, files: Array<{ relativePath, content }> }>  // rooted at plugin dir
themeSlug: string  // e.g. "<siteSlug>-replica"
```

Returns `{ status, url, port, source: "studio" | "playground", warnings[], siteName? }`. Use `url` as the `replicaBaseUrl` for the verify call.

When `themeFiles` is omitted, behaviour matches the legacy `liberate_preview` (default theme, content-only preview).

### `liberate_replicate_verify({ outputDir, replicaBaseUrl, urls, viewports?, outputSubdir?, cdpPort? })`

Captures replica screenshots at the given URL paths against a running replica WP install — at **desktop AND mobile** viewports by default — and pairs each viewport with the matching source screenshot from `screenshots/manifest.json`. Returns a side-by-side manifest you (the agent) read with vision to produce qualitative observations.

```json
{
  "ok": true,
  "outputDir": "...",
  "replicaBaseUrl": "https://example-com-replica.wp.local",
  "capturedAt": "2026-04-29T12:00:00Z",
  "pairs": [
    {
      "urlPath": "/",
      "slug": "homepage",
      "captures": [
        {
          "viewport": "desktop",
          "replicaScreenshot": "replica-screenshots/desktop/homepage.png",
          "sourceScreenshot": "screenshots/desktop/homepage.png",
          "httpStatus": 200,
          "errors": []
        },
        {
          "viewport": "mobile",
          "replicaScreenshot": "replica-screenshots/mobile/homepage.png",
          "sourceScreenshot": "screenshots/mobile/homepage.png",
          "httpStatus": 200,
          "errors": []
        }
      ]
    }
  ],
  "unmatchedUrls": [],
  "errors": []
}
```

**This tool does NOT compute palette/typography/structural scores.** It does the deterministic part — capture both viewports + pair — and hands the perceptual judgement to you. Read each pair of PNGs (you have vision), compare, and produce the per-URL observations yourself. Mobile comparison catches breakpoints/layout-stack drift that desktop misses; do not skip it unless the source had no mobile capture.

Replica screenshots land at `<outputDir>/<outputSubdir>/<viewport>/<slug>.png` (default subdir `replica-screenshots/`) — same shape as the source. Pass `viewports: ["desktop"]` to skip mobile when iterating fast.

If verification fails (low fidelity, structural drift), iterate on the theme files, call `liberate_preview` again with the updated bundle, and re-verify. Cap at 3 iterations per URL.

## Process

### Step 1 — Inventory

Call `liberate_replicate_inventory(outputDir)`. Read the result.

**Decide which archetypes to support** based on `count`:
- Always: any archetype with `count > 0`.
- Skip silently: any archetype with `count === 0` — no template needed.
- For `count >= 5`, the archetype is "primary" — invest in dedicated templates/patterns and a verification pass.
- For `1 <= count < 5`, the archetype is "minor" — still match the observed source layout. You may use core blocks without custom patterns, but do not fall back to a generic page shell when the source shows a distinct layout.

Always include `homepage` even if absent — it's the user-facing landing template.

### Step 2 — Inspect representatives

For each archetype, **read the rendered HTML first** for every representative. HTML tells you the actual content blocks, DOM boundaries, source chrome, CSS hooks, inline styles, image usage, and section structure. Treat this like Telex's selected-design reference: translate the source markup and tokens into a complete block theme.

Do **not** open screenshots by default during a theme-piece pass. Open a screenshot only when HTML/CSS/token evidence cannot answer a specific visual question, such as overlapping composition, exact image crop, post-fold section order, or mobile stacking. If you open one, state what ambiguity it resolved. Verification still uses screenshots after install.

When you read the HTML, identify: `<header>`, `<footer>`, `<main>` boundaries; hero containers; product card markup; navigation structure. The `<style>` blocks and inline styles are evidence for source styling decisions, not output you should copy into block markup — theme CSS belongs in `style.css` and role tokens belong in theme.json/block styles.

### Step 3 — Detect target

Decide the install target in this order:

1. **Studio** — call `studio --version` via Bash. If it succeeds, parse `~/Library/Application Support/Studio/appdata-v1.json` (already done deterministically by `liberate_replicate_install` with `target: { kind: "studio", siteId: "auto" }`). The skill should prefer `kind: "studio", siteId: "auto"` and let the MCP tool either pick the matching site or create one named `<siteSlug>-replica`.
2. **Playground** — only if `_noStudio` was forced, or Studio CLI is missing. Use the Playground server already running at `output/<site>/playground/blueprint.studio.json`'s implied port.
3. **Zip** — if neither is available, package as `output/<site>/<siteSlug>-replica.zip`.

The agent should not have to choose; the MCP tool decides. Pass `target: { kind: "auto" }` when in doubt.

### Step 4 — Compose the theme

For each step below, **delegate to the right WordPress skill** by reading its SKILL.md and following its conventions exactly. Do not duplicate that skill's content here.

In the streaming watch loop, the runner may ask for a single installable checkpoint instead of the whole theme. Respect the `themePiece` input exactly:

- `foundation`: emit only `style.css`, `theme.json`, `functions.php`, and minimum activation templates if missing.
- `header`: emit only `parts/header.html` and header-specific support files.
- `footer`: emit only `parts/footer.html` and footer-specific support files. Footer link groups must be editable `wp:navigation` blocks with explicit `wp:navigation-link` children, not plain linked lists.
- `homepage`: emit only `templates/index.html` and homepage patterns/assets.

For `header`, `footer`, and `homepage` checkpoints, read `base-theme-brief.md` first when present. It is the shared coordination artifact for parallel workers: theme slug, evidence paths, source-parity rules, token snapshot, and file ownership.

For a theme-piece pass, do not re-emit unrelated files from earlier or later checkpoints. The next checkpoint will install its own files.

Across every checkpoint: do not emit Custom HTML blocks (`core/html` / `wp:html`). Use existing WordPress core blocks first. If core blocks cannot represent a real source component, create a theme-embedded custom block under `blocks/<slug>/` using Step 4d. Put CSS in `style.css` or theme.json/block styles, not `<style>` tags or inline `style` attributes inside templates, parts, patterns, or post content.

#### 4a. theme.json

Map `design-foundation.json` directly to `theme.json` v3 settings:

- `color.surface.*` → `settings.color.palette` entries with slugs `surface-base`, `surface-raised`, `surface-inverse`.
- `color.text.*` → palette entries with slugs `text-default`, `text-muted`, `text-subtle`, `text-inverse`.
- `color.accent.*` → palette entries with slugs `accent-primary`, `accent-warning`, `accent-warm`, `accent-highlight`.
- `color.border.*` → palette entries with slugs `border-default`, `border-subtle`.
- `typography.families.body` → `settings.typography.fontFamilies[0]`.
- `typography.families.display` → `settings.typography.fontFamilies[1]` (omit if `null` in foundation — do NOT hallucinate a serif).
- `typography.families.mono` → `settings.typography.fontFamilies[2]` (omit if `null`).
- `breakpoints.lg` → `settings.layout.contentSize`. `breakpoints.xl` → `settings.layout.wideSize`.
- `components.*` → `styles.blocks.core/*` overrides for button, paragraph (text), separator (divider), etc.

Do not set `settings.spacing.spacingScale.theme` to `false`. WordPress merges spacing scales by origin internally and that value can fatal during theme activation. If you provide explicit `settings.spacing.spacingSizes`, omit `settings.spacing.spacingScale` entirely.

Load the `creating-themes` skill for the rest (style.css header, functions.php, FSE setup).

#### 4b. Templates per archetype

Build one block template per archetype actually present:

| Archetype | Template | Notes |
|---|---|---|
| `homepage` | `templates/index.html` | Composes the hero, feature, and CTA patterns. **Always create.** |
| `page` | `templates/page.html` | Generic page template — content + sidebar/none. Used for "About", "Contact", static pages. |
| `post` | `templates/single.html` | Single post layout — title, meta, content, related posts. |
| `product` | `templates/single-product.html` | Woo single-product (delegate to Woo's template hierarchy if Woo is installed; otherwise use a custom layout). Plus `templates/archive-product.html` for the shop page if `count >= 5`. |
| `gallery` | `templates/page-gallery.html` | Optional. Only build if archetype is primary. |
| `event` | `templates/single-event.html` | Optional. Only build if archetype is primary. |

Read `references/archetypes.md` for the per-archetype detail (what blocks to include, how to handle Woo, query loop wiring, etc.).

#### 4c. Patterns — pick-tweak-create against the library

**Use the curated library at `skills/replicate/references/patterns/` as your starting point. Generating patterns from scratch is the last resort, not the first move.**

Workflow:

1. **Read `references/patterns/_manifest.json` first.** It's a small JSON listing all 27 patterns with category, archetype fit, and a one-line description. Cheap text — scan it BEFORE opening any individual `.php` file.

2. **For each reusable section observed in the source HTML/CSS evidence, pick the closest library match.**
   - "Hero with image on the left, text + CTA on right" → `hero-split.php`
   - "Three feature columns with icon + heading + body" → `features-grid-3.php`
   - "Customer quote band on dark background" → `testimonial-single.php`
   - "Footer with three link columns + copyright" → `footer-columns.php`
   - …and so on. The manifest's `archetypes` array maps each pattern to which archetypes typically use it.

3. **Tweak the picked pattern until it matches the source section** — copy the file body to your theme's `patterns/<name>.php`, then:
   - Replace slot placeholders (`{{HEADLINE}}`, `{{SUBHEAD}}`, `{{ITEM_N_HEADING}}`, etc.) with text drawn from the source HTML. **Never invent copy** — the slot is for source content, not your imagination.
   - Adjust the foundation token slugs if a different role fits the source's visual treatment (e.g. swap `accent-primary` for `accent-warm` if the section uses the warm-tone variant).
   - Drop unused repeating items (e.g. a 3-column feature grid → 2-column by removing one `<wp:column>` block) or duplicate them when the source has more.
   - Adjust spacing scale slugs (`spacing--40` → `spacing--60`) to match the source's section padding.
   - Update the pattern header (`Title:`, `Slug:`, `Description:`) to use your theme's slug.

4. **Create from scratch ONLY when nothing in the library is a workable starting point.** Signals that a fresh pattern is justified: a unique interactive widget, a layout the library doesn't cover (e.g. a vertically-stacked feature timeline, a non-standard hero shape). When you do create one, follow the same conventions: token slugs (no hex), slot placeholders, archetype tag in the header.

**Header / footer patterns are template-PART variants.** Patterns in the `header` and `footer` categories (`header-cta`, `header-simple`, `footer-columns`, `footer-minimal`) override `parts/header.html` / `parts/footer.html` — copy their body block-markup to those paths in `themeFiles[]`, NOT to `patterns/`. The scaffold ships baseline `parts/header.html` + `parts/footer.html`; you upgrade them when the source has a richer chrome. Header and footer link groups must use editable `wp:navigation` blocks with explicit `wp:navigation-link` children.

**Each chosen pattern must be grounded in source evidence** — note in the pattern's `Description:` header which HTML file and, when used, screenshot it derives from (e.g., `Source: html/homepage.html hero section; verified against screenshots/desktop/homepage.png`). This is the audit trail.

**Each pattern must use design tokens** — never inline raw hex. Prefer block slug attributes (`backgroundColor`, `textColor`) and registered className styles. If additional CSS is needed, add a semantic class to the block markup and include the CSS in `style.css`. The library is already token-clean; if you regenerate, hold the same standard.

Do not use a Custom HTML block to carry pattern markup or CSS. If a picked library pattern needs additional styling, add a semantic class to the relevant core block and include the CSS in `style.css`.

#### 4d. Custom blocks (only when needed)

Default to **no custom blocks**. Reach for `creating-blocks` only when:
- The source site has an interactive component that can't be expressed with a core block + `wp:details`, `wp:cover`, `wp:columns`, `wp:navigation`, etc.
- Examples that justify a custom block: a sticky multi-step form, a custom carousel with platform-specific transitions, a non-standard pricing comparison table with toggles.
- Examples that don't: a 3-column feature grid (use `wp:columns`), an FAQ accordion (use `wp:details`), a hero with image + text overlay (use `wp:cover`).

**Use both screenshot AND HTML to decide.** Vision alone misses interactive intent (a "calculator" that's actually three static columns); HTML alone misses platform-rendered visuals (a fancy carousel built from JS that left no `<form>` or `<input>` behind). Look at:

| Source | Signal that argues FOR a custom block |
|---|---|
| **HTML** | `<form>` with non-trivial fields (multi-step, conditional, validation hints), `<input type="range">` / `<input type="date">`, `<select>` with computed options, `<dialog>`, `data-component="..."` / `data-widget="..."` attrs left by the source platform's renderer, `<script src=".../calculator.js">`-style remnants pre-sanitization |
| **Screenshot** | Numeric/date pickers visible in the UI, slider thumbs, "Step 1 of 3" indicators, "Calculate" / "Configure" / "Build your own" CTAs, before/after split handles, live total / price summaries, RSVP / availability widgets |

If the screenshot shows interactivity but the HTML is empty (or vice versa), prefer **core blocks + a sensible static fallback** over inventing a custom block — the source's interactivity didn't survive extraction, and a plausible-looking but non-functional custom block is worse than honest static content. The user can request a custom block explicitly later.

If both signals converge on the same interactive feature, then proceed with the custom block.

When a custom block is justified, **embed it inside the theme**, not as a separate plugin. Mirror Telex's "Using Blocks in Themes" pattern (see `../telex/server/prompts/guides/blocks-inside-themes.md`):

- Block source lives at `blocks/<slug>/src/`. Required files: `block.json`, `index.js`, `edit.js`, plus `save.js` (static) **or** `render.php` (dynamic). Optional: `view.js`, `style.scss`, `editor.scss`.
- Use the `<siteSlug>-replica` namespace (e.g. `getsnooz-com-replica/sticky-form`), not `telex/`.
- Set `"supports": { "html": false }` and `"apiVersion": 3`.
- Frontend interactivity is plain JS in `view.js` — never the Interactivity API.

**Streaming-mode constraint — emit pre-built artifacts.** The streaming watch loop has no `wp-scripts build` step; whatever the agent emits is what runs. So in addition to `blocks/<slug>/src/`, emit a flattened `blocks/<slug>/build/` containing `block.json`, `index.js`, `index.asset.php` (with the dependency stub), and `render.php` if dynamic. The build files mirror what wp-scripts would produce — no minification, no bundle splitting, no source maps. Keep `src/` for editability and as the source of truth; the runtime registers from `build/`.

Theme `functions.php` registers each block from its `build/` dir:

```php
add_action( 'init', function () {
    foreach ( glob( get_theme_file_path( 'blocks/*/build' ) ) as $build_dir ) {
        register_block_type( $build_dir );
    }
} );
```

A minimal `index.asset.php` looks like `<?php return array( 'dependencies' => array( 'wp-blocks', 'wp-element', 'wp-block-editor' ), 'version' => '1.0.0' );`.

### Step 5 — Install

Assemble the file list as a single in-memory array — the install path receives content directly, no on-disk staging.

```ts
themeFiles: [
  { relativePath: "style.css", content: "/* Theme Name: ... */" },
  { relativePath: "theme.json", content: "..." },
  { relativePath: "functions.php", content: "<?php ..." },
  { relativePath: "templates/index.html", content: "<!-- wp:... -->" },
  { relativePath: "templates/<archetype>.html", content: "..." },  // per archetype
  { relativePath: "parts/header.html", content: "..." },
  { relativePath: "parts/footer.html", content: "..." },
  { relativePath: "patterns/<name>.php", content: "<?php /** Title: ... */ ?>..." },
  { relativePath: "assets/...", content: "..." },  // optional, generated images

  // Custom blocks (rare): both src/ and build/ are emitted via themeFiles[].
  { relativePath: "blocks/<slug>/src/block.json", content: "..." },
  { relativePath: "blocks/<slug>/src/index.js", content: "..." },
  { relativePath: "blocks/<slug>/src/edit.js", content: "..." },
  { relativePath: "blocks/<slug>/src/render.php", content: "<?php ..." },
  { relativePath: "blocks/<slug>/build/block.json", content: "..." },
  { relativePath: "blocks/<slug>/build/index.js", content: "..." },
  { relativePath: "blocks/<slug>/build/index.asset.php", content: "<?php return array(...);" },
  { relativePath: "blocks/<slug>/build/render.php", content: "<?php ..." },
]
```

**Install path differs by context:**

- **Streaming watch loop** (`liberate <url>`): the runner has a pre-started Studio site. Call `liberate_install_theme` with `{ outputDir, studioSitePath, themeFiles, themeSlug }` using the exact `themeSlug` value supplied in the runner prompt. That slug points at the shell theme the runner already created, so your files overwrite the existing shell theme. Do not derive another slug from `inventory.siteSlug` or strip `www`. The tool writes files into the running site and activates the theme — no site creation, no content import, no per-call duplicate site.
- **Standalone replicate** (no streaming): call `liberate_preview` with `{ outputDir, themeFiles, themeSlug: "<siteSlug>-replica" }`. This creates (or reuses) a Studio/Playground site and imports content from output.wxr in addition to writing the theme.

When the runner supplies `themePiece`, successful install completes only that checkpoint. Do not wait to generate header/footer/homepage in one response unless that is the requested checkpoint.

Verify the response: `themeWritten > 0` and `warnings` empty. Capture the resulting site URL — you'll need it for verify in Step 6.

### Step 6 — Verify

Call `liberate_replicate_verify` with no `urls` argument (defaults to one per archetype). Read the result.

**For each URL with `score < threshold`:**
- Look at the `issues` list. Most issues are mappable to either a token (color, typography), a layout (column count, alignment), or a missing pattern.
- Read the source screenshot AND the replica screenshot via vision. Diff them mentally.
- Decide whether to:
  - Fix `theme.json` (token mismatch → regenerate)
  - Fix a pattern (layout mismatch → edit pattern PHP, regenerate)
  - Add a missing block (custom-block decision → only if Step 4d criteria met)

**Iterate up to 3 times.** After 3 failed iterations on the same URL, stop and add an `openQuestion` to the result describing what you couldn't resolve. Do not loop forever.

### Step 7 — Return

Return a structured summary to the calling agent:

```json
{
  "siteSlug": "example-com-replica",
  "themeSlug": "example-com-replica",
  "target": { "kind": "studio", "siteId": "...", "url": "https://example-com-replica.wp.local" },
  "archetypes": ["homepage", "page", "post", "product"],
  "patternsCreated": ["hero-split", "feature-grid", "footer", ...],
  "customBlocks": [],
  "verification": { "overallScore": 0.84, "passed": true, "perUrl": [...] },
  "openQuestions": []
}
```

## Decision rules cheat sheet

- **Read HTML/CSS first**, then screenshots only for ambiguity or verification. Rendered source structure is the default ground truth; screenshots resolve visual details the DOM/CSS evidence cannot.
- **Trust `design-foundation.json`** for tokens. Don't reinterpret colors from the palette.
- **Prefer core blocks.** Custom blocks are a tax — they need a plugin, build pipeline, and break in some hosts.
- **Custom HTML is not a fallback.** `core/html` / `wp:html` blocks are rejected; add CSS to `style.css`, use core block markup, or create a real custom block when Step 4d justifies it.
- **One pattern per recurring section, not per page.** A 30-page site does not need 30 patterns. It needs ~6-10 patterns reused across templates.
- **Skip archetypes with `count === 0`** silently. Don't build for hypotheticals.
- **Cap iteration.** 3 verify loops max per URL. If you can't get there, surface an `openQuestion`.

## Anti-patterns

- **Reading the WXR's `<wp:post_content>` and trying to recreate it as blocks.** That's content transformation, not theme replication. The content stays as-is in WXR; the theme just has to render it. Out of scope.
- **Generating a nice generic theme.** A clean generic layout is failure when the source has a different section order, grid, spacing, media treatment, header, footer, or responsive stack.
- **Hallucinating tokens.** If `design-foundation.json` has `typography.families.display: null`, do not invent a serif "to match the vibe." Leave display undefined and the theme falls back to body font.
- **Ignoring representatives.** Reading only the homepage HTML and inferring the rest of the site is how replicas drift from reality. Inspect each archetype's representative HTML.
- **Skipping verification.** A theme that *looks fine* in your head is not the same as a theme that renders the imported content correctly. Always run `liberate_replicate_verify` and act on issues.
- **Custom blocks for layout-only differences.** If the only reason you're reaching for `creating-blocks` is "the columns aren't quite right," edit the pattern instead.
- **Custom HTML for layout or CSS.** If you need CSS, add it to `style.css`. If you need behavior or markup core blocks cannot express, create a theme-embedded custom block. Do not hide raw HTML, CSS, JS, SVG icon sets, forms, or embeds inside `wp:html`.
- **Telex-flavored output.** This is not Telex. Footer credits, plugin namespaces, and author fields should reflect the replica project (`<siteSlug>-replica`), not Telex.

## Reference files

Read these when the relevant decision comes up — they're not all needed every run:

- **`references/archetypes.md`** — per-archetype template requirements (homepage, page, post, product including Woo, gallery, event). Read in Step 4b.
- **`references/targets.md`** — Studio detection, Playground fallback, zip packaging, and how `liberate_replicate_install` decides. Read in Step 3 if `target: "auto"` is not enough.
- **`references/verification.md`** — what the fidelity scores measure, how to interpret issues, when to give up. Read in Step 6 if a verification fails and you're not sure what to do.
- **`references/patterns/_manifest.json`** — index of 27 curated reusable patterns covering hero/features/testimonials/cta/pricing/faq/contact/team/about/gallery/portfolio/posts/products + header/footer template-part variants. Read FIRST in Step 4c. Each pattern is a `.php` file in the same directory using slot placeholders the agent fills from source HTML.

## Example invocation (sketch)

The calling agent says: "Replicate the design for the getsnooz.com extraction at `output/getsnooz.com/`."

1. Call `liberate_replicate_inventory("output/getsnooz.com")`. See: 1 homepage, 22 products, 8 pages, 0 posts.
2. Read homepage screenshot + html. Read 3 product screenshots + html. Read 2 page screenshots + html.
3. Determine target: Studio is available, no existing site matches; will create one.
4. Generate `theme.json` from `design-foundation.json`.
5. Generate `templates/index.html`, `templates/single-product.html`, `templates/archive-product.html`, `templates/page.html`. Skip `single.html` (no posts).
6. Generate patterns: `header`, `footer`, `hero-product`, `product-grid`, `product-card`, `cta-newsletter`.
7. No custom blocks needed — core blocks cover all observed layouts.
8. Call `liberate_replicate_install` with `target: { kind: "auto" }`. Get `themeUrl`.
9. Call `liberate_replicate_verify`. Score 0.81 overall, passes threshold. Two minor issues on product page (CTA color drift, image aspect ratio). Fix the pattern, reinstall, re-verify. Score 0.88. Done.
10. Return summary.
