# Capture speed: #1165 and #805

## Before (immutable provider ledger)

`bmoa5.log` contains 154 device checks averaging **9,105 ms**, and 153 route-phase rows. Browser capture took **974,298 ms**, with **153 captured / 0 failed**. The manifest contains 154 entries: **152 reflow-only / 2 dual**.

Across the route-phase rows, fluid total is **827,325 ms**, median **3,975 ms**, and p90 **9,185 ms** (nearest lower rank). The homepage applies 174 rules with 0 unmodelled and samples seven widths. These are measurements of the supplied baseline, not a new live run.

## After (local Chromium fixtures, not a bmoa extrapolation)

- Tiered identity fixture: first rendered proof **2,108 ms**; subsequent known-script route **14 ms**, with no script requests. New UA-sensitive script and different UA-dependent server HTML both remained dual. A disconnected request retried and inherited the proof on attempt two (**15 ms**).
- Constant runtime-sheet fixture: reverting the sampling condition samples **6 widths** (`390,600,768,1024,1440,1920`); the new condition samples **3** (`390,768,1920`), with 0 unmodelled. The reverted regression fails. Isolated test-file elapsed time was **2.80 s before / 1.77 s after**; this includes browser startup and is not production phase timing. A different after run under load took 3.42 s, so width count is the deterministic cost assertion.
- Existing varying-sheet fixtures still compare adaptive output against the full ladder's emitted rules. Existing route fixtures still preserve real UA-driven structure and body-class differences. Inline runtime hashes prevent different route-local code from inheriting external-script coverage.

No route selection, rendition limit, readiness window or full-capture quality policy changes. Lazy-sweep reuse already exists in this checkout and is retained; no geometry is recalled across routes by this change.

## Limits

Full bmoa wall-time and capture-stage compare parity were not measured here. An attempted live CLI capture of example.com failed because both source renderers crashed, before a rendered homepage could be exported, so there was no usable run to compare. Fixture results are not a claim of live-site fidelity parity or a projected bmoa wall-time saving.

AI assistance: the coding assistant read the issues and provider ledger, implemented the changes and regression tests, and ran the local verification and measurements.
