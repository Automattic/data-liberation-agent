# Reproducible fidelity stages

`captureWebsite` writes `fidelity-reference.json` alongside the receipt. It observes
independent source navigations in the capture's browser context, before
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
| `concurrency?: number` | Frozen cells in flight: integer from 1 to 4, default 3. Use 1 for serial comparison. Drift remains serial. |

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

Frozen cells share one browser and preview server, but each owns a fresh browser
context with its recorded source profile. Reports retain required-cell order,
regardless of completion order. Cell failures remain pending while other cells
finish; contexts close before the shared browser/server. Duplicate selections or
routes sharing a legacy evidence slug run serially to retain deterministic
last-writer evidence paths. Registered checks may run concurrently across cells;
their supplied evidence directory is cell-local. Stateful consumers can select
`concurrency: 1`.

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
- `outcomes[]` and `coverage.observedOutcomes`: independently verified external
  boundary cells, separate from measured local-document scores.
- Existing `scores`, `selfConsistency`, counters and route counts. Offline
  self-consistency still checks every portable route, even for a candidate.

Rendered observations expose `internalRoutes: InternalRouteOutcome[]` in place of
the former `internalMissing` pathname list. Each checked link carries its authored
`path`, last observed HTTP `status` (or `null` if no response arrived), count of
followed `redirects`, and `outcome`. `reachable` requires a terminal 2xx;
`http-error` preserves other terminal statuses. Redirect failures distinguish
`blocked-redirect`, `missing-location`, `invalid-location`, `redirect-loop`, and
`redirect-limit`; transport failures distinguish `timeout` and `request-error`.
The last status on a failed chain is evidence of that hop, not a terminal result.
Navigation failures name the actual status and outcome rather than labeling every
failure 404. Successful chains remain available as report evidence.

Internal-link API probes check at most 32 authored pathnames per observation,
follow at most 20 redirects per path, and share a 10-second deadline across each
chain. Automatic redirects are disabled. Every requested hop must have exactly
the candidate's origin (scheme, hostname and port), without credentials; aliases
and outbound Locations are blocked before requesting them. Outbound destinations
are not persisted. These probes cannot borrow live source evidence, even though
Playwright API requests bypass the browser route guard. Source observations carry
an empty route-outcome list.

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

### Initial-document external outcomes

Scheduled HTTP, response `Refresh`, and HTML meta-refresh redirects share one
bounded response classifier before DOM cleanup. Acquisition follows at most four
same-site responses, using the canonical HTTP(S)/apex-www boundary, with a
30-second total navigation budget, five seconds per
request, two MiB per response and an initial refresh delay at most five seconds.
Credentials and non-HTTP(S) destinations fail; public acquisition applies the
existing public-URL policy. An external declaration ends acquisition before a
destination request. Unexplained script/control navigation remains route drift.
Refresh declarations without a destination reload the same response document.
Long timers (for example `Refresh: 60`) retain ordinary baseline capture; imminent
reloads settle through the bounded reload acquisition policy. Repeated immediate
or delayed reloads exhaust that policy rather than becoming redirect outcomes.
Same-origin aliases reuse the target queue and portable alias contract; requested
identity stays separate from rendered URL/base (including trailing slashes).
Unscheduled inspection uses the exact source-resolved document address, removing
only its client-side fragment for acquisition. Comparison keys never become
request URLs. Coverage and source-link rewriting use captured request addresses
or explicit proven aliases, so an external `/catalog` outcome cannot cover or
rewrite a different `/catalog/` document. Existing rendered URL/base resolution
feeds these addresses; it is not replaced by path or query normalization.
`captureWebsite` expands adapter discovery through a bounded rendered-link
frontier. Desktop and phone HTML feed the existing capture queue in breadth-first
waves, including second-hop links. Fragment-only request identity retains distinct
slash and query renditions; only source-proven redirects reuse aliases. Newly
scheduled local HTML gets ordinary capture-session reference observations, and
external declarations use the same frozen boundary contract below.

`CaptureOptions.linkedPages` configures `maxPages` (256 by default), `maxDepth`
(8 linked hops), and `timeoutMs` (1,800,000 ms). The time budget bounds admission
and starting queued work; an already active capture completes under its ordinary
navigation/capture deadlines. Seeds consume the page budget at depth zero. Every
observed eligible link remains required even when a page, depth or time budget
prevents its capture. `linked-page-coverage.json`, the receipt and capture
diagnostics retain exact required URLs, limits, scheduled count and concrete
omission reasons. Budget omissions and source-error/non-HTML observations keep
completion false and frozen acceptance pending.

Low-level `captureScreenshots` callers opt in with `linkedPages: {}`. Without
that option, unscheduled probes remain classification-only: they do not create
frozen observations or extend declared required scope. A successful HTML probe
remains an uncaptured-route finding until scheduled.

The receipt's `sourceOutcomes[]` and a frozen entry's `outcome` use
`data-liberation/source-outcome/v1`, currently `kind: 'external-redirect'`.
They retain the requested source URL, initial response status, final declaration
mechanism, viewport/browser profile and a confined SHA-256-bound raw response
chain. Public target identity is only origin plus a digest of its complete URL;
`fetched: false` explicitly leaves terminal status/content unobserved. Raw evidence
under `source-outcomes/` can contain authored destination queries: preserve it
privately with the run, separately from the portable `website/` tree.

Required source URLs remain in scope. Both capture devices must agree, and each
390/768/1440 frozen boundary is independently acquired and revalidated from its
retained source declarations. Missing, corrupt, ambiguous or disagreeing evidence
is unproven. Frozen stages never revisit the source or foreign destination. They
also verify that authored source-resolving links retain query/fragment meaning in
the portable and materialized local documents. Boundary cells have no local
document/raster score and prove neither destination editability nor visual parity.
`coverage.measured` counts local-document scores; `observedOutcomes` counts boundary
cells, and both contribute to accounting for `coverage.required`. HTTP errors and
non-HTML routes still require further outcome contracts and remain unproven when
they have no frozen local observation. Other states and widths remain pending.

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
