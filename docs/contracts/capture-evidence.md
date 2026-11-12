# Capture evidence names

Capture writes evidence into the exported site and its sidecars: dialog wiring, device documents, collections, galleries, glyph colour and more. Blocks Engine and Static Site Importer read it. Under [#787](https://github.com/Automattic/data-liberation-agent/issues/787) (part of [#761](https://github.com/Automattic/data-liberation-agent/issues/761)), the consumers own their input contracts. Blocks Engine publishes this vocabulary as its producer-neutral capture-evidence contract: Automattic/blocks-engine `php-transformer/docs/contracts/capture-evidence.md`, with the constants in `Contract\CaptureEvidence`. Any capture producer can write it, and this producer writes only these names.

## Namespace

| What | Form |
|---|---|
| Attributes | `data-blocks-engine-capture-<name>` |
| Classes | `data-blocks-engine-capture-<name>` |
| Element ids and probe tokens | `data-blocks-engine-capture-<name>` |
| Id suffix of a non-default document variant's copy of a shared source id | `<id>--data-blocks-engine-capture-<variant>` |
| Sidecar schemas | `blocks-engine-capture/<name>/v<n>` |

Classes use the attribute prefix on purpose. Blocks Engine treats `blocks-engine-*` classes as classes the engine generated: conversion strips them from source identity, skips them for naming, and does not project their styles. A capture class therefore has to stay outside that namespace.

## One table

`src/lib/capture-vocabulary.ts` holds the vocabulary:

- `CAPTURE_EVIDENCE_PREFIX`, `CAPTURE_EVIDENCE_ID_SUFFIX` and `CAPTURE_SCHEMA_NAMESPACE`.
- `CAPTURE_EVIDENCE_NAMES`: every name, grouped by family and marked attribute, class, id or token.
- `CAPTURE_EVIDENCE_FAMILIES`: the names whose tail is generated.
- `CAPTURE_SCHEMAS`: every sidecar schema.
- `CAPTURE_RUNTIME_SHA256`: the runtime digests below.

Emitters spell the full names, because many of them sit inside runtime script and stylesheet strings. Live-page code may also use the `dataset.blocksEngineCapture<Name>` form of an attribute. `src/lib/capture-vocabulary.test.ts` keeps the table and the source identical:
- every name the source spells is in the table;
- every name in the table is spelled by the source;
- every schema the source writes is listed;
- every name Blocks Engine publishes, and every name Static Site Importer reads, is covered.

| Family | Names (after `data-blocks-engine-capture-`) |
|---|---|
| Dialogs | attributes `dialog-trigger`, `dialog-panel`, `dialog-close`, `dialog-panel-state`, `dialog-ancestor-state`, `dialog-trigger-state`, `dialog-ancestor-unverified`, `dialog-css`, `existing-panel`, `observed-placement`, `resting-panel`; classes `dialog`, `dropdown`, `initial-dialog`; ids `dialog-<n>` |
| Disclosures | `disclosure`, `disclosure-base` (attribute and cascade layer), `disclosure-label`, `disclosure-runtime`, `disclosure-open-<svg attribute>`, `disclosure-closed-<svg attribute>`, `local-disclosure`, `local-disclosure-runtime`, `exclusive-disclosures`, `hydrated-disclosure`, `inert-control`; class `disclosure`; ids `disclosure-panel-<n>` |
| Listbox, choice groups | `listbox-trigger`, `listbox-panel`, `listbox-runtime`, `choice-group`, `choice-index`, `choice-runtime` |
| Documents | attributes `document-scope`, `device-document`, `device-style`, `device-body`, `device-selection`, `device-visibility`, `device-unavailable`, `document-unavailable`, `selected-document`, `source-media`; classes `desktop-document`, `mobile-document`, `middle-document` (a source's middle width-range layout, between the phone and desktop documents; see `docs/document-selection.md`), `<profile>-document`, `desktop-only`, `mobile-only`; id suffixes `--data-blocks-engine-capture-mobile`, `--data-blocks-engine-capture-middle` |
| Responsive assembly | `root-class-contracts`, `responsive-source`, `responsive-fragment`, `responsive-fragments`, `embedded-responsive`, `embedded-document`, `anchor-fragment`, `anchor-target`, `anchor-source-id`, `anchor-alias`, `anchor-unresolved`, `scripted-link`, `scripted-link-style`, `fluid-id`, `fluid-segment`, `fluid-rules`, `fluid-sheet-rules`, `fluid-ignore-padding`, `geometry-id`, `visual-iframe-src`, `visual-iframe-width`, `visual-iframe-height`; classes `responsive-<hash>`, `responsive-class-<hash>`, `responsive-counterpart-<n>`, `embedded-<digest>-<document>`, `shared-<hash>`; id `fluid-specificity` |
| Collections | `collection`, `collection-item`, `collection-members`, `collection-category`, `collection-category-control`, `collection-index`, `collection-mode`, `collection-field`, `collection-empty`, `collection-status`, `collection-runtime`, `collection-visibility`, `status-template`, `status-hide-zero`; tokens `no-match`, `no-match-7f39b2`, `no-match-2c81e4`, `finite-probe`, `finite-probe-7f39b2`, `finite-follow-up` |
| Galleries, slideshows | `gallery`, `gallery-direction`, `gallery-index`, `gallery-initial`, `gallery-sequence`, `gallery-slot`, `gallery-stage`, `gallery-source`, `gallery-frame`, `gallery-image`, `gallery-full-image`, `gallery-text`, `gallery-display`, `gallery-close`, `gallery-capture-width`, `gallery-runtime`, `gallery-visibility`, `captured-slide`, `captured-slideshow`, `captured-slide-count`, `expected-slide-count`, `capture-error`, `video-frame`, `squarespace-video`, `wix-video`; classes `slideshow` (also the keyframes name), `slideshow-track`; ids `gallery-<n>`, `slideshow-css`, `wix-captured-slideshow-css` |
| Presentation, motion | `glyph-color` ([glyph-color.md](glyph-color.md)), `glyph-probe`, `glyph-probe-style`, `native-control-state`, `native-control-runtime`, `native-effects`, `native-node`, `native-profile`, `native-losses`, `native-runtime-loss`, `native-view-timeline-runtime`, `runtime-emoji` (`wordpress` on `<html>` when the page exposes WordPress emoji runtime settings or its emoji images were restored to text; retained if any assembled device document carries it), `viewport-entrance`, `viewport-entrances`, `viewport-entrance-loss`, `source-canvas`; classes `replica`, `content-desktop`, `content-mobile`, `content-mobile-inner`, `page-<slug>` |
| Platform evidence | `access-gate`, `member-login` (attribute; class `member-login-<provider>`), `source-evidence`, `reclaimed-space`, `cleanup-hidden`, `constructed-stylesheet`, `ported-embed`, `unported-embed`, `google-map-marker`, `squarespace-header-style`, `check-route-tab`; class `google-map-embed`; id `squarespace-header-visible` |

Some names never reach `website/`:
- capture strips `geometry-id`, `glyph-probe`, `glyph-probe-style`, `visual-iframe-*` and `embedded-document` before export;
- `probe-<uuid>` attributes are temporary evaluation-boundary node identities, removed before the probe callback runs (and again on failure); they are not portable evidence;
- frozen phone documents retain only bounded HTTPS iframes attested by `visual-iframe-*`, rebuilding their safe attributes before export; unattested frames and source iframe content are stripped;
- `google-map-marker` is validated source-owned `{lat,lng}` marker evidence consumed and removed during serialization; the portable map uses an ordinary bounded HTTPS iframe and the `google-map-embed` class only keeps it filling its original owner;
- `cleanup-hidden` marks a cleanup match the source runtime re-rendered after its removal; cleanup hides it instead of removing it again, and serialization drops it from the captured HTML;
- `fidelity check` sets `check-route-tab` on its live comparison page;
- DLA runtime scripts set `resting-panel`, `native-runtime-loss`, `runtime-emoji` and `document-unavailable` in the browser.

They share the namespace anyway, so no capture name falls outside it.

## Root class width observations

`root-class-contracts` on `<html>` contains a JSON array of `{root, class, minWidth, maxWidth, evidence}`. Evidence is the sorted `{width, html, body}` class-set samples from the open desktop page. Capture probes at most three intermediate fluid-ladder widths (768, 1024, 1280), then restores its original viewport; it never navigates for this observation. Probing precedes source observation, fluid learning and serialization hooks so capture-time mutations cannot hide resize-driven classes. Each width, including restoration, requires matching class sets across a 500ms quiet window after animation frames, bounded to 1.5s; an unstable width invalidates the whole ladder instead of bridging an unproven gap. Only contiguous observed runs absent at the wide capture are projected. The next absent sample bounds the run, so ranges are sampled approximations, not exact measured breakpoints; disjoint runs remain unknown.

Matching leading root compounds in inline and available captured linked stylesheets receive ordinary media-gated CSS aliases in their original cascade position. Specificity and enclosing conditions survive responsive document scoping; no class-toggling browser runtime or consumer interpretation of the evidence is required. Unavailable linked sheets remain as authored.

## Sidecar schemas

Every sidecar schema is `blocks-engine-capture/<name>/v<n>`. The full list is `CAPTURE_SCHEMAS`. Blocks Engine reads five of them:

- `captured-interactions/v3` (`interaction-states.json`; component nodes with shared-component references)
- `capture-receipt/v1` — its `reports` array names the capture-root JSON sidecars to forward to an importer (additive; schema stays `v1`)
- `source-interactivity/v1`
- `finite-bootstrap/v1`
- `collection-status/v1`

`website/source-findings.json` uses Static Site Importer's own schema, `static-site-importer/source-findings/v1` ([loss-ledger.md](loss-ledger.md) section 5.1).

## Route component states (Refs #1034)

The v3 report stores components identical across two or more pages once in
`sharedComponents`, keyed by `sha256:` plus the SHA-256 of recursively key-sorted
component JSON (array order preserved). Each page keeps its complete, ordered
`components` list, using `{ "ref": "<id>" }` for shared entries and inline nodes
for route-only components. Both report and page schemas are v3. Expanding refs
recovers the v2 component arrays exactly; totals still count expanded per-route
components. Readers accept inline v2 reports as well as v3, and report unresolved
refs as structured diagnostics rather than failing the report. Portable HTML
replay continues to use the full route evidence, not the shared table.

Each route's `components` array groups a surface's `initial` state, bounded observed
`states` (id and HTML), and `transitions` (from/to state ids and a click trigger
selector). Tabs, disclosures, dialogs, listboxes, carousels and menus are classified
from semantic roles and ownership. Unclassified surfaces have `status: unsupported`
and are not materialized as hidden panels. Partial exploration is evidence, not a
claim of complete coverage. Probe-specific replay evidence belongs to a component
state, not a second exported trigger inventory.

The settled, cleaned route document is snapshotted before component exploration.
Only learned geometry and capture annotations may be projected back onto that
initial tree; exploring another tab or slide never replaces it. Lazy tab panels
are obtained by clicking their triggers and materialized hidden beside the initial
panel. Native details retain their authored `open` state.

`unsupported="collection"` marks collection controls that cannot be replayed;
these are disabled, with an `interaction_unreplayable` loss finding. Collection
component nodes add a stable, first-observed member inventory (destination URL,
then normalized text and media), observed control/value membership sets including
empty and reset probes, and explicit coverage limits (20 pages, 200 members,
24 controls). Pagination unions feed linked-page discovery. Existing consumers
may ignore the additive `collection` field. Search probes are bounded samples,
not a claim to enumerate every possible query. Export displays the captured union
rather than silently leaving a live-looking inert filter.

`tabs`, `component-runtime`, `component-disclosure` and
`component-disclosure-runtime` and `component-carousel-runtime` are portable replay attributes. `initial-node` is
private correspondence used during geometry projection and removed before export.
The old pager-slideshow expansion and post-exploration gallery initial-state
realignment are retired. Existing v1/v2 capture-cache probe records are accepted as
inputs, but the published sidecar has one component inventory.

Follow-up slices remain: cross-viewport node reconciliation (point 5), normalized
scroll/animation/generated identities (point 6), declared motion (point 7), and
broader filter/pagination and deep-link fixture coverage. This slice does not
claim those contracts.

## Recognized capture runtimes

A consumer retires or tolerates a capture helper script only when the sha256 of its trimmed body matches a digest the consumer recognizes. The export test hashes the emitted bodies and asserts these values:

| Runtime | sha256 | Status |
|---|---|---|
| Disclosure interpreter (`script[data-blocks-engine-capture-disclosure-runtime]`) | `5dd2db81c39f8f39c3756df8f8588fec6fe84e4a2ea2186fdf81b019f1aa2d6e` | Changed by #1194: replays class-token deltas on the trigger and its descendants. Supersedes the #1097 body (`086fc824…`). Blocks Engine must publish this body before recognizing it. Until then Blocks Engine keeps the captured runtime. |
| Gallery helper (`script[data-blocks-engine-capture-gallery-runtime]`) | `456af76323601e51d851d3a4d6fe4ff6e3989c9969562f425fd72103c5c57c6b` | This producer's current helper, which includes the src-swap sequence cycle from #711. Blocks Engine's `capture-gallery-runtime.js` (`0a6bf62a…`) is the renamed pre-#711 helper. Before #787, Blocks Engine's digest `1321b380…` was also the pre-#711 body, so the two never matched after #711. To recognize the current helper, Blocks Engine should publish this body and digest. |

## Migration

This producer previously wrote these names. Consumers read only the new ones. Producer and consumers were released in lockstep (#787 option A), so there is no compatibility path in either direction.

| Previous | Now |
|---|---|
| attribute `data-dla-<name>` | `data-blocks-engine-capture-<name>` |
| class `data-liberation-<name>` | `data-blocks-engine-capture-<name>` |
| class, id or token `dla-<name>` | `data-blocks-engine-capture-<name>` |
| id suffix `--dla-<variant>` | `--data-blocks-engine-capture-<variant>` |
| schema `data-liberation/<name>/v<n>` | `blocks-engine-capture/<name>/v<n>` |
| `website/capture-findings.json` (`data-liberation-agent/capture-findings/v1`) | `website/source-findings.json` (`static-site-importer/source-findings/v1`) |

`data-blocks-engine-capture-inert-control="true"` records an activated pointer or declarative-hook control with no document mutation, URL/history, dialog/popup, or component visibility/geometry effect over a 400 ms settle window. It is evidence of static markup, not a replay instruction. Unprobed controls carry no such claim.
