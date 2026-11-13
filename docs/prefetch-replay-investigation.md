# Cross-route replay investigation (#1738)

## Finding

#984 landed as #985 (`8874b03b`): shared-cache freshness and removal of the request-cookie veto. #1609 landed as #1614 (`34ac6e49`): Vary secondary keys, including Accept and decoded Available-Dictionary bodies. Neither added Chromium's `other` resource type. The evidence in #1609 already identified 132 immutable prefetch requests among 275 store-origin requests, versus 45 images.

A neutral local HTTP fixture reproduces this omission using `link rel=prefetch`. Chromium reports these requests as `other`, with a prefetch purpose header. They never entered CapturedResourceStore, and getReplayableResponse rejected their type. Routing disables the browser HTTP cache, so each route/identity downloaded them again.

## Measured fixture

Three routes, each driven with desktop and mobile identities in fresh source contexts, each swept through 390/768/1440 pixels. Shared assets: twelve speculative JS chunks, CSS, JS, and three responsive image width URLs (`/cdn/shop/files/x.jpg?v=123&width=N`). Images declare Vary: Accept; other assets declare Vary: Accept-Encoding, Available-Dictionary; all use long max-age immutable. A separate no-store prefetch is the negative control.

| Origin hits | Before | After |
| --- | ---: | ---: |
| Twelve cacheable prefetch chunks | 72 | 12 |
| CSS + JS + three image renditions | 5 | 5 |
| Total cacheable subresources (17 unique URLs) | 77 | 17 |
| no-store prefetch | 6 | 6 |

The regression fails against the original resource-capture.ts: each speculative chunk is fetched six times rather than once. The width variants are legitimately distinct and remain distinct; they already replay across later routes and identities in this fixture.

## Scope and remaining misses

Only purpose-marked GET prefetches gain replay, in bounded ephemeral storage with the existing freshness and Vary rules. Arbitrary `other`, fetch/XHR, media/ranges, authorized requests, private/no-store/no-cache responses, Vary: Cookie/*, stale entries and over-budget assets remain outside replay. Speculation is not exported; if a prefetched URL is later actually used as a script, it must still be independently captured for export.

Other known gaps are not changed here: replay is installed only on publicUrlsOnly screenshot pages; isolated captureSelectedSrcsets probe contexts do not install that replay handler; deferred image bodies become available for replay only at resource settlement; simultaneous cold contexts can duplicate downloads; and the store retains only one Vary representation per URL. This is a scoped fix for the dominant avoidable class demonstrated by the earlier source evidence and local fixture, not a claim that a current live Shopify capture now fetches every asset exactly once. Refs #1738.
