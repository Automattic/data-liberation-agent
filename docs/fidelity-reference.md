# Reproducible fidelity stages

`captureWebsite` writes `fidelity-reference.json` alongside the receipt. It observes
the **existing cleaned live capture session**, without reloading the source, before
fluid geometry rewriting/HTML serialization. Each captured route is observed at
390 (mobile context), 768 and 1440 CSS pixels, height 900, in `baseline` state.
Reference PNGs are always recorded, even without optional full-page screenshots.

## Public API

```ts
import { captureWebsite, checkFidelity } from 'data-liberation';

await captureWebsite({ url, outputDir });
const capture = await checkFidelity({ directory: outputDir });
const materialization = await checkFidelity({ directory: outputDir, candidateUrl });
const drift = await checkFidelity({ directory: outputDir, stage: 'drift' });
```

`checkFidelity(options: FidelityCheckOptions): Promise<FidelityReport>` retains the
existing public entry point and check registry. New options:

| Option | Contract |
| --- | --- |
| `stage?: 'capture' \| 'materialization' \| 'drift'` | Defaults to `capture`, or `materialization` when `candidateUrl` is supplied. Only explicit `drift` visits the live source. |
| `states?: string[]` | Required states; default `['baseline']`. Other states are pending/unproven because v1 does not freeze interactions. |
| `widths?: number[]` | Frozen stages default to `[390, 768, 1440]`. A required width absent from the manifest is pending. Drift retains the unsampled-width baseline. |
| `routes?: string[]` | Frozen stages default to **all receipt routes plus declared uncaptured source routes**. Explicit routes select a bounded scope, whose counts are reported; unknown routes are pending. Route paths are portable paths, not source-origin paths. |

Existing `directory`, `candidateUrl`, `settleMs`, `screenshots`, and `log` work in
both frozen stages. `candidateUrl` is an HTTP(S) base without query, credentials or
fragment; the portable route is appended, preserving a candidate base subpath.
`materialization` requires it; `capture` rejects it. `sampleSize` and injected
`observe`/`motionContract` are live drift options (frozen stages reject observation
injection and motion contracts). Use explicit `routes` to bound frozen work.

Capture compares immutable source observations to the currently served portable
files. Changed portable geometry is therefore a **capture-stage finding**, rather
than invalidating the source reference. Materialization verifies the original
portable-file digests and compares that portable baseline to the candidate.
Changed portable files cannot silently become a new materialization baseline.
Neither frozen stage navigates to the source. Portable requests are restricted to
the preview origin; candidate requests to the recorded source origin are blocked.
Browser imports remain lazy. Missing references return unproven before a browser
is needed; an old capture requires recapture to obtain frozen evidence.

The stages reuse the browser observer and `runFidelityChecks` registry. Scores and
registered check contexts carry `stage`, `route`, `viewport`, and `state`. A
capture-stage check receives a `frozen:` artifact reference as `sourceUrl`, not a
live origin URL. Contributed checks must respect this evidence boundary and use
the supplied observations rather than revisiting a live source.

## Results and evidence

Frozen reports include:

- `status: 'proven' | 'failed' | 'unproven'` and `pass`; pending evidence **always**
  makes `pass` false, even if measured scores pass.
- `pending[]`: stage/route/viewport/state plus the reason measurement is unproven.
- `coverage`: required and measured cell counts, plus bounded unknowns.
- Existing `scores`, `selfConsistency`, counters and route counts. Offline
  self-consistency still checks every portable route, even for a candidate.

Reports are written to `compare/<stage>/report.json`. `screenshots: true` adds
source/copy/diff PNGs per stage/route/width/state. Pixel scores remain human
evidence, never a pass/fail threshold. A materialization pass proves only that
relationship; callers compose both stage results for their acceptance policy.

The exported `FidelityReference`, `ReferenceEntry`, `ReferenceArtifact`, and
`FidelityStage` types describe `data-liberation/fidelity-reference/v1`. The manifest
contains a fresh capture ID, source URL, timestamp, receipt SHA-256, portable-file
SHA-256s, declared source-route/width/state scope, unknowns and entries. Each entry
contains portable route, source URL, device/user agent, viewport dimensions,
pixel density, mobile/touch emulation options recorded at context construction,
readiness (cleanup, media and fonts), and SHA-256-bound observation JSON, cleaned source document
and viewport PNG references. All paths are run-relative. Receipt/source identity
and every required source artifact are verified before scoring. Missing files,
changed digests, duplicate entries, absent routes/widths/states, incomplete cleanup,
source runtime errors, and pending/failed visible images or fonts are unproven.
Comparison replays the recorded emulation options; references without that profile remain unproven.
This is an integrity record, not a signature: preserve/hash the manifest itself in
the caller's immutable evidence store with the rest of the run.

Readiness is bounded to the settled layout, cleanup audit, decoded visible media,
fonts and observed runtime errors. Fresh reference and candidate navigations run
the controlled lazy-load sweep and return to the baseline pose before observation.
Viewport evidence uses Chromium's complete compositor frame and verifies its exact
requested dimensions before readiness. This preserves fixed-width mobile viewport
scaling without clipping a fractional bottom row or resizing the resulting raster.
It cannot prove that arbitrary application
work has finished. V1 freezes **baseline only**; dialogs, zoom interactions and
motion remain explicit unknowns. Requesting those states cannot certify a pass.
Downstream acceptance must declare every required state via `states` (for example,
`['baseline', 'dialog', 'zoom', 'motion']`) or keep those requirements pending in
its own policy. A default baseline pass does not satisfy interaction acceptance.
Repeated filename/content media requires unique semantic ancestor role/label and
image-label correspondence. DOM sibling indices and nearest geometry do not
establish correspondence; lost/duplicate roles become ambiguous/unproven.
Resume skips are also unproven because no current source session was observed.

CLI equivalents (the same four product verbs remain):

```sh
data-liberation compare ./run --screenshots
data-liberation compare ./run --candidate https://candidate.example/base/
data-liberation compare ./run --stage drift
```

The real-browser `src/lib/fidelity/reference.test.ts` fixture mutates the source
after capture, counts origin requests, damages capture/candidate geometry, and
removes/changes reference evidence. It also exercises real duplicate media and
source runtime failures. The relocated-bundle workflow in
`scripts/test-runtime.mjs` checks the same public default against a mutated source
without requesting it. These are reproducible local evidence, independent of any
destination provider or acceptance orchestrator.

## Migrating live callers

The default change is behavioral: old runs without a reference now return
unproven instead of visiting today's source. Recapture for frozen checks, or
explicitly choose `stage: 'drift'` for live diagnostics. Live `observe`,
`sampleSize`, and `motionContract` callers must also choose drift; they are
rejected by frozen stages. The CLI and MCP forward the stage, and the portable
motion verifier explicitly selects drift. Candidate callers now measure
portable capture → candidate, rather than live source → candidate, unless they
request drift. Compose capture and materialization results for chain acceptance.

This repository supplies the stage APIs and evidence only. Unified Studio/SSI
acceptance-runner integration belongs to the separate SSI #1925 executor.
