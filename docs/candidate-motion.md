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

The result retains separate facts: `source/capture motion unreproduced` and an
independent `source/candidate interaction` verdict. Without the contract,
including when comparing the portable HTML capture, unreproduced source motion
remains a hard failure. With an independently passing candidate at 390, 768 and
1440px, a candidate comparison may pass; it **does not** make the motion-free
portable artifact interactive. Per-width source/candidate traces and failures
are saved to `compare/candidate-motion-evidence.json`.
