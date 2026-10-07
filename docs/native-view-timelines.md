# Native script-created view timelines

Source scripts can create `Animation(new KeyframeEffect(...), new ViewTimeline(...))`
without leaving an authored animation rule in the document. Removing those scripts
previously removed the effect, including its baseline transform. The authored CSS
animation preservation paths cannot recover keyframes that were never in CSS.

Capture now observes every script-created native view-timeline effect through
`document.getAnimations()`, `KeyframeEffect.getKeyframes()/getTiming()`, the
timeline's `subject`, `source`, `axis` and `inset`, and the animation's public
attachment ranges. CSS animations and transitions remain with their existing paths.
The evidence records all observations and explicit losses in
`native-view-timelines/<profile>/<route>.json`; the screenshot manifest and capture
receipt link those files by the source profile's string identity.

Capture restores the at-top baseline after earlier browser probes. A click on an
offscreen control can leave the viewport below the subject, where a native effect
legitimately reports `finished`; that incidental probe position is not the cold
source baseline used for serialization and motion observation.

Chromium currently does not expose an inset getter. For that case capture compares
the source timeline's public `startOffset`/`endOffset` against a default native
timeline on the same subject at every probe. Only independently verified default
semantics are carried as `auto`; a non-default, unreadable inset is an explicit
loss rather than an assumed default.

Phase is also verified through public APIs. At each sample an empty-keyframe native
animation on the same connected target/timeline is played with the observed timing
and attachment ranges; its resolved `startTime`/`currentTime` must match the source.
The probe has no animated CSS properties and is cancelled after observation.
Explicit script-controlled phase shifts remain losses instead of being silently
reset to native attachment alignment.

## Range evidence

The capture probes two other heights and another width/height, restores the initial
viewport and scroll position, then re-observes the effects. Identical serialized
attachment ranges remain identical: a fixed px range is not turned into a viewport
formula, and a percentage range stays a percentage.

The only inferred relationship currently supported is a `cover` px offset equal
to **subject client extent + timeline source client extent**, with at least three
different independently observed extents and every observation agreeing. The
actual source element and writing-mode/axis determine the extent; `innerHeight`
and transformed bounding rectangles do not. Other changing relationships remain
explicit losses. This is bounded observational evidence, not recovery of source
code or proof outside the sampled source regime.

The sum model requires exact equality: measured client extents are integers.
A source offset such as `extent + 0.005px` remains an unsupported relationship;
it is never rounded into the sum model. Unchanging fractional px ranges retain
their observed serialized value.

Every new source evaluate and viewport transport is bounded by the capture's
`evaluateTimeoutMs` deadline through `withEvaluateTimeout`, including native
snapshot/alignment observation, baseline reset, binding emission and restoration.
Probe and restoration failures produce `status: "unproven"`, preserve partial
measurements and explicit losses, and cause the owning pipeline to record an
evaluate failure and stop before serializing the nonresponding source. Restoration
attempts are separately bounded; a timeout does not assume the renderer recovered.

## Portable contract and destination conversion

The target carries `data-dla-native-effects` (a JSON list, preserving every effect)
and `data-dla-native-profile`. Subjects and non-root scroll sources are referenced
by `data-dla-native-node`, rather than authored IDs that responsive assembly can
rename. `source: "root"` names the document's scrolling element. Dual responsive
documents carry `data-dla-document-scope`; their subjects resolve within that scope.
Native-effect documents remain dual rather than collapsing away a profile's
bindings. The capture receipt's `nativeViewTimelines.binding` declares these
attributes for consumers.

This is one generic document boundary, independent of motion and device naming.
Every #550 device wrapper must carry `data-dla-document-scope` alongside its
`data-dla-device-document` attribute. Each wrapper encloses exactly one source
profile document. Node tokens may repeat across wrappers; resolution is limited
to the target's nearest marked document scope (excluding nested document scopes).
A single unwrapped document resolves against the document itself. Missing or
ambiguous local subjects/sources remain runtime losses, never cross-profile
fallback bindings. Legacy responsive wrappers already emit this same marker.

A native WordPress converter must carry these bindings and document scopes into
its native elements, or explicitly report a conversion loss. Moving a target,
subject or scroll source into a different scope/scroll container changes the
timeline semantics. Keeping only an authored ID or the target's baseline matrix
does not preserve this contract. Destination runtime integration and WordPress
scroll/resize parity are separate downstream gates.

The exporter adds its own native runtime after source sanitization, alongside the
existing owned interaction-runtime emission. Source scripts are still removed.
The runtime reconstructs native `KeyframeEffect`/`Animation`/`ViewTimeline` objects;
the browser owns scroll progression and easing. Using native WAAPI here preserves
multiple effects, their composition and authored CSS animation lists on the same
element without rewriting those lists. It does not emulate progress in a scroll
handler. Only validated responsive attachment offsets use a `ResizeObserver`
updater. Hidden responsive variants mount when they become rendered.

## Explicit limits

- Changed or ambiguous effect identity, timing, axis, inset or source across probes.
- Unvalidated changing attachment ranges.
- Source phase that does not match independently observed native range alignment.
- Non-element/pseudo-element targets, bindings outside portable body content,
  non-running playback, non-unit playback rate, and non-replace iteration composition.
- Keyframe values containing unresolved custom-property references or resource URLs.
- Unsupported browser `ViewTimeline` capability or changed portable scroll source
  (reported by `data-dla-native-runtime-loss`).

Motion parity is not inferred from preservation counts. The neutral Chromium gate
compares exact transforms and geometry at four sizes, baseline/in-view scroll
positions and return-to-top, checks fixed/percentage attachment ranges, distinct
effects on one target, profile switching, and running authored CSS animation.
It retains source traces, comparison measurements and exported HTML in
`.tmp-test/native-view-timelines-551/`.

Run the offline gate:

```sh
npx vitest run src/lib/screenshot/native-view-timelines.test.ts
```

A separate bounded Lore canary records desktop translation, phone perspective,
and the phone background's distinct no-op effect:

```sh
npx vitest run --config test/canary/native-view-timelines.config.ts
```

Its `.tmp-test/lore-native-view-timelines-551/` directory includes fresh per-profile
localized captures and exact photo-transform/geometry measurements at baseline,
three actual in-view positions and return-to-top, under matching source/portable
browser profiles. All external requests are blocked during portable rendering;
existing unlocalized external iframe document requests remain in the request
trace. A separate `.tmp-test/lore-native-pipeline-551-*/` capture verifies the
desktop photo through the owning browser pipeline and exporter. These bounded
photo gates do not establish full-site visual parity or downstream WordPress parity.
