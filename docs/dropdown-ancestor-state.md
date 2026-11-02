# Captured dropdown ancestor state

Opening a dropdown can change its parent as well as reveal its panel. A header
can gain a background, border, or different layout while the panel occupies an
in-flow slot. `dialog.ancestorState` in the interaction report retains that
source evidence for portable replay and downstream consumers.

```json
{
  "status": "verified",
  "ancestors": [
    {
      "selector": "#header",
      "tag": "header",
      "depth": 2,
      "closed": { "class": "closed", "data-open": null },
      "opened": { "class": "opened", "data-open": "" }
    }
  ],
  "placement": {
    "parentSelector": "#header",
    "parentDepth": 2,
    "beforeSelector": "#tail",
    "position": "static"
  }
}
```

Selectors come from the existing baseline identity map. Depths count parent
elements from the authored trigger. A null attribute means it was absent.
Ancestor rows contain only observed changes to class, style, hidden, ARIA, and
source data attributes. Internal capture/runtime probe attributes are excluded.
Placement names the original parent and, when present, its following sibling.

The capture is bounded to eight ancestors, 32 attributes per ancestor, 2 KiB per
recorded attribute value, and 32 KiB of changed-state evidence. 2 KiB is the
smallest value bound a consumer applies: Blocks Engine drops longer values.
Unchanged attributes do not count against the value bound. Consumers replay
`class` as tokens, so a class list over 2 KiB (a Squarespace `body` carries its
whole style configuration as classes) is recorded as the tokens opening removed
(`closed`) and added (`opened`), plus up to three unchanged tokens in both
states, and its row is marked `classTokensOnly: true`. The unchanged tokens keep
the element identifiable to a consumer that matches an ancestor by its closed
tokens; replaying them is a no-op. Class changes and restoration compare token
sets, so a runtime that re-adds a theme class on close in a new order still
verifies. `status: verified`
requires source actions to conceal the panel and restore the original ancestor
nodes and attributes. Missing identities, replaced nodes, exceeded bounds, and
failed restoration produce `status: unverified` with a reason. The receipt
summarizes these as `ancestor_state_unverified_count`.

A modal records the same evidence when opening it changed an ancestor. A
Squarespace overlay menu, for example, is shown only by a class its runtime
adds to `body`. Placement is optional for a modal because its consumer mounts
it; a modal that changed no ancestor records no `ancestorState`. Portable
wiring replays a modal's verified ancestor changes from its trigger and keeps
the modal's own mount.

Portable wiring binds verified evidence to matching local owners before
emitting replay. A later owner edit or missing source slot leaves an explicit
`data-blocks-engine-capture-dialog-ancestor-unverified` marker. Source-placed panels keep their
observed root and layout rather than gaining a synthetic absolute-positioned
wrapper. Closing one control preserves an ancestor still owned by another open
control; closing the last owner restores the recorded closed state.

The screenshot pipeline restores its canonical top-scroll state before
interaction probes. A preceding scrolled screenshot therefore cannot hide the
top-state transition that the portable baseline must replay.

## Root class changes

Dialog capture also records `dialog.rootClassState`, independently of the local
ancestor depth limit. Each row is `{ root: "html" | "body", removed: string[],
added: string[] }`: only the class tokens changed by opening are retained. Rows
are emitted only after the source close action restores those tokens. This
covers deeply nested controls and `html` changes, without capturing unrelated
root attributes or replacing a consumer's full class list.

Export projects these rows into the existing
`data-blocks-engine-capture-dialog-ancestor-state` JSON on the authored trigger.
Each projected row contains `depth` (parent hops from that trigger),
`closed: { class: "removed tokens" }`, `opened: { class: "added tokens" }`, and
`classTokensOnly: true`. Body ownership follows the nearest desktop/mobile
document wrapper when root classes were moved there; otherwise it is the real
root. HTML ownership similarly follows the root carrying its closed tokens.
There is no source-selector or original-tag requirement on this projected owner.
Local ancestor evidence retains non-class attributes and is not duplicated.

Runtime contract (including downstream Blocks Engine / SSI): resolve each owner
from the trigger using the exported depth; opening removes closed-only tokens
and adds opened tokens, closing does the inverse. Preserve unrelated classes,
including consumer-added ones. Apply the transition before displaying the panel;
Escape, close buttons, toggle-close and responsive deactivation must revert it.
An owner still used by another open control retains that control's opened state.
DLA's standalone captured-dialog runtime already implements this contract; a
consumer must retain/rebase these bindings when moving the trigger or its scope.
No source-specific menu class names are part of the runtime contract.

Consumers can map these generic source transitions onto their own state and
layout primitives. Source-to-portable interaction proof and downstream
projection remain distinct acceptance stages; this evidence does not claim
whole-site visual parity or unsampled interaction combinations.
