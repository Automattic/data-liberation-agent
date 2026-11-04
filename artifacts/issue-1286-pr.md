# Share counterpart stylesheet nodes in responsive assembly

## Summary
Reduce mobile-gated SSR CSS by sharing aligned, byte-identical top-level nodes, including atomic at-rule blocks. Preserve cascade order and keep identical linked stylesheets unconditional.

## Root cause and real-source finding
Whole-sheet comparison replayed a near-identical phone stylesheet whenever any rule differed. The initial rule-level projection still rejected any sheet containing a non-rule node, so its flat fixture passed while the real Framer path never ran: the Leistungen phone SSR sheet contains 30 `@supports` and 6 `@media` blocks.

The supplied real-source comparison of https://schwartz-webdesign.framer.website/ found effectively zero reduction on all six subpages under `(max-width:1199px)`: Leistungen 77,806 → 77,809 B, Kontakt 92,171 → 92,156 B, Projekte 79,813 → 79,816 B (trunk → initial branch). These are before this revision, not new post-fix capture measurements.

## What changed
- Compare top-level nodes by `node.toString()`, treating `@supports`, `@media`, `@font-face` and `@keyframes` as indivisible units.
- Share the safe common prefix and replay the phone delta in order; later common nodes remain in the replay because they may override earlier phone changes.
- Fall back to full replay for duplicate keys in either sheet, reordered common nodes, unaligned sheet layouts, and order-sensitive `@import`, `@layer` or `@charset` declarations/blocks.
- Replace the flat fixture with Framer-shaped flat rules, repeated conditional blocks, font-face and keyframes. Assert exactly two changed flat rules and one changed media block replay; compare computed styles, including media-delta letter spacing, at 390 and 1440.
- Remove the unrelated stylesheet-retry implementation and its two test edits. If stylesheet reset retries are needed, handle them in a separate follow-up outside #1286.

## Compatibility
Additive optimization; ambiguous or order-sensitive sheets retain full replay. No public API changes.

Closes #1286

AI disclosure: Homeboy/Pi assisted with implementation, tests and this description; prior investigation by Claude via Roadie/Pi. The real-source before measurements above were supplied by the reviewer.
