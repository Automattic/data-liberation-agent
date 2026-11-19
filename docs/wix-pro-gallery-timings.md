# Wix Pro Gallery: homepage measurement for #891

## Decision

Stop at the measurement gate: this run does not establish Pro Gallery geometry learning as the capture bottleneck. No adapter change is proposed, and this report does not claim to fix #891 or #2062. The requested conditional stop takes precedence over implementing speculative CSS.

AI disclosure: Authored by Claude via Homeboy Cook.

## Reproduction

Measured on the unmodified v0.37.6 checkout (`1a63ec3d`):

```sh
TMPDIR=/tmp npm run liberate -- https://www.blocpopulaire.fr/ \
  --route-limit 1 --output .tmp-probe/before
```

`TMPDIR` avoids tsx's Unix socket path-length limit in the deeply nested workspace. No route deadline or resource-blocking overrides were supplied. Capture completed with 1/1 routes, 207 omitted by the route budget, and zero failed routes. This did not reproduce the reported 600-second tablet abandonment.

Local raw evidence (ignored, not portable repository fixtures): `.tmp-probe/before.log` and `.tmp-probe/before/www.blocpopulaire.fr/screenshots/manifest.json`.

## Route wall-clock breakdown

The existing `[timing] route-phases` ledger reports 215.503 seconds. Its wall-clock attribution accounts for overlapping profiles; the per-profile timings below must not be summed to obtain route time.

| Phase | Seconds |
| --- | ---: |
| fluid (entire phase, not just geometry learning) | 64.032 |
| observe-source (frozen-reference evidence) | 60.462 |
| baseline-snapshot | 25.304 |
| serialize | 13.335 |
| settle | 10.268 |
| navigate | 9.014 |
| selectable | 7.873 |
| dialogs | 6.193 |
| lazy-load | 4.342 |
| baseline | 3.948 |
| root-class | 3.176 |
| shared-chrome | 1.518 |
| typed-search | 1.452 |
| layout-geometry | 1.341 |
| scroll-states | 1.119 |
| resource-settle | 0.734 |
| context | 0.500 |
| sections | 0.253 |
| glyph-colors | 0.167 |
| script-motion | 0.150 |
| before-serialize | 0.084 |
| context-close | 0.073 |
| analysis | 0.054 |
| native-timelines | 0.033 |
| cleanup-audit | 0.031 |
| other | 0.016 |
| chrome | 0.014 |
| galleries | 0.008 |
| collections | 0.006 |
| exclusions | 0.002 |
| components | 0.001 |
| record | 0.000 |

## Geometry sweep versus the phase named `fluid`

| Profile | Entire fluid phase (s) | Instrumented geometry learner (s) | Sampled widths |
| --- | ---: | ---: | --- |
| mobile | 6.527 | 2.157 | 390, 768, 1920 |
| desktop | 62.249 | 7.425 | 390, 768, 1920, 600, 1024, 1440, 320, 360, 414, 900, 1536, 1200 |
| tablet | 8.927 | 3.719 | 390, 768, 1920 |

The instrumented learner totals **13.301 seconds**, only 6.2% of route wall time even before accounting for profile overlap. Width sampling itself totals 10.547 seconds (resize, rest, measurement and runtime stylesheet observation).

Do not mistake the 64-second `fluid` phase for Pro Gallery geometry learning. `baseline-steps.ts` runs `captureViewportClassStates` inside that phase, **before** the adapter's `beforeFluid` hook. `learnAndApplyFluidGeometry` also performs height lifting, baseline capture and cleanup outside the instrumented `learnFluidGeometry` interval. The existing instrumentation does not separate those operations. The desktop phase alone has 54.824 seconds outside the instrumented learner; attributing that difference entirely to galleries or entirely to class observation would be guessing.

## Source observation and other costs

Per-profile `observe-source` took 18.226 seconds mobile, 17.910 seconds desktop and 37.234 seconds tablet (60.462 seconds wall-clock attribution). This phase collects frozen source evidence; it is not a separately timed Pro Gallery observer. The explicit gallery interaction phase took 5 ms mobile and 5 ms desktop (8 ms wall-clock attribution). Neither number establishes the gallery-specific portion of source observation.

Outside route time: discovery 25.439 seconds; browser-capture 238.418 seconds including route work; section-media 5.630 seconds; export 13.990 seconds; homepage-preview 5.587 seconds; behavior-discovery 0.027 seconds; reference-finalize 0.011 seconds. Initial shared-chrome probes reported 21.816 seconds mobile and 22.052 seconds desktop; these overlap and are not additive to browser-capture.

The measured costs to investigate are frozen-reference observation and the unseparated work around geometry learning, not a presumed minutes-long Pro Gallery geometry sweep. The production load/deadline failure remains unexplained by this successful run.

## Scope and follow-up

No after timing, compare parity claim, or regression test is presented because no behavior was changed. In particular, this run does not resolve the 513 px versus 353 px geometry report in #2062. Following the explicit stop condition, no new live layout classification of blocpopulaire.fr or ketatov.com was attempted. The earlier ketatov.com measurements in #891 remain historical evidence, not measurements repeated here; #895 already carries horizontal strip widths at serialization.

A subsequent performance investigation should separate viewport-class observation, height lifting/baseline work, and frozen-reference preparation before choosing an adapter optimization. A gallery declaration must still prove its column policy and responsive boundaries; a uniform box at one width is not that proof.
