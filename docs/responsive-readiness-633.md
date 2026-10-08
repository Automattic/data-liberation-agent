# Responsive readiness evidence — #633

Source: <https://altrum-template.webflow.io/> and
<https://altrum-template.webflow.io/project/forma-digital>.
Baseline: `origin/main` at `dbd924bcceb4dcd090d83d5e7bcf5ea944604161`
(v0.20.2), fetched and verified before editing. This attempt used an isolated
Homeboy Lab worktree. The v0.19.10 measurements in the issue are motivation,
not the baseline below.

Environment: Node v24.18.0, Playwright 1.61.1, Chromium 149.0.7827.55.
Homeboy attempt ID: `agent-task-dad91361-a53e-4011-9f13-5d00017bafce-attempt-1-912743c3`.

## Contract and evidence boundary

- **Resize/rest scheduling:** the existing private `waitForRestGeometry` owns
  lazy scrolling, the minimum resize observation window, and four equal reads
  at 250ms intervals. The minimum window overlaps observations instead of
  preceding them. The original rest allowance remains available. This changes
  scheduling within the existing source-learning primitive, not the width
  ladder, fitting, document identities, or comparison scheduling.
- **Rest observations:** numeric learnable inline declarations, pixel custom
  properties, relevant parent dimensions, inset/position, tagged role IDs, and
  complete transform state replace whole-inline-style snapshots. Color and
  unitless paint variables do not restart the geometry clock. Scale/rotation
  changes still invalidate rest; final source-transform validation remains in
  its existing owner. Browser fixtures verify finite delayed writes and the
  restored non-translation matrix.
- **Lazy work:** each overflowing width still receives a sweep. Only observed
  absence of overflow skips traversal; no generic inference that all source
  JavaScript has finished is made from loaded images. Newly introduced DOM,
  image references, image layout presence, or uncovered document height trigger
  another sweep within the bounded readiness window. Native lazy images with
  no layout rectangles cannot be reached at that width and do not spend its
  image budget; a later reveal invalidates the observation. The delayed fixture
  introduces images after resize and intercepts their requests with a 500ms
  response delay. It checks natural size, learned width, at-top padding,
  viewport restoration and temporary-identity cleanup.
- **Bounds/lifecycle:** lazy traversal uses the existing 20-second lazy-work
  budget convention and `withEvaluateTimeout`. Baseline restoration,
  reconciliation, clone roles, source controls, image decoding in the capture
  pipeline, cleanup, device-profile selection and frozen-reference ownership
  retain their existing owners. Readiness is a bounded observation, not a
  guarantee about arbitrary source timers after that window.

The meaningful verification capability here is Chromium execution of the same
neutral source fixtures, live primitive diagnostics, fresh full-source capture,
and the existing frozen gate. None of these observations substitutes for the
controller-owned final suite/build/installed-package gates.

## Neutral immutable fixtures

Fixture source: `src/lib/screenshot/fluid-readiness.test.ts`, SHA-256
`dd95651d963533f1040fb8a775a358a679cec83fd3b6772f88f6f794cb7b8b38`.
The exact same file was run against baseline and candidate implementations.

| Fixture | Baseline | Candidate | Observation |
| --- | ---: | ---: | --- |
| Perpetual color/unitless paint writes; hidden lazy image | 19.168s | 5.229s | Baseline fails the generous 7s regression budget; candidate passes with the same learning result and checked 720px width. |
| Delayed resize-created lazy image and delayed top-state padding | 9.401s | 7.660s | Both retain loaded 40px intrinsic image, 720px learned width, 20px at-top padding, original viewport and cleanup. |
| Delayed genuine transform at restoration | 6.803s | 5.379s | Both retain the restored scaled matrix. These two numbers are test durations, including fixture setup/cleanup. |

Command (both source checkouts):

```sh
npx vitest run src/lib/screenshot/fluid-readiness.test.ts --reporter=verbose
```

Artifacts: `633-neutral-final-baseline.log` (expected exit 1, one new contract
failure) and `readiness-final-focused.log` (candidate owning regressions).

## Same live route and options

```sh
node --import tsx scripts/benchmark-responsive-readiness.ts
```

The diagnostic prepares the source with the existing overlay/lazy primitives,
then learns every default width with `settleMs: 1000` in a fresh browser page at
each starting viewport (900px height). It prints each width's progress and
retains total preparation/learning times, learning outcomes, text, image
selection/completeness/natural width and landmark rectangles. This is a
viewport-based primitive diagnostic, not a substitute for source device-profile
capture or a frozen-fidelity verdict.

| Starting viewport | Baseline learning | Candidate learning | Reduction |
| --- | ---: | ---: | ---: |
| 390 | 60.933s | 39.785s | 34.7% |
| 768 | 59.888s | 38.325s | 36.0% |
| 1440 | 60.490s | 35.393s | 41.5% |

All three pairs have equal learning results, text, and final image records.
The seven checked heading rectangles at each starting viewport have zero
maximum coordinate/size delta. Both sides finish at scroll Y=0. These are
bounded checked observations, not a claim of visual parity for every node or
state. Artifacts: `readiness-baseline.log` and `readiness-final.log`.

