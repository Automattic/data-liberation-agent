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

The capture is bounded to eight ancestors, 32 attributes per ancestor, 4 KiB per
attribute value, and 32 KiB of changed-state evidence. `status: verified`
requires source actions to conceal the panel and restore the original ancestor
nodes and attributes. Missing identities, replaced nodes, exceeded bounds, and
failed restoration produce `status: unverified` with a reason. The receipt
summarizes these as `ancestor_state_unverified_count`.

Portable wiring binds verified evidence to matching local owners before
emitting replay. A later owner edit or missing source slot leaves an explicit
`data-dla-dialog-ancestor-unverified` marker. Source-placed panels keep their
observed root and layout rather than gaining a synthetic absolute-positioned
wrapper. Closing one control preserves an ancestor still owned by another open
control; closing the last owner restores the recorded closed state.

The screenshot pipeline restores its canonical top-scroll state before
interaction probes. A preceding scrolled screenshot therefore cannot hide the
top-state transition that the portable baseline must replay.

Consumers can map these generic source transitions onto their own state and
layout primitives. Source-to-portable interaction proof and downstream
projection remain distinct acceptance stages; this evidence does not claim
whole-site visual parity or unsampled interaction combinations.
