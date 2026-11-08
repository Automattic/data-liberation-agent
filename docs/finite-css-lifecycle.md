# Source-observed finite CSS animation lifecycle

`viewport-entrances.ts` shares one source observer with the existing CSS transition
entrance path. It records actual `CSSAnimation.play()` calls against an observed
viewport qualification, the source's exact native keyframes/timing, and the
terminal attribute switch after every observed animation's `finished` promise
fulfills. An interrupted animation does not establish completion.

Portable replay restores the observed pending attributes and plays the matching
authored CSS animations on `document.timeline`. It creates no replacement
keyframes or fabricated source handlers. Native ViewTimeline acquisition/replay
remains independent. The legacy scroll-timeline fallback excludes both witnessed
entrance bindings and explicit lifecycle-loss targets, so it cannot give them a
second owner or replace an unproven lifecycle with an invented range.

## Startup versus viewport entry

Hydration can qualify an element while the source still has its initial viewport,
then change the viewport before a deferred `play()` call runs. The qualification
is retained as a witness rather than overwritten by the later nonmatching entry.

Reference collection installs observation before each fresh source navigation,
including contexts constructed at each requested width with their original
device-preset screen. It transfers only unique source target IDs and observed
startup decisions to that profile's capture. The portable binding holds those
decisions at the exact measured document client width/height; it contains no
session credentials. Unobserved startup contexts remain explicit losses.

At a proven startup context replay starts the original CSS layers, even when the
source's transient viewport qualification would be absent from the final portable
head. Ordinary below-fold targets await their exact observed root margin and
threshold. Resize does not restart a completed one-shot effect. A repeating
entrance is emitted only when the source reset/re-entry was witnessed.

## Evidence and limits

`data-blocks-engine-capture-viewport-entrance` carries the action/terminal-state evidence and exact
native CSS signatures. `data-blocks-engine-capture-viewport-entrance-loss` names unavailable source
or replay proof: missing terminal switches, cancellations, ambiguous observers,
unobserved startup contexts, changed keyframes/timing, or unsupported phases.
Visible losses fail the motion check even when animation-name coverage passes.

Custom roots, pseudo-element targets, nonzero-phase imperative resumes and
resource-dependent keyframes remain unproven. Ordinary infinite ambience stays
authored CSS and is outside this finite entrance contract. Inactive source-device
scopes are not reset or replayed.

The controlled scroll proof uses native animation object identity within each
page. Same-name ordinal positions cannot identify an effect: completion/removal
of an earlier sibling otherwise falsely reports a still-paused sibling as
scroll-responsive. Public animation-name multiplicity remains the cross-document
coverage check; lifecycle signatures and losses provide independent action proof.

## Script entrances

Entrances a script drives itself — inline styles written each frame (rAF
springs) or WAAPI animations it plays — have no owner in the copy, which never
runs that script. They ship at the rest pose the source reaches instead of being
replayed (#1466). The same observer notes inline motion writes and WAAPI motion
starts. Before the initial document and again before the screenshot and
serialization, capture settles that motion (`settleScriptMotion` in
`screenshot/capture-state.ts`). If the source showed scroll-triggered motion and
the viewport changed since the last settle, it scrolls the document once. Root-class
probes and width sweeps resize the page, and a runtime that remounts on resize
replays its entrances. Capture then returns to the top and waits, within a fixed
budget, until inline writes stop and finite script animations end. A finished
script animation that holds its end pose by fill is committed to inline style.
CSS animations are only moved to their end on the clock; nothing is written for
them.

A scroll-scrubbed style (#1158) that ever moves while scrolling and resizing have
both stopped is time-driven, so its in-view pose is never stamped over its rest
pose. A return to an earlier pose counts as scroll evidence only when a scroll
caused it, never when a resize remount did.
