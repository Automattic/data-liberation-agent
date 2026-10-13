# Capture evidence names: producer-neutral emission

Capture writes evidence into the exported HTML: dialog wiring, device documents, collections, galleries, glyph colour and more. Blocks Engine and Static Site Importer read it. Under [#787](https://github.com/Automattic/data-liberation-agent/issues/787) (part of [#761](https://github.com/Automattic/data-liberation-agent/issues/761)) each consumer owns its input contract, so Blocks Engine owns these names in its own namespace and any capture producer can write them.

## Rule

One lexical rule maps every producer name onto the consumer name. Values and semantics are unchanged.

| Producer name | Consumer name | Applies to |
|---|---|---|
| `data-dla-<name>` | `data-blocks-engine-capture-<name>` | attributes and class tokens |
| `data-liberation-<name>` | `data-blocks-engine-capture-<name>` | attributes and class tokens |
| `dla-<name>` | `blocks-engine-capture-<name>` | class tokens |

`data-liberation-<name>` appears only as class tokens today (`data-liberation-desktop-document`, `data-liberation-mobile-document`, ...). The rule maps the token as written, so the class `data-liberation-mobile-document` gains the class `data-blocks-engine-capture-mobile-document`. Capture emits no bare `data-liberation` attribute. The rule lives in `CAPTURE_VOCABULARY_RULES` (`src/lib/capture-vocabulary.ts`).

## Capture-evidence emission

Emitters keep writing the producer names. One pass, `mirrorCaptureVocabulary()`, writes the consumer name beside each one:

- **Attributes.** The consumer attribute is spliced in directly after the producer attribute, with the producer's value text copied verbatim, quoting and character references included. Both values are therefore identical.
- **Classes.** Consumer tokens are appended to the same `class` value.
- **Everything else is byte-for-byte unchanged.** The pass locates start-tag attributes with a source-located parse and rewrites only those ranges. Text, `<script>` and `<style>` bodies, comments and selector strings are not touched. Markup that HTML tree construction discards, such as a stray `<tr>` outside a table, and `<noscript>` content, which the parse keeps as text, carry no start-tag location and are left as they are.
- **Idempotent.** A consumer name that is already present is not written again.

The pass runs at three points:

| Where | What |
|---|---|
| `exportWebsiteCapture()`, after the last HTML write and before evidence (`mirrorWebsiteCaptureVocabulary`) | Every `*.html` file under `website/`: route pages, embedded documents and their responsive copies. `parts/` are cut from mirrored pages, so they carry both names. |
| `exportWebsiteCapture()`, when interaction states are localized | HTML strings in `interaction-states.json` (dialog, listbox, gallery frame, choice transition and collection fragments). `htmlBytes` is recomputed for every region whose length matched before. |
| `promoteLearnedMotion()` | The source-canvas sandbox script tag it adds to an exported page after export. |

The pass works on whatever reaches those files, so a new emitter's names are mirrored without further change.

### Names in exported HTML

The names below reach `website/` HTML or `interaction-states.json`. The inventory comes from the emitters in `src/` and from the names the full test suite's exports carried. Each gains its consumer name.

| Family | Producer names |
|---|---|
| Dialogs and disclosures | `data-dla-dialog-trigger`, `-panel`, `-close`, `-panel-state`, `-ancestor-state`, `-ancestor-unverified`, `-css`; `data-dla-existing-panel`, `data-dla-observed-placement`; `data-dla-disclosure`, `-base`, `-label`, `-runtime`, `-open-class`, `-closed-class`, `-open-style`, `-closed-style`; `data-dla-local-disclosure`, `-runtime`; `data-dla-exclusive-disclosures`; classes `dla-dialog`, `dla-disclosure`, `dla-dropdown`, `dla-initial-dialog` |
| Listbox and choice groups | `data-dla-listbox-trigger`, `-panel`, `-runtime`; `data-dla-choice-group`, `-index`, `-runtime` |
| Device documents and document scope | `data-dla-device-document`, `-style`, `-body`, `-selection`, `-visibility`, `-unavailable`; `data-dla-document-scope`; `data-dla-selected-document`, `data-dla-selected-viewport`; `data-dla-source-media`; classes `data-liberation-desktop-document`, `data-liberation-mobile-document`, `data-liberation-<profile>-document` |
| Responsive assembly | `data-dla-responsive-source`, `-fragment`, `-fragments`; `data-dla-anchor-fragment`, `-target`, `-source-id`, `-alias`, `-unresolved`; `data-dla-fluid-segment`, `data-dla-fluid-rules`; `data-dla-embedded-responsive`; classes `data-liberation-desktop-only`, `data-liberation-mobile-only`, `data-liberation-responsive-<hash>`, `data-liberation-responsive-class-<hash>`, `data-liberation-responsive-counterpart-<n>`, `dla-embedded-<digest>-<document>` |
| Collections and status templates | `data-dla-collection`, `-item`, `-members`, `-category`, `-category-control`, `-index`, `-mode`, `-field`, `-empty`, `-status`, `-runtime`, `-visibility`; `data-dla-status-template`, `data-dla-status-hide-zero` |
| Galleries and slideshows | `data-dla-gallery`, `-direction`, `-index`, `-initial`, `-sequence`, `-slot`, `-stage`, `-source`, `-frame`, `-image`, `-full-image`, `-text`, `-display`, `-close`, `-capture-width`, `-runtime`, `-visibility`; `data-dla-captured-slide`, `data-dla-captured-slideshow`, `data-dla-pager-stage`, `data-dla-pager-control` |
| Glyph colour | `data-dla-glyph-color` ([glyph-color.md](glyph-color.md)) |
| Native state and motion | `data-dla-native-control-state`, `-control-runtime`, `-effects`, `-node`, `-profile`, `-losses`, `-view-timeline-runtime`; `data-dla-viewport-entrance`, `-entrances`, `-entrance-loss`; `data-dla-source-canvas` |
| Platform and source evidence | `data-dla-access-gate`, `data-dla-member-login` (and class `dla-member-login-<provider>`), `data-dla-source-evidence`, `data-dla-reclaimed-space`, `data-dla-constructed-stylesheet`, `data-dla-ported-embed`, `data-dla-unported-embed`, `data-dla-squarespace-header-style` |

### Names that stay out of exported HTML

These never reach `website/`, so nothing mirrors them:

| Name | Why |
|---|---|
| `data-dla-geometry-id` | Layout identity for evidence. Export strips it from website pages (`withoutGeometryIdentities`); only the private identity copy keeps it. |
| `data-dla-glyph-probe`, `data-dla-glyph-probe-style` | Glyph colour sampling marks, removed before serialization. |
| `data-dla-check-route-tab` | Set by `fidelity check` on the live comparison page. |
| `data-dla-visual-iframe-src`, `-width`, `-height`, `data-dla-embedded-document` | Read and consumed by export when it rewrites the frame. |
| `data-dla-fluid-id`, `data-dla-fluid-ignore-padding`, `data-dla-fluid-sheet-rules`, `data-dla-video-frame`, `data-dla-squarespace-video` | Capture-time measurement and media markers. |
| `data-dla-resting-panel`, `data-dla-native-runtime-loss`, `data-dla-document-unavailable` | Set in the browser by DLA runtime scripts, never in the static markup. `data-dla-viewport-entrance-loss` is in both: export also writes it for invalid entrance evidence. |

If any of these reaches `website/` after a future change, the pass mirrors it like every other name.

Class-like `dla-*` strings that are not class tokens are out of scope: element ids (`main--dla-mobile`), CSS cascade layer and keyframe names inside DLA stylesheets, and temporary directory prefixes.

## Rollout

1. **This release writes both names** in exported HTML and interaction states, and both findings files (`capture-findings.json`, `source-findings.json`; [loss-ledger.md](loss-ledger.md) section 5.2). Merge and release this first.
2. **Blocks Engine and Static Site Importer read only the consumer names** and delete their readers of the producer names. They merge after step 1 is in production.
3. **This repository stops writing the producer names.** In `mirroredMarkup()` the splice that inserts the consumer name after the producer attribute becomes a replacement of the producer name, and the class splice replaces the producer token. DLA's own runtime scripts and stylesheets in the exported page still select the producer names (`[data-dla-dialog-trigger]`, `.dla-dialog`, `[data-dla-collection]`, `[data-dla-device-document]`, ...), and so do the selector strings in `interaction-states.json`. Step 3 moves those literals to the consumer names in the same change, using the same rule. The `data-liberation/...` schema identifiers of sidecar JSON files are a separate contract and are not covered by this rule.
