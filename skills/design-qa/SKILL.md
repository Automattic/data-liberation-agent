---
name: design-qa
description: Visual-QA loop run after replica theme install and content import. Captures replica screenshots, applies a hard responsiveness gate at 390px, runs qualitative vision review of source/replica pairs, checks accessibility, classifies discrepancies A/B/C, applies fixes via editing-themes/editing-blocks, and logs remaining gaps. Orchestration-internal — invoked by the replicate/liberate orchestrators, not directly by users.
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Design QA

You are the visual-QA loop run after the replica theme is installed and content is imported. Your job is to verify that the replica matches the source site, classify every gap, apply fixes, and log what remains. You do not generate theme files from scratch — you drive `editing-themes` and `editing-blocks` for all edits.

Read `skills/design-qa/references/visual-qa.md` for the detailed visual-review procedure before starting.

## Inputs

The orchestrator passes you:

- `replicaBaseUrl` — the running replica WP install URL.
- `outputDir` — e.g. `output/example.com/` (contains source screenshots and manifest).
- `archetypeReps` — map of archetype → representative URL paths (one per archetype, from `liberate_replicate_inventory`).

## Workflow

### Step 1 — Capture replica screenshots

Call `liberate_replicate_verify` with `replicaBaseUrl`, `outputDir`, and the representative URL paths from `archetypeReps`. Use the default viewports (desktop + mobile). The tool captures replica screenshots and pairs each with the matching source screenshot from `screenshots/manifest.json`.

```ts
liberate_replicate_verify({
  outputDir,
  replicaBaseUrl,
  urls: Object.values(archetypeReps),
  outputSubdir: "replica-screenshots"
})
```

Read the returned `pairs[]` manifest. You will use the paired PNGs for both the responsiveness gate and the qualitative review.

### Step 2 — Responsiveness gate (HARD)

For each captured mobile pair, evaluate responsiveness using the `evaluateResponsive` helper from `src/lib/replicate/responsive-check.ts`. The gate checks two conditions at 390px viewport width:

- **No horizontal overflow:** `scrollWidth <= viewportWidth` — the page must not extend beyond the viewport.
- **Sections reflow:** `sectionsReflowed >= sectionsTotal` — every section must have stacked vertically (single-column) at mobile width.

A fail on either condition is a **hard block** — do not continue to qualitative review or acceptance. Apply responsive CSS fixes via `editing-themes`, then re-capture (return to Step 1). If the gate still fails after 3 fix attempts, stop, log the failure to `theme/notes.md` and `run-report.json`, and report to the orchestrator without accepting.

### Step 3 — Qualitative review

Once the responsiveness gate passes, read each source/replica screenshot pair with vision — desktop and mobile — for every archetype representative. Produce per-URL observations:

- Section order match
- Header/footer structure and nav labels
- Hero content, image crops, CTA placement and color
- Column counts, spacing rhythm, alignment
- Typography (family, weight, size, color) fidelity
- Mobile stacking behavior

The pixel-diff score from `liberate_compare` (or `diff-pngs`) is a **signal** to direct your attention — it is not the acceptance gate. Qualitative vision review is the gate.

### Step 4 — Accessibility checks (warn, not block)

For each representative page, flag the following in the run-report. Do **not** hard-fail or auto-fix — faithfulness to the source wins.

- **Contrast:** text/background pairs below WCAG AA (4.5:1). Check the palette entries from `design-foundation.json` against the source rendering. Log each failing pair as a warning.
- **Alt text:** images with missing or empty `alt` attributes. Carry the source's alt verbatim; flag any that are absent for human fill — never generate alt copy.

Add all flags to the run-report under `a11yWarnings[]`.

### Step 5 — Classify discrepancies

For each visual gap identified in Step 3, classify:

| Class | Meaning | Action |
|---|---|---|
| **A** | Spec wrong — the section spec or captured content is incorrect | Re-extract that section spec; do not fix the theme |
| **B** | Template dropped info — the pattern or template didn't carry through content that was in the spec | Fix section-mapping or regenerate the affected pattern |
| **C** | WP renders differently — a core-block or WP rendering constraint, not a theme authoring error | Log to `theme/notes.md`; no fix |

Produce a structured list: `{ urlPath, class, description, action }`.

### Step 6 — Apply fixes

For Class B discrepancies, load the appropriate editing skill and apply fixes:

- **Theme JSON / CSS issues** → load `editing-themes`
- **Block markup / pattern issues** → load `editing-blocks`
- **Custom block logic** → load `editing-blocks` (or `creating-blocks` only if core blocks cannot express the component)

After applying fixes, reinstall the updated theme files via the orchestrator's install path and return to Step 1 to re-capture.

### Step 7 — Budget and logging

**Budget: 3 iterations per archetype representative.** After 3 iterations, stop regardless of remaining gaps:

1. Log all unresolved Class A and B gaps to `theme/notes.md`.
2. Log Class C constraints to `theme/notes.md`.
3. Add all items to `run-report.json` under `qaGaps[]`.
4. Return the final QA result to the orchestrator.

Do not loop beyond 3 iterations. Remaining gaps are surfaced for human review, not silently accepted or retried.

## Output contract

Return to the orchestrator:

```json
{
  "passed": true,
  "iterations": 2,
  "perUrl": [
    {
      "urlPath": "/",
      "archetype": "homepage",
      "responsiveness": { "passed": true },
      "qualitative": "Hero image crop matches. CTA color drifted (Class B, fixed iter 1). Footer link order correct.",
      "a11yWarnings": [],
      "gaps": []
    }
  ],
  "a11yWarnings": [],
  "qaGaps": [],
  "notesPath": "output/example.com/theme/notes.md"
}
```

`passed` is `true` only when the responsiveness gate passes for all archetypes. Qualitative gaps do not set `passed: false` — they are surfaced in `qaGaps[]`.

## Rules

- The responsiveness gate is the only hard pass/fail. Everything else classifies and logs.
- Never auto-fix accessibility issues — flag and move on.
- Never accept a result that failed the responsiveness gate.
- Never generate net-new theme structure — drive `editing-themes` and `editing-blocks` for all modifications.
- Cap at 3 iterations per representative. Surface remaining gaps; do not loop forever.
