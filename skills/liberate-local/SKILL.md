---
name: liberate-local
description: Front door for OWNED LOCAL static sites — point it at a directory of hand-authored / Claude-generated HTML+CSS+JS and it stands up a fresh WordPress Studio site and converts the source into a native block theme + live editable pages, carrying the source's own CSS/JS for identical parity. The local-source analog of /liberate: no extraction (the source is already on disk), no platform detection — it provisions the Studio target itself (studio site create), processes the HTML/CSS/JS, then builds the theme and the site. One command drives everything. Use when the user has a local folder of static-site files (not a live URL) they want as a real WordPress site.
---

# Liberate a local static site

The single front door for the **owned local-source** path: a directory of HTML/CSS/JS → a live WordPress Studio site running a native block theme that carries the source's own design. Unlike `/liberate` (which detects a remote platform and extracts over the network), this path has the source on disk already, so it skips detect/discover/extract entirely and goes straight to: **provision the Studio site → process the source → build the theme + pages → capture → parity compare → deterministic repair.**

`liberate_convert_local_site` is the one command that drives all of it (with `createSite: true` it provisions the Studio target too). This skill is the thin front door that resolves inputs, runs that command, and reports.

---

## Pipeline overview

```
/liberate-local <source-dir>
│
├─ resolve inputs: source dir · site name · theme slug · Studio site path · output dir
│
└─ liberate_convert_local_site({ dir, studioSitePath, createSite:true, … })  ── one command, drives everything:
      1 createSite      studio site create (fresh WP+SQLite, started)  — skipped if the site already exists (idempotent)
      2 ingest          source HTML → native block sidecars (roundtrip-validated) + per-instance lib-i styles
      3 block-fixer     canonicalize each page through @wordpress/blocks (editor-valid markup)
      4 design capture  serve source over HTTP → palette/typography/breakpoints + self-host Google fonts
      5 theme assemble  block theme: nav from the graph, footer, no-title page templates, carried source.css/js + instance-styles.css (+ add_editor_style)
      6 install         write + activate the theme; create WP Pages from sidecars (idempotent via _source_url); front page; page template
      7 compare         capture the WP replica (desktop+mobile) and score parity vs the source
      8 repair          deterministic parity loop: diff → computed-style probe → parity-patch.css → re-compare (bounded, no AI)
```

There is no path checkpoint (unlike `/liberate`): the owned-local path is always carry-to-block-theme — the source IS the design authority. The only decision is the optional editor-fidelity surface (below).

---

## Step-by-step

### Step 0 — Resolve inputs

Ask for the **source directory** if not given. Then derive (let the operator override any):

- `dir` — the absolute source directory (HTML/CSS/JS).
- `themeSlug` — kebab-case, e.g. `basename(dir)` → `maison-clouet`.
- `siteTitle` — the home page `<title>`, or a name the operator gives.
- `studioSitePath` — `~/Studio/<slug>` for a fresh site (must NOT collide with an existing unrelated site unless you intend to reuse it). Confirm the chosen path with the operator before creating.
- `outputDir` — liberation artifacts (sidecars, reports, screenshots). Default `~/Studio/_liberations/<slug>` or a run-local dir.

### Step 1 — Convert (one command)

Call `liberate_convert_local_site` with `createSite: true`:

```
liberate_convert_local_site({
  dir:            "<source-dir>",
  studioSitePath: "~/Studio/<slug>",
  outputDir:      "<output-dir>",
  themeSlug:      "<slug>",
  siteTitle:      "<title>",
  createSite:     true,     // provision the Studio site if it doesn't exist (idempotent)
})
```

- **createSite** runs `studio site create` only when no WP install exists at `studioSitePath` — a re-run reuses the site (and re-converts idempotently). Admin creds come from env `WP_ADMIN_USER` / `WP_ADMIN_PASS`; omit them and Studio auto-generates (fine for convert-only).
- **carryCss / carryJs** default ON — the source's own stylesheet + scripts are carried into the theme (the parity mechanism). Pass `false` for a tokens-only theme.
- **nativeBehaviors** (opt-in) swaps carried JS for native Interactivity blocks (reveal/sticky/tabs/slider/modal); unmapped behaviors land in `behavior-gaps.json`. Default OFF (maintain the source JS).
- **editorSurface** (opt-in) also scores each page in the live block editor canvas — needs `WP_ADMIN_PASS` in env; warn-only for carry (it does not flip the verdict).

Narrate progress. On `isError`, surface the message (a missing source dir, a Studio create failure, a roundtrip/compose failure per page) and stop.

### Step 2 — Report

From the handler summary + `parity-report.json` in the output dir, report:

- the Studio site (created vs reused) + its live URL,
- pages composed / failed / empty + low-confidence count,
- **parity**: per-page desktop/mobile scores, the averages, `allPass`, and repair rounds/converged,
- any warnings (carried-asset notes, sticky-not-carried, behavior gaps).

Honest visual assessment: itemize real differences; do not oversell a match (see the match-section skill's anti-gaming rules if doing a polish pass).

---

## Idempotency & resume

Re-running `/liberate-local <dir>` on the same `studioSitePath`:

- **skips** site creation (the site exists),
- re-ingests + re-converts deterministically,
- re-installs pages by `_source_url` (no duplicates),
- re-runs the parity loop.

To start completely fresh, point at a new `studioSitePath` (or delete the old site via `studio site delete`).

---

## Notes

- This path needs **Studio installed** and the `studio` CLI on PATH (`studio site create` provisions WP + SQLite and starts the site on a Studio-assigned port; the convert auto-resolves the live URL via `wp option get siteurl`).
- The source is trusted (owned). There is no platform adapter, no network extraction, no products path — it's structure + design carry.
- The theme is a real block theme: pages are block-editable, the carried CSS is the design authority, and per-instance source styles ride fixer-safe `lib-i` classes (so editor saves don't drop them). Carried CSS is also loaded into the editor canvas (`add_editor_style`).
