# Matched-policy device checks (#1155)

A resource-blocked phone DOM cannot be compared with capture's fully loaded desktop. Image load handlers and embed hydration can change structure. Per-route checks therefore load **both** identities in parallel using the existing bounded check policy, including blocking sub-frame documents. The capture desktop is left untouched. The `device-check` phase remains attributed to its desktop profile.

The provider's bmoa evidence showed 39/40 routes becoming dual after #1151, versus predominantly reflow-only decisions before it. `/collection` took 9,738 ms and became dual; its previous decision was export-equivalent. The large path difference was not proof of a mobile document.

## Measurement

A two-route live sample of bmoa (entrypoint and `/collection`, concurrency 1, fluid learning disabled) compared matched blocked-resource loads with a temporary matched unblocked-resource variant of the same check. These are wall-time samples, not a controlled benchmark or verification of all 138 historical routes.

| Policy / route | Navigate | Settle | Equivalence | Recheck | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Blocked / entrypoint | 2,762 | 1,675 | 38 | 0 | 4,470 |
| Blocked / collection | 3,714 | 1,732 | 85 | 0 | 5,543 |
| Unblocked / entrypoint | 3,368 | 2,337 | 61 | 0 | 5,715 |
| Unblocked / collection | 8,333 | 1,782 | 54 | 0 | 10,055 |

All values are milliseconds. Navigate includes context setup and response reading; settle includes cleanup, scrolling, removals and signature reading. These two fields are the slower identity's elapsed time, not summed CPU time. Total includes context closing, unlike the existing `checkMs` field. Navigation and settling dominate; retaining blocked resources avoids their added cost. Both sampled routes returned to reflow-only without the delayed recheck, versus 5,354/9,738 ms in the supplied regression log.

The check keeps the early export-equivalence test from #1151. With matched inputs this now avoids the unnecessary delayed read for runtime-only differences. Its serialized documents are reused for the final decision rather than read twice. Genuine structural or body-class differences still settle and recheck; server HTML differences still keep dual capture.

`checkTimings` on each route decision and `[timing] device-check` stderr records expose navigate, settle, equivalence and recheck costs. The generic regression fixture inserts content on image load, alongside a phone-only runtime widget; it fails under the original full-desktop/blocked-phone comparison. The fixture shares its capture with existing dual/reflow and phase-attribution assertions rather than adding another browser run.
