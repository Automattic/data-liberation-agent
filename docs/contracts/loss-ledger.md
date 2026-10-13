# Loss ledger contract

The cross-layer contract behind [#761](https://github.com/Automattic/data-liberation-agent/issues/761) ("Degrade, don't throw"). A problem confined to one unit degrades that unit and records a finding. Only integrity violations fail closed. One caller-side acceptance policy decides whether the result is usable.

This page describes what is **implemented today** in the three layers. Gaps are listed explicitly; they are not part of the contract until code lands.

| Layer | Repository | Revision read |
|---|---|---|
| Capture (DLA) | `Automattic/data-liberation-agent` | `main` at #773 |
| Compile (BE) | `Automattic/blocks-engine`, `php-transformer/` | `trunk` at #2716 |
| Import (SSI) | `Automattic/static-site-importer` | `main` at #2055 |

References are `path:line` at those revisions.

## 1. Failure classes and who decides

| Class | Meaning | Behavior | Decided by |
|---|---|---|---|
| **Integrity** | Containment, identity, hash or tamper evidence, a security boundary, a missing entrypoint, programmer errors. | Throws; fails the whole run. Never contained to one unit. | The layer that detects it, at the throw site. |
| **Representability** | The source holds something this layer cannot express. | Drops or normalizes the smallest unit, keeps going, records a finding. | The layer that detects it, at the throw site. |
| **Operational** | Budget, deadline or environment limits: not a property of the source. | Caller scope (budget) is not a loss; deadlines and engine faults are reported or resumed per layer. | The layer reports; the caller decides. |

How each layer draws the line today:

- **DLA.** `IntegrityError` and `isIntegrityError()` (`src/lib/failure-class.ts:5-20`). Integrity is `IntegrityError` plus `TypeError`, `ReferenceError`, `RangeError`, `SyntaxError`, `EvalError` and non-`Error` throws; any other error is confined to the unit that threw it. Per-route export rethrows integrity errors and contains the rest as `route_export_failed` (`src/lib/capture-export.ts:1410-1415`). An entry route off the entry origin fails closed (`SameOriginViolation`, `src/lib/screenshot/screenshotter.ts:1637-1640`). A missing entrypoint rejects with the recorded cause (`src/lib/capture-export-routes.ts:158-172`). Operational: the route budget emits `route_omitted_by_budget`, which is never a loss (`src/lib/capture-usability.ts`); navigation deadlines surface as `route_capture_failed`; the capture time budget (`timeBudgetMs`) degrades to a partial capture, reporting each uncaptured route as `route_capture_skipped_budget` (`src/lib/capture-time-budget.ts`).
- **BE.** Representability is `InvalidArgumentException` thrown while converting one **non-entrypoint** page. `DocumentIdentityException`, `ValidationException`, `LogicException`, `RuntimeException`, `Error`, artifact and receipt integrity checks, and any entrypoint failure keep failing the compile (`php-transformer/docs/contracts/omitted-page-receipt.md`, "What counts as representability").
- **SSI.** No exception class split. Acceptance is decided once, before any WordPress mutation (`includes/class-static-site-importer-direct-artifact-import.php:745-775`). Operational: a reached deadline returns a resumable continuation (`:776-777`), not a failure.

The layers decide the **class**. The **caller** decides acceptance (section 6). Capture never applies its own usability policy (`src/lib/capture-usability.ts:22-27`).

## 2. Units

Units from smallest to largest:

```
item (declaration, link, glyph, form property)
  └ block (evidence block)
      └ stylesheet / asset / file
          └ profile (one capture viewport of a route)
              └ page (compiled document) ≈ route (captured URL)
                  └ site
```

| Unit | Emitted as `unit` by | Implicit in |
|---|---|---|
| `route` | DLA | — |
| `profile` | DLA (`profile` names it) | — |
| `stylesheet` | DLA | — |
| `asset` | DLA (`asset_exceeds_file_limit`) | — |
| `block` | DLA (`profile` names the viewport) | — |
| `page` | BE `page_compile_omitted` only; SSI stamps it on the same row | Other BE rows carry `source_path`, which is page-level |
| item / file | nobody | BE `selector`, `value`, `src`; SSI intake `path` |

A route and a page are the same unit seen from two layers: DLA writes route `R` to `website/<path>`; BE compiles that file as `source_path`. Nothing in the data joins them today except the path (see gaps).

## 3. Finding fields per layer

The target shape from #761 is `code`, `severity`, `unit`, `path`, `reason`, `metrics`, `owning_layer`. What each layer actually carries:

| Target field | DLA `RouteDiagnostic` | BE compile diagnostics | SSI import report row |
|---|---|---|---|
| `code` | `code` (required) | `code` | `code` in the full report; compact rows keep it only as `source_diagnostic.code` |
| `severity` | `severity?: 'warning' \| 'error'` (optional) | `severity` (`warning`, `error`; `info` elsewhere) | `severity`: producer value, else derived from `type` |
| `unit` | `unit?` (optional) | `unit` on `page_compile_omitted` only | `unit` stamped on `page_compile_omitted` only |
| location | `url` (required), `path?` (exported file), `profile?` | `source_path`: top level, **or** nested in `context.source_path` for rows built by `ArtifactCompiler::diagnostic()` | `source_path`; intake rows also carry `path` |
| human text | `reason` (required, free text) | `message` (clipped to 256 bytes) | `message` |
| machine reason | — | `reason_code` on most new rows; `context.reason` holds the raw error on include rows; `reason: 'truncated'` marks overflow rows | `reason_code` (producer value, else `reason`, else `type`) |
| `metrics` | `metrics?: Record<string, number>` | `context.metric` / `actual` / `maximum` (editability); `omitted_count` (overflow) | no `metrics` field; not in compact rows |
| `owning_layer` | — | — (`source` is a PHP class name) | stamped on `page_compile_omitted` only (`'blocks-engine'`) |
| `loss_class` | — | — | `loss_class`, duplicated as `diagnostic_class`, plus `acceptability` |

Definitions:

- **DLA:** `src/lib/capture-export-routes.ts:73-89`. `CaptureResult.discoveryDiagnostics` is typed `RouteDiagnostic[]`.
- **BE:** `ArtifactCompiler::diagnostic()` (`src/ArtifactCompiler/ArtifactCompiler.php:5660-5671`) builds `{code, severity, message, source, context}`. Site-plan rows are flat (`src/WordPressSitePlan/WordPressSitePlan.php:2001-2008`, `:2028-2033`, `:4269-4277`). Omitted-page rows are flat with `unit` (`ArtifactCompiler.php:5618-5632`).
- **SSI:** normalization `includes/class-static-site-importer-diagnostic-projection.php:1986-2029`, compact row allowlist `:2473-2525`.

## 4. Code registry

These are the codes the degrade work added or relies on. Pre-existing codes are marked `—` in the PR column.

### Capture (DLA)

| Code | Unit | Severity | Meaning | Missing route? | PR |
|---|---|---|---|---|---|
| `route_capture_failed` | route (implicit) | — | Attempted route with no page HTML (deadline, engine error, file missing), or a redirect to an uncaptured or dropped target. | yes | — (#759 counts it) |
| `route_export_failed` | route | error | Non-integrity error while exporting the route; the route is dropped. | yes | #764 |
| `route_path_collision` | route | error | Website path already claimed by another route; the route is dropped. The entrypoint keeps its path. | yes | #773 |
| `route_capture_skipped_budget` | route | error | The capture time budget left the route uncaptured: not started before admission closed, or abandoned in flight at the deadline. `metrics.timeBudgetMs`. Never the entrypoint. | yes | this PR |
| `asset_exceeds_file_limit` | asset | warning | Captured asset over the export `maxFileBytes` (default 50 MiB, SSI's per-file intake limit); not written, references left unresolved. `metrics.bytes`, `metrics.limit`. A page document over the limit is `route_export_failed` instead. | no | this PR |
| `route_capture_degraded` | route | warning | HTML saved, but some stages failed. `metrics.failedStages`. | no | #764 |
| `route_profile_uncaptured` | profile | error | A declared capture profile produced no document. Makes `complete: false`. | no | #764 |
| `stylesheet_unparseable` | stylesheet | warning | Author stylesheet left unprojected; `path` names the file. | no | #764 |
| `native_timeline_unproven` | block | warning | Native view-timeline evidence was lost on a saved page. | no | #773 |
| `disclosure_unrestored` | block | error | Disclosure probe could not restore its baseline; hydrated panels were not kept. | no | #773 |
| `route_off_origin` | route | warning | Discovered URL outside the entry origin; dropped before it takes budget. | no | #773 |
| `route_omitted_by_budget` | route (implicit) | — | Outside the caller's route budget. Not attempted; not a loss. | no | #767 |
| `route_not_found` | route (implicit) | — | Source answered with an absent status. Nothing to copy. | no | — |
| `route_external_redirect` | route (implicit) | — | Source redirects outside the site scope. | no | — |

Emit sites are in `src/lib/capture-export.ts`: `:1229-1258`, `:1333`, `:1371`, `:1374`, `:1376`, `:1415`, `:1745`, `:1766`. Others are `src/lib/capture-export-routes.ts:269`, `:313`, `src/lib/screenshot/screenshotter.ts:1025`, `:1079`, `:1643`, and `src/lib/route-budget.ts:24`.

Other `discoveryDiagnostics` codes are discovery evidence rather than unit losses: `sitemap_*`, `fallback_*`, `linked_page_*`, `http_*`, `device_document_uncaptured`, `source_evidence_unproven`. They have no `unit` or `severity`.

### Compile (BE)

| Code | Unit | Severity | Meaning | PR |
|---|---|---|---|---|
| `page_compile_omitted` | page | warning | Non-entrypoint page dropped at a representability limit. `reason_code: page_compile_representability_limit`. | #2714 |
| `editability_policy_degraded` | page (`context.source_path`) | warning | Per-page editability breach; the page stays. `context.metric/actual/maximum`. | #2711 |
| `editability_policy_failed` | page | error | Entrypoint `wrapper_to_content_ratio` breach; fails the import. | #2711 |
| `document_head_duplicate_viewport` | item | warning | Kept the last viewport and dropped the earlier ones (`omitted_count`). | #2712 |
| `runtime_form_graph_rejected` | item (`selector`) | warning | Form graph failed its structural contract; omitted from the runtime entity. | — (contained in #2712) |
| `wordpress_site_plan_omitted_link_declaration` | item (`rel`, `value`) | warning | Head link that names no asset or route was omitted. `reason_code: unresolved_local_url`. | — (extended in #2715) |
| `wordpress_site_plan_unresolved_navigation_link` | item (`value`) | warning | Local link or relative form action with no artifact page, rewritten to the source URL or to `#`. Covers links to omitted pages. | — (extended in #2714, #2715) |
| `html_include_budget_exceeded` | page (`context.source_path`) | warning | Document over the include count; its includes were left unexpanded. Entry documents still throw. | #2715 |
| `html_include_directive_ignored` | page (`context.source_path`) | warning | Non-standard or unresolvable include directive; left unexpanded. | #2715 |
| `glyph_color_undecodable` | item (`src`, `mime_type`) | warning | Social icon glyph could not be decoded; core default icon colors apply. | #2716 |

Emit sites:

- `page_compile_omitted`: `src/ArtifactCompiler/ArtifactCompiler.php:55-56`, `:5618-5632`.
- Editability codes: `ArtifactCompiler.php:486-495`.
- `runtime_form_graph_rejected`: `ArtifactCompiler.php:1226-1243`.
- Site-plan codes: `src/WordPressSitePlan/WordPressSitePlan.php:98`, `:2001`, `:2028`, `:4269`, `:4313`.
- Include codes: `src/ArtifactCompiler/HtmlFragmentIncludes.php:69-73`, `:185-191`.
- `glyph_color_undecodable`: `src/HtmlToBlocks/HtmlCompilation.php:3121-3131`.

Result status comes from `statusFromDiagnostics()` (`ArtifactCompiler.php:5639-5653`; `WordPressSitePlanComposer.php:131-146`). Any `error` gives `failed`. Any other row (except the preserved-runtime codes) gives `success_with_warnings`. Otherwise the status is `success`.

### Import (SSI)

| Code | Unit | Severity | Meaning | PR |
|---|---|---|---|---|
| `static_site_importer_non_static_file_skipped` | file (`path`) | warning | Non-static archive asset skipped. A non-static **page** document still rejects the archive. Carried as `source_metadata.intake_findings`. | #2052 |
| `omitted_artifact_files` / `omitted_artifact_file` | file | — | SSI-owned rewrite of BE file drops (`file_limit_exceeded`, `artifact_file_too_large`, `artifact_total_too_large`), `loss_class: unsupported_loss`. Refuses the import. | — |
| `static_site_importer_omitted_entrypoint` | page | (WP_Error) | BE omitted the entrypoint; fail closed. | #2055 |

Emit sites:

- Intake skip: `includes/rest.php:1005-1034`.
- File-drop rewrite: `includes/class-static-site-importer-diagnostic-loss-classes.php:81-85`, `:342-359`.
- Omitted entrypoint: `includes/class-static-site-importer-direct-artifact-import.php:751-762`.

### SSI loss classes

The loss classes are defined in `includes/class-static-site-importer-diagnostic-loss-classes.php:54-68`:

- `native_conversion`
- `editable_approximation`
- `preserved_runtime_island`
- `page_compile_omitted`
- `unsupported_loss`
- `importer_materialization_bug`

An unknown explicit value becomes `unrecognized_loss_class` and is counted as drift. The alias `runtime_island_preserved` maps to `preserved_runtime_island` (`:109-111`).

Classification order (`:410-458`):

1. `page_compile_omitted` by code.
2. An explicit `loss_class`.
3. The BE `ConversionFindingContract` `repair_bucket` map (`:123-160`).
4. The string heuristic, whose default is `native_conversion`.

`acceptability` is derived from the class (`diagnostic-projection.php:2280-2289`):

- `preserved_runtime_island` → `acceptable_preservation`.
- `native_conversion` and `editable_approximation` → `acceptable_conversion`.
- Everything else → `unacceptable_imported_output_defect`.

## 5. Flow: capture → compile → import

```
DLA captureWebsite()
  rows: RouteDiagnostic[] → receipt.discoveryDiagnostics (capture receipt + diagnostics.json)
  result: complete, entrypointCaptured, missingRoutes, summary{routesDiscovered, routesCaptured,
          routesFailed, routesOmitted}, unresolvedAnchors
  artifact: website/ files + website/capture-findings.json (loss rows, section 5.1)
        │
        ▼
BE ArtifactCompiler::compile() / compose()
  rows: result.diagnostics + wordpress_site_plan.diagnostics
  status: success | success_with_warnings | failed   (plan quality.status matches)
  staged: receipt.terminal_reduction.omitted_pages → compose() re-emits page_compile_omitted
        ▼
SSI Receipt_Projection::compose()
  diagnostics = plan.diagnostics (page_compile_omitted re-owned: unit, owning_layer, loss_class)
              + normalized compiler_diagnostics + lifecycle + entity declines + gutenberg gaps
              + stylesheet / layout / interaction rows + source_metadata.intake_findings
  → normalize_import_diagnostics(): id, severity, reason_code, loss_class, acceptability
  → compact_summary (static-site-importer/import-metrics/v1)
```

- **DLA.** Diagnostics are collected at `src/lib/capture.ts:342` and `:362`. `complete` is computed at `:386-395` and the result built at `:396-405`. The receipt is written at `src/lib/capture-export-evidence.ts:625` and `:640`. `complete` is false when `routesFailed > 0`, when a profile is uncaptured, when a document selection is missing, when there is a non-budget linked-page diagnostic, or when an anchor targets an uncaptured route. Budget omission never makes a capture incomplete.
- **BE.** Merging and the omitted-page path are described in `php-transformer/docs/contracts/omitted-page-receipt.md`. BE never sees `capture-findings.json`: SSI removes it at intake.

### 5.1 Capture findings in the artifact

The capture receipt and `diagnostics.json` sit next to `website/`, outside the artifact an importer receives. So that capture losses travel with the site, capture writes one small static file at the website root, `website/capture-findings.json` (`src/lib/capture-findings.ts`). Browser and HTTP capture both write it once the result is known; browser capture writes it before the fidelity reference hashes `website/`.

```json
{
  "schema": "data-liberation-agent/capture-findings/v1",
  "entrypoint": "index.html",
  "complete": false,
  "usable": true,
  "summary": { "routes_discovered": 3, "routes_captured": 2, "routes_failed": 1, "routes_omitted": 0, "unresolved_anchors": 0 },
  "findings": [
    { "code": "route_capture_degraded", "severity": "warning", "unit": "route", "url": "https://example.test/about/", "path": "about/index.html", "reason": "mobile/screenshot-scrolled: screenshot timeout", "metrics": { "failedStages": 1 } },
    { "code": "route_export_failed", "severity": "error", "unit": "route", "url": "https://example.test/pricing/", "reason": "cannot export Pricing" }
  ],
  "omitted_findings": 0,
  "missing_routes": [ { "url": "https://example.test/pricing/", "code": "route_export_failed", "reason": "cannot export Pricing" } ]
}
```

- `findings`: every receipt `discoveryDiagnostics` row with a `unit`, plus the missing-route codes (`route_capture_failed`, `route_capture_skipped_budget`, `route_export_failed`, `route_path_collision`). Discovery evidence (`sitemap_*`, `http_*`, `route_omitted_by_budget`, `route_not_found`, `route_external_redirect`) is left out. `unit` defaults to `route` and `severity` to `error` for missing-route rows and `warning` otherwise. `path` and `entrypoint` are relative to the website root. `profile` and `metrics` appear when the row has them.
- Rows are de-duplicated and sorted by `url`, `code`, `unit`, `path`, `profile` and `reason`, so the same capture writes the same bytes. At most 500 rows are written; `omitted_findings` counts the rest.
- `missing_routes` is `missingRoutes()` over the receipt rows, sorted by URL. It is never bounded.
- `complete` is the capture result's `complete`; `usable` is `isUsableCapture()` under `USABLE_PARTIAL_CAPTURE_POLICY`.
- The file is JSON, so it passes SSI's static-content policy. A new field is additive within `v1`; a changed meaning needs `v2`.

SSI reads the file at intake when it is present (Automattic/static-site-importer `includes/class-static-site-importer-capture-findings.php`). It validates `schema` and the `findings` and `missing_routes` lists, removes the file from the artifact, and adds one report row per finding, plus one per missing route that has no finding row with the same code and URL. Rows carry the canonical finding fields: `code`, `severity`, `unit`, `location` (`website/<path>`, else the URL), `message` from `reason`, the code as `reason_code`, numeric `metrics`, `owning_layer: data-liberation-agent`, `loss_class` and `acceptability`; `url` and `context.profile` are kept too. SSI classifies capture codes by code in its reported-loss registry:

| Code | SSI loss class | Unit |
|---|---|---|
| `route_capture_failed`, `route_export_failed`, `route_path_collision`, `route_off_origin` | `omitted_unit` | route |
| `route_profile_uncaptured` | `omitted_unit` | profile |
| `route_capture_degraded` | `degraded_unit` | route |
| `stylesheet_unparseable` | `degraded_unit` | stylesheet |
| `native_timeline_unproven`, `disclosure_unrestored` | `degraded_unit` | block |

Each has acceptability `accepted_reported_loss`: the import completes, and the rows are counted in the compact summary's `loss_class_summary`, `loss_count` and `loss_counts`. A capture code SSI does not know yet is stamped `degraded_unit`, so a new DLA code is still counted as a loss. `route_capture_skipped_budget` (an omitted route) and `asset_exceeds_file_limit` (a degraded asset) are not in SSI's registry yet, so both are counted as `degraded_unit` until it adds them. A capture without the file imports as before. A file that cannot be read or fails validation adds one `capture_findings_unreadable` warning and never fails the import.
- **SSI.** `compose()` is at `includes/class-static-site-importer-receipt-projection.php:50-103`. Compact summary fields (`diagnostic-projection.php:1374-1416`):
  - `status` (`completed`/`failed` from `fail_import`)
  - `quality_pass`, `fail_import`, `failure_reasons`
  - `omitted_file_count`, `unresolved_link_count`, `diagnostic_count`
  - `diagnostic_summary`, `loss_class_summary` (counts per class, zeros included)
  - `warning_summaries`, `error_summaries`
  - `diagnostics`: the first 50 rows, allowlisted fields only.

## 6. Acceptance hooks today, and the recommended caller policy

**Hooks that exist:**

- **Capture.** `USABLE_PARTIAL_CAPTURE_POLICY` v1 and `isUsableCapture(result)` (`src/lib/capture-usability.ts:28-32`, `:94-104`). A capture is usable when `entrypointCaptured` is true and either `complete` is true or `missingRoutes.length <= max(1, 0.1 × routesDiscovered)`. Budget-omitted routes are in neither count. `liberate` and the MCP tool expose it as `usable` (`src/ui/liberate.ts:103`, `src/mcp-server.ts:153`). `strict: true` rejects on `complete: false` instead (`src/lib/capture.ts:408`).
- **Compile.** `status !== 'failed'`. A failed status means some `error`-severity row; in this ledger the only one is the entrypoint editability breach.
- **Import.** The SSI direct-artifact path accepts BE-omitted non-entry pages and imports the rest. It refuses an omitted entrypoint and any omitted artifact file (`direct-artifact-import.php:745-775`). The quality gate also sets `fail_import` on `dropped_artifact_files` (`includes/class-static-site-importer-quality-gates.php:108-127`).

**Recommended single caller policy** (hosted runner, Studio). Apply it once, after import:

1. **Integrity:** any thrown error from any layer fails the run. The layers already guarantee this.
2. **Capture:** proceed when `isUsableCapture(result)` is true. Do not gate on `complete`.
3. **Compile:** proceed unless `status === 'failed'`.
4. **Import:** accept when `compact_summary.status === 'completed'`.
5. **Report, never gate** on the rest:
   - capture: `missingRoutes`, `summary.routesOmitted`, and `discoveryDiagnostics` rows that have a `unit` (the same rows reach the import report through `capture-findings.json`)
   - import: `loss_class_summary`, the `page_compile_omitted` count, `omitted_file_count`, `unresolved_link_count`

   Present them as one list keyed by `code` and `unit`.

A stricter caller tightens step 2 (for example `complete && summary.routesOmitted === 0`). It does not add a new check elsewhere.

## 7. Open gaps

- **Caller policy not adopted.** The hosted runner still fails on any `complete: false` capture instead of `isUsableCapture()` (#761, "Caller policy").
- **Unresolved anchors cross only as a count.** `capture-findings.json` carries capture loss rows and missing routes into the import report (section 5.1), but only `summary.unresolved_anchors` for `unresolvedAnchors`. Routes and pages still share no key except the exported path.
- **Field names differ.**
  - Human text: DLA `reason` is free text; BE and SSI use `message`, with `reason_code` as the machine reason.
  - BE `reason` is overloaded: it is `'truncated'` on overflow rows and the raw error in `context.reason`.
  - Location: `url` (DLA), `path` (DLA file, SSI intake) and `source_path` (BE, SSI).
  - BE puts `source_path` at the top level on some rows and in `context` on others (editability, include codes).
- **`unit`, `owning_layer` and `loss_class` are sparse.** DLA has no `owning_layer` or `loss_class`. BE sets `unit` on one code. SSI stamps `unit` and `owning_layer` only on `page_compile_omitted` and on capture rows from `capture-findings.json`.
- **`severity` means different things.** DLA `severity` is optional and absent on `route_capture_failed`. DLA `error` does not imply incompleteness: `disclosure_unrestored` is `error`, but the page counts and `complete` is unaffected. BE `error` means the compile failed.
- **Losses classed as acceptable.** New degrade codes with no specific `pattern_family` fall through BE's default repair bucket `review_generic_mapping` (`src/Contract/ConversionFindingContract.php:353-355`), so SSI classes them `editable_approximation` / `acceptable_conversion` rather than as a loss. This covers `editability_policy_degraded`, `html_include_*`, `glyph_color_undecodable`, `*_link_declaration`, `*_navigation_link` and `static_site_importer_non_static_file_skipped`. Separately, `runtime_form_graph_rejected` maps to `importer_materialization_bug` (`materialize_form_provider`).
- **Unmapped repair buckets.** BE emits `restore_compiled_document_identity` and `restore_projected_selector_binding`, which SSI's map does not list (`loss-classes.php:123-160`). They are recorded as drift and fall back to the heuristic.
- **Accepted omissions are marked unacceptable.** `page_compile_omitted` rows get `acceptability: unacceptable_imported_output_defect` while the import completes with `quality_pass` unaffected. The compact summary has no dedicated omitted-page count; only `loss_class_summary.page_compile_omitted` counts them.
- **Compact rows are truncated.** `compact_summary.diagnostics` keeps the first 50 rows in report order. It drops top-level `code`, `url`, `value` and `metrics`.
- **The partial-site rule is inconsistent.** An omitted page imports, but an omitted artifact file refuses the whole import.
- **Not every loss is a finding row.** #2712's form-style drops are recorded as `style_value_unrepresentable:<property>` strings inside the form presentation graph's `diagnostics` list, not as rows.
- **No classification guard.** No repository yet requires every throw site on the compile and import path to be classified (#761, "Classification guard"). Remaining conversions: Automattic/blocks-engine#2713 items 4-8, Automattic/static-site-importer#2054, #762, and #769 (capture-side glyph colour).
