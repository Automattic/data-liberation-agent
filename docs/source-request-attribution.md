# Source request attribution

Capture appends `attribution=[...]` to the existing `[source-requests]` stderr line and writes `source-request-attribution.json` beside the capture artifacts. This is diagnostic only: it does not change admission, retries, replay eligibility, or the existing network request/category counters.

Summary keys are `<device>/<phase> <outcome>`, for example:

```text
[source-requests] [{"origin":"https://example.com","requests":24,"requestCounts":{"document":2,"device-check":2,"asset-original":0,"subresource":20,"refusal-probe":0,"retry":0},"throttleEvents":0,"concurrency":6,"sustainedRate":4}] attribution=[{"origin":"https://example.com","totals":{"desktop/navigate miss:no_entry":10,"desktop/navigate hit":10,"desktop/settle not_routed":4}}]
```

Devices are `desktop`, `mobile`, or `unattributed`. Browser profile phases follow the existing route phase ledger; device checks, template grouping and HTTP media acquisition have their own labels. Unknown contexts/phases remain `unattributed`. Request labels are snapshotted when issued, not when the response finishes.

Subresource replay outcomes are `hit`, `miss:type_not_replayable`, `miss:no_entry`, `miss:vary_mismatch`, `miss:stale`, `miss:uncacheable`, or `not_routed`. The last means no replay decision was made for that request; documents and HTTP-only requests also use it. A hit counts toward attribution, but **not** toward existing source network totals. Misses are counted by the existing governed request path, including its retries.

The version 1 report contains per-origin `totals` and a globally sorted `repeatedUrls` list (at most 50), with counts by device/phase. No request or response bodies, cookies, or headers are recorded. URLs may contain source query parameters; treat the report like other capture diagnostics.

To bound memory, URL tracking retains the first 10,000 distinct URLs per origin (at most 2,048 characters each); `droppedUrlRequests` reports omissions. The top list is exact within that tracked set. Totals continue even when URL detail is omitted. Phase/outcome cardinality is bounded; excess labels fall back to `unattributed/unattributed`. Report write failures do not fail capture.
