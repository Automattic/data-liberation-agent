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
| Dialogs | attributes `dialog-trigger`, `dialog-panel`, `dialog-close`, `dialog-panel-state`, `dialog-ancestor-state`, `dialog-ancestor-unverified`, `dialog-css`, `existing-panel`, `observed-placement`, `resting-panel`; classes `dialog`, `dropdown`, `initial-dialog`; ids `dialog-<n>` |
| Disclosures | `disclosure`, `disclosure-base` (attribute and cascade layer), `disclosure-label`, `disclosure-runtime`, `disclosure-open-<svg attribute>`, `disclosure-closed-<svg attribute>`, `local-disclosure`, `local-disclosure-runtime`, `exclusive-disclosures`, `hydrated-disclosure`; class `disclosure`; ids `disclosure-panel-<n>` |
| Listbox, choice groups | `listbox-trigger`, `listbox-panel`, `listbox-runtime`, `choice-group`, `choice-index`, `choice-runtime` |
| Documents | attributes `document-scope`, `device-document`, `device-style`, `device-body`, `device-selection`, `device-visibility`, `device-unavailable`, `document-unavailable`, `selected-document`, `selected-viewport`, `source-media`; classes `desktop-document`, `mobile-document`, `<profile>-document`, `desktop-only`, `mobile-only`; id suffix `--data-blocks-engine-capture-mobile` |
| Responsive assembly | `responsive-source`, `responsive-fragment`, `responsive-fragments`, `embedded-responsive`, `embedded-document`, `anchor-fragment`, `anchor-target`, `anchor-source-id`, `anchor-alias`, `anchor-unresolved`, `fluid-id`, `fluid-segment`, `fluid-rules`, `fluid-sheet-rules`, `fluid-ignore-padding`, `geometry-id`, `visual-iframe-src`, `visual-iframe-width`, `visual-iframe-height`; classes `responsive-<hash>`, `responsive-class-<hash>`, `responsive-counterpart-<n>`, `embedded-<digest>-<document>`, `shared-<hash>`; id `fluid-specificity` |
| Collections | `collection`, `collection-item`, `collection-members`, `collection-category`, `collection-category-control`, `collection-index`, `collection-mode`, `collection-field`, `collection-empty`, `collection-status`, `collection-runtime`, `collection-visibility`, `status-template`, `status-hide-zero`; tokens `no-match`, `no-match-7f39b2`, `no-match-2c81e4`, `finite-probe`, `finite-probe-7f39b2`, `finite-follow-up` |
| Galleries, slideshows | `gallery`, `gallery-direction`, `gallery-index`, `gallery-initial`, `gallery-sequence`, `gallery-slot`, `gallery-stage`, `gallery-source`, `gallery-frame`, `gallery-image`, `gallery-full-image`, `gallery-text`, `gallery-display`, `gallery-close`, `gallery-capture-width`, `gallery-runtime`, `gallery-visibility`, `captured-slide`, `captured-slideshow`, `captured-slide-count`, `advertised-slide-count`, `expected-slide-count`, `capture-error`, `pager-stage`, `pager-control`, `video-frame`, `squarespace-video`; classes `slideshow` (also the keyframes name), `slideshow-track`; ids `gallery-<n>`, `slideshow-css`, `captured-slideshow-css`, `wix-captured-slideshow-css` |
| Presentation, motion | `glyph-color` ([glyph-color.md](glyph-color.md)), `glyph-probe`, `glyph-probe-style`, `native-control-state`, `native-control-runtime`, `native-effects`, `native-node`, `native-profile`, `native-losses`, `native-runtime-loss`, `native-view-timeline-runtime`, `viewport-entrance`, `viewport-entrances`, `viewport-entrance-loss`, `source-canvas`; classes `replica`, `content-desktop`, `content-mobile`, `content-mobile-inner`, `page-<slug>` |
| Platform evidence | `access-gate`, `member-login` (attribute; class `member-login-<provider>`), `source-evidence`, `reclaimed-space`, `constructed-stylesheet`, `ported-embed`, `unported-embed`, `google-map-marker`, `squarespace-header-style`, `check-route-tab`; class `google-map-embed`; id `squarespace-header-visible` |

Some names never reach `website/`:
- capture strips `geometry-id`, `glyph-probe`, `glyph-probe-style`, `visual-iframe-*` and `embedded-document` before export;
- frozen phone documents retain only bounded HTTPS iframes attested by `visual-iframe-*`, rebuilding their safe attributes before export; unattested frames and source iframe content are stripped;
- `google-map-marker` is validated source-owned `{lat,lng}` marker evidence consumed and removed during serialization; the portable map uses an ordinary bounded HTTPS iframe and the `google-map-embed` class only keeps it filling its original owner;
- `fidelity check` sets `check-route-tab` on its live comparison page;
- DLA runtime scripts set `resting-panel`, `native-runtime-loss` and `document-unavailable` in the browser.

They share the namespace anyway, so no capture name falls outside it.

## Sidecar schemas

Every sidecar schema is `blocks-engine-capture/<name>/v<n>`. The full list is `CAPTURE_SCHEMAS`. Blocks Engine reads five of them:

- `captured-interactions/v1` (`interaction-states.json`)
- `capture-receipt/v1`
- `source-interactivity/v1`
- `finite-bootstrap/v1`
- `collection-status/v1`

`website/source-findings.json` uses Static Site Importer's own schema, `static-site-importer/source-findings/v1` ([loss-ledger.md](loss-ledger.md) section 5.1).

## Recognized capture runtimes

A consumer retires or tolerates a capture helper script only when the sha256 of its trimmed body matches a digest the consumer recognizes. The export test hashes the emitted bodies and asserts these values:

| Runtime | sha256 | Status |
|---|---|---|
| Disclosure interpreter (`script[data-blocks-engine-capture-disclosure-runtime]`) | `b545f43a77b79d075373048431101fe11d7ff8cdfe7987de6d7971512763d88f` | Changed by #779 (modal-menu ancestor state). Blocks Engine still publishes the pre-#779 body (`3d350f55…`); like the gallery runtime, it must publish this body before it recognizes it again. Until then Blocks Engine keeps the captured runtime, as it already did for the gallery since #711. |
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
