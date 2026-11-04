# Browser source traffic review evidence — Part of #1266

The healthy path uses `route.continue`, not `route.fetch`/`fulfill`. Browser response and failure events report pressure to the capture-owned origin governor. Only recovery requests acquire a slot, held until `requestfinished` or `requestfailed`; native streaming and range handling remain in Chromium. Document fetch retries are unchanged.

## Local comparison

Same `source-traffic.test.ts` fixture on trunk (13d919e7) and the revised source, separate fresh Vitest processes on the same host. Three routes, concurrency three, twelve stylesheets per route. Healthy pages additionally contain two valid uncompressed 3 MiB BMP images and a valid WebM `<video preload="auto">`; the server implements HTTP byte ranges. The committed 1.8 KiB WebM is a generated two-second blue frame, not third-party content.

| Healthy case | Trunk | Revised |
| --- | ---: | ---: |
| Capture wall time | 4.276 s | 4.201 s |
| Peak Node RSS | 384,792 KiB | 378,100 KiB |
| Captured routes | 3 | 3 |
| Failed routes / throttles | 0 / 0 | 0 / 0 |
| Peak server concurrency | 18 | 18 |
| Video range requests | 15 | 15 |
| Image bytes served | 44,040,948 | 37,749,384 |
| Stylesheets loaded per route | 12 / 12 / 12 | 12 / 12 / 12 |

Wall time measures `captureScreenshots`; peak RSS is `process.resourceUsage().maxRSS` from the Vitest worker (Node only, not Chromium's process tree). Extra image requests vary with browser lazy-load/capture activity. These single-run measurements show no observed regression, not a general performance guarantee.

The resetting mode refuses excess concurrent traffic (more than six requests) and one document navigation. Trunk recorded 13 resets and loaded 0/12/12 stylesheets. The revision recorded 11 resets and loaded 12/12/12, with all three routes captured. The revision takes longer on this deliberately throttling origin (7.128 s versus 4.963 s), because it honors the origin-wide backoff. The threshold allows native browser retries to recover the initial in-flight burst; subsequent requests share governor admission.

The fixture never interpolates request URLs into HTML. Focused event tests cover healthy uncapped continuation, reset and HTTP throttle observations, recovery, slot release, and third-party isolation. Handler tests distinguish fetch transport refusal from header, fulfillment, and other handler errors.

AI disclosure: written by an AI coding agent orchestrated by Franklin (Claude) for @chubes4.
