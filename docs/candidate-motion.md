# Independent source/candidate motion comparison

A captured HTML site can preserve the final visual state but still lose its
source's timers, canvas drawings, or click interactions. The capture receipt
records these as unreproduced source signals; plain `compare` remains red.

When an independently built candidate implements the interactions (for example,
using editable WordPress blocks), describe the **observable** behaviors to test
in a JSON file:

```json
{
  "widths": [390, 768, 1440],
  "routes": {
    "/": {
      "ready": {
        "source": "body:not(.loading)",
        "candidate": "body:not([aria-busy=true])"
      },
      "text": ["#clock-hour", "#clock-minute", "#status"],
      "clock": {"hour": "#clock-hour", "minute": "#clock-minute", "format": "12h"},
      "canvases": ["#drawing"],
      "clicks": [{"trigger": "#status-button", "target": "#status"}]
    }
  }
}
```

Run `data-liberation compare <capture-dir> --candidate <url> --motion-contract
<file.json>`. The same contract is available as `motionContract` to the runtime
API and MCP `compare` tool. Selectors refer to each page's own DOM; the candidate
runs only its own scripts. The probe waits for each page's explicit ready selector
to be **attached**, which also supports hidden readiness markers. It verifies
that tracked text settles to the source's values and enters the same first
visible phase, that visitor-local clock digits are current on each side, and
that a canvas stays idle without input but changes after a pointer move. Each
authored click must change the target, restore it, and enter the source's first
visible replay phase. Unsupported source signals, missing probes, timeouts, and
incomplete readiness fail closed. A contract proves only its named selectors,
routes, and widths; list all interactions whose parity you intend to claim.

The result retains separate facts: `raw source/capture motion unreproduced` and an
independent `source/candidate interaction` verdict. Without a verified authored
runtime, comparison of the portable HTML capture hard-fails on source motion.
With an independently passing candidate at 390, 768 and
1440px, a candidate comparison may pass; it **does not** make the motion-free
portable artifact interactive. Per-width source/candidate traces and failures
are saved to `compare/candidate-motion-evidence.json`.

## Authoring behavior in the portable capture

An author may also include a separately implemented, self-contained runtime in
the HTML artifact, without restoring the captured site's scripts. Pass
`--portable-motion <recipe.json>` to the normal liberation command, or call
`authorPortableMotion(runDirectory, recipe)` after capturing an existing run.
The recipe is a versioned `data-liberation/portable-motion/v1` object with the
same `contract` shown above and a `routes` map:

```json
{
  "schema": "data-liberation/portable-motion/v1",
  "contract": { "widths": [390, 768, 1440], "routes": { "/": { "ready": { "source": "body:not(.loading)", "candidate": "[data-motion-ready=true]" }, "text": ["#status"], "canvases": ["#drawing"], "clicks": [{"trigger":"#replay", "target":"#status"}] } } },
  "routes": {
    "/": {
      "elements": [{"selector":"#drawing", "attributes":{"data-motion-effect":"ripple"}}],
      "busyHidden": ["#status-indicator"],
      "markers": [{"attribute":"data-motion-sequence", "value":{"target":"#status"}}],
      "scripts": [{"path":"/absolute/path/to/independently-authored.js", "sha256":"<64-character SHA-256>"}]
    }
  }
}
```

`elements` only adds `data-*` attributes to one existing captured element.
`busyHidden` is optional: a named element remains hidden while an authored
finite sequence sets `body[aria-busy=true]`. `markers` carry inert JSON
configuration for authored runtimes. The scripts must be independently authored,
outside the capture run, and hash-pinned. Any script whose hash matches captured
source code is rejected. No WordPress or destination runtime is shipped by Data
Liberation; the author chooses reusable scripts that read text from the DOM so
edits remain meaningful. Routes must have an unreproduced source-interactivity
diagnosis. The site is staged, checked offline and verified against the live
source at the contract's widths before the public `website/` tree is changed.
Failure leaves the original capture intact. The successful `portable-motion.json`
receipt stores relative script paths and hashes, not absolute source paths.

Thereafter plain `data-liberation compare <run-dir>` checks those hashes and
**reruns** the live source-versus-portable runtime contract. A missing/changed
script or failed startup, canvas, clock, visibility or click probe does not
inherit the earlier pass. The report distinguishes the removed raw source script
from the separately authored, proven interactive portable output. An exported
`website/` directory remains runnable without the CLI or any network access.
