# Share counterpart stylesheet rules in responsive assembly

## Summary
Reduce mobile-gated SSR CSS while preserving cascade and keeping identical linked stylesheets unconditional.

## Root cause
Sharing compared whole inline stylesheet strings. A single changed rule therefore replayed the entire mobile sheet. The fix projects aligned counterpart sheets with the existing PostCSS utilities, shares their safe common prefix, and replays changed/added rules in source order. Later identical rules remain in the delta because they can override earlier mobile-only rules. Identity-subset aliases use the same selection. Ambiguous layouts, duplicate/reordered rules and at-rules retain conservative full replay.

The Framer-style fixture has two common CSS links and ten desktop SSR rules, with one changed and one added phone rule. Before: head 718 bytes, mobile CSS 254 bytes. After: head 549 bytes, mobile CSS 38 bytes. The fixture's links were already deduplicated on trunk's collapse path; they remain two unconditional links, not four. Computed styles match the source captures at 390 and 1440.

## Gate repair
Reproduced the previous full-suite failure: resetting-origin capture lost a stylesheet (12/11/12 loaded). Native request observation recorded the reset but could not retry a continued request. Same-origin stylesheets now use the existing governed fetch/retry path; images/video retain native streaming and range behavior. Added a cheap reset/retry regression test; the existing browser test confirms all 12 sheets load on every route, with healthy fan-out uncapped.

## Tests
- `npx vitest run src/lib/responsive-assembly.test.ts`: 32 passed.
- `npx vitest run src/lib/browser-kit/source-traffic*.test.ts`: 4 passed (~15 seconds).
- `npx vitest run src/lib/responsive-assembly.test.ts && npm test`: passed; full suite 305 files passed, 1 skipped; 2,811 tests passed, 4 skipped (~765 seconds).
- Framer computed-style regression uses Chromium (~6 seconds for the responsive-assembly file in the final gate run).

Closes #1286

AI disclosure: Homeboy cook; investigation by Claude via Roadie/Pi.
