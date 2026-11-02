## Problem

Fixes #1188.

A captured drawer can remain hidden after opening because its source toggles classes on `html` or `body`, outside the bounded local ancestor capture. Responsive export moves those classes to document wrappers.

## Change

Capture added/removed root class tokens and retain them only when the source close action restores them. Export binds those transitions to the owning root or responsive document wrapper through the existing captured-dialog ancestor-state contract, superseding duplicate local class bindings. No platform-specific logic or second replay implementation is added.

The neutral public `captureWebsite` regression fixture exports a root-gated five-link drawer and exercises opening, toggle-close and Escape at phone and desktop widths, including isolation of the inactive document scope. Expected isolated wall time is about 12 seconds.

Reduce the unrelated diagnostic-bounds fixture from 24,000 styles to 1,200: this still exceeds the 31 KiB diagnostic sample budget and asserts exact aggregate counts, truncation and bounded output without stress-testing every export pass or raising its timeout.

### Blocks Engine / SSI contract

DLA's existing standalone replay already applies root class changes through `data-blocks-engine-capture-dialog-ancestor-state` on the trigger. Each root binding has `depth` (parent hops from the trigger), `closed: { class: "removed tokens" }`, `opened: { class: "added tokens" }`, and `classTokensOnly: true`. On open, remove closed-only tokens and add opened-only tokens before showing the panel; on close, reverse this. Preserve unrelated classes. Bind to the owning responsive wrapper rather than the host body where applicable, and retain/rebase depth bindings if import moves the trigger. Toggle-close, Escape, close buttons and responsive deactivation must restore state; an owner still needed by another open control must retain that control's state. Downstream BE must honor this contract if its importer/runtime does not already do so; no BE runtime change is included here. See `docs/dropdown-ancestor-state.md`.

## Verification

- Fail-before: temporarily restored both changed production files from the pre-fix parent and ran `npx vitest run src/lib/capture-root-class-state.test.ts`. It failed at the post-click visibility assertion: links remained hidden. Restored the fix; the same test passed.
- Diagnostic-bounds check passed in 138 ms with the smaller fixture.
- `npm ci --silent && npm test`: the reported export timeout did not recur; 283 files passed. Eleven CLI/MCP checks failed because tsx attempted a Unix socket beneath this runner's excessively long temporary path (`listen EINVAL`). All four affected files passed with `TMPDIR=/tmp`.
- `TMPDIR=/tmp npm test`: 287 files passed, 1 skipped; 2,715 tests passed, 4 skipped (521 seconds).
- `npm run build` and `TMPDIR=/tmp npm run test:package`: passed. Generated `dist/` changes restored.
- Real-site WordPress/Blocks Engine import acceptance was not run; the neutral public capture/export/browser replay is verified, not downstream imported-site parity.

## AI disclosure

Implemented and verified using model `cook-heavy` (Roadie provider) through the Pi coding agent and its file/shell tools. The harness does not expose a more specific underlying model identifier.