An intermediate candidate incorrectly waited for hidden native lazy images and
regressed the mobile diagnostic to 70.9s. `readiness-diagnostic.log` showed their
absent layout rectangles. The final visibility-aware contract above fixes that
regression; the hidden-image neutral fixture protects it.

## Fresh capture and frozen comparison

Both source checkouts use the same source/options, default learning enabled,
screenshots disabled, no resume:

```sh
node --import tsx src/cli.ts https://altrum-template.webflow.io/ --output ./artifacts/633-baseline
node --import tsx src/cli.ts https://altrum-template.webflow.io/ --output ./artifacts/633-candidate
node --import tsx src/cli.ts compare artifacts/633-baseline/altrum-template.webflow.io
node --import tsx src/cli.ts compare artifacts/633-candidate/altrum-template.webflow.io
```

Long commands run as detached, polled subprocesses with progress logs and exit
status preserved. The initial candidate capture failed before discovery on an
HTTP connection timeout; its retry uses identical options. Timings are
single-run Lab observations with shared-host/network variability, not an
authoritative microbenchmark or final deterministic gate.

| Phase | Baseline | Candidate |
| --- | ---: | ---: |
| Discovery | 0.853s | 0.893s |
| Browser capture | 597.098s | 435.153s |
| Section media | 1.866s | 1.915s |
| Export | 3.854s | 2.482s |
| Homepage preview | 5.369s | 5.238s |
| Sum of reported phases | 609.040s | 445.681s |
| Forma Digital route (included in browser phase) | 206.591s | 154.860s |

Browser capture improved by 161.945s (27.1%); the sum of reported phases
improved by 163.359s (26.8%). Route times overlap through existing capture
concurrency and must not be added to the phase sum. The homepage route improved
only 401.885s → 397.667s, showing that source learning is not its only cost.
Both runs retained 13/13 discovered routes, with zero route failures and 88
downloaded media items. Both remain **incomplete**: 16 same-origin links point
to the same two undiscovered targets, `/template-info/licensing` and
`/post/why-great-brands-are-built-on-clarity-not-complexity`. Discovery scope is
unchanged; #581's candidate was not incorporated. Capture diagnostics also
retain network/dependency failures, so successful capture exit 0 is not a
fidelity pass.

The source-profile files are byte-identical (SHA-256
`c87121b896abacda01005792edca9dd18387694aeb9c62310cd38bc45ca6e844`):
single assembled variant, mixed geometry, detected switch width 991, 368
applied / 915 frozen observations, 13 routes and 26 learned source documents.
Both portable-media summaries admit 84 files / 6,389,408 bytes with zero
retained external media. Resource-fetch failures vary (9 baseline / 16
candidate), as do unresolved dependencies (7 / 15); this attempt does not
establish complete asset fidelity beyond its checked records and admitted-media
summary.

### Frozen verdicts (existing gate, unchanged scheduling)

| Result | Baseline | Candidate |
| --- | ---: | ---: |
| Overall status | `unproven` | `unproven` |
| Compare exit | 1 | 1 |
| Required / measured cells | 39 / 24 | 39 / 24 |
| Measured failing / passing cells | 24 / 0 | 24 / 0 |
| Pending cells | 15 | 15 |
| Offline routes / findings | 13 / 0 | 13 / 0 |

The complete 39-cell `(route, profile, viewport, state, outcome)` matrix is
identical, including pending reasons. Desktop coverage remains 16 measured /
10 pending out of 26; mobile remains 8 measured / 5 pending out of 13.
The reference widths remain 390/768/1440. Both gates exclude dialogs, zoom and
motion and retain their existing bounded-readiness unknowns.

Baseline already has text, image-geometry, typography and overflow failures;
the candidate is not visually certified. Repeated image correspondence is
ambiguous on contact and the four project routes. In particular, **Forma
Digital remains unproven at all three reference widths on both versions**.
The primitive's equal checked geometry/assets/text must not be promoted into
a frozen-fidelity pass. Approximate comparison log lifetimes were 518.6s /
500.7s; comparison scheduling was not changed and no comparison speed claim
is made from those single-run observations.

Artifacts: `633-compare-baseline.log`, `633-compare-candidate.log`, and each
run's `compare/capture/report.json`.

Artifacts: `633-baseline.log`, `633-candidate.log` (initial pre-discovery
network failure), `633-candidate-retry.log`, and the two run trees
`633-baseline/altrum-template.webflow.io` / `633-candidate/altrum-template.webflow.io`.

Focused observation command:

```sh
npx vitest run src/lib/screenshot/fluid-readiness.test.ts src/lib/screenshot/fluid-baseline.test.ts src/lib/screenshot/mobile-fluid-capture.test.ts src/lib/screenshot/fluid-capture.test.ts --reporter=verbose
npx tsc --noEmit
git diff --check
```

The four focused browser files completed with **40 passing tests** (284.08s).
Type checking and patch whitespace checks also passed. These are provider
observations, not the controller's final gate results.

## Disclosure

OpenAI `gpt-6.1-sol` through OpenCode performed source inspection, manual
`apply_patch` edits, Chromium regressions and diagnostics, and source capture/
comparison observations under Homeboy. Chris Huber authorized this scoped
performance refactor. Full suite, build, Chromium installation and installed-
package checks belong to the controller after harvest. Generated `dist/` is
unchanged. #634, #635, #581 and comparison scheduling (#632) are separate work.
