# Source inspection

`data-liberation inspect <url>` returns schema `2.0`: bounded HTTP facts and rendered desktop observations. `--http-only` skips Chromium and returns unknown complexity. The public `inspectSource(url, { rendered: false })` option and MCP `inspect.rendered` use the same contract.

Default limits are 50 inventoried routes, 5 samples, 10 seconds per request/rendered sample, and 30 seconds overall. Each rendered sample permits at most 100 GET requests, 2 MiB per response, and a 10 MiB accepted resource budget. Responses and redirects use the HTTP inspection guard. Service workers and non-GET requests are blocked; controls and transactions are never activated. Blocked or unavailable resources are reported as unknown evidence. A 300ms settle observes an initial state, not all possible future application states.

`source.hosts` records the deployment hosts recognized on the entry response, with the evidence that identified each one. A host is where a site is deployed, not what built it, so host recognition is independent of platform detection and never competes with it: a site can be built on one platform and served by another, and either may be unknown.

A host injects instrumentation into pages it serves — badges, HUDs, beacons — which is evidence about the deployment and not about the source. A recognized host declares the specific elements it injects; those elements and their subtrees are subtracted from element counts, capability findings and navigation, and reported in `rendered.samples[].excluded` with the host, selector, evidence and the number of elements removed. Recognition is narrow by construction: matching a host says nothing about the rest of the page, an unrecognized host excludes nothing, and a registered rule stays inert unless that host actually served the response. Netlify's "Powered by Netlify" badge frame ships as a built-in; consumers register their own hosts through `registerHost`.

`rendered.samples` records element and text counts, forms, links, images, media/canvas, frames, disclosures, navigation and capability evidence. Runtime-created navigation can contribute additional samples within the route/sample bounds. Source adapters contribute `inspection: CapabilityRule[]` selectors through the platform registry. Wix contributes booking, store and member surfaces; Shopify contributes purchasing surfaces. Generic observations cover forms, embeds, authentication and checkout affordances on any platform. Capability detection is evidence of a surface, not proof of its working backend.

## Complexity contract

`complexity` is a transparent heuristic about the sampled source, not a destination compatibility prediction:

- **complex:** booking, commerce or membership evidence, or more than 2,000 DOM elements on a sampled route.
- **moderate:** other non-navigation capability evidence, or more than 500 elements.
- **simple:** none of those observed factors.
- **unknown:** missing rendered samples, truncated discovery/sampling, or limited/blocked resources. `observedBand` retains the measured lower-bound classification and `factors` explains it.

`confidence: bounded-sample` means the declared sample completed. Responsive behavior, unsampled routes, delayed states and backend functionality remain explicitly unknown. Consumers apply their own acceptance policy. These thresholds are initial explainable heuristics, not calibrated success probabilities.

## Verification — issue #210

Tracking: https://github.com/Automattic/data-liberation-agent/issues/210

```sh
npm ci
npx vitest run src/lib/inspect.test.ts src/lib/inspect-rendered.test.ts src/mcp-server.inspect.test.ts
npx tsc --noEmit
npm test
npm run build
npm run test:package
node dist/cli.js inspect https://example.com --sample-limit 1 --overall-timeout 15000
```

Verified September 15, 2026: 11 focused tests; 95 test files / 994 full-suite tests; typecheck, build and installed-package verification passed. The public source returned one rendered sample, 12 elements, 129 text characters, one link, no app findings, and `simple` / `bounded-sample`. Sitemap returned 404 and was reported. The controlled browser tests verify JS-created booking content, runtime navigation, blocked POSTs, and timed-out browser samples; CLI and MCP tests exercise the actual transports.

AI assistance: OpenAI gpt-6-astra via OpenCode implemented and verified this change directly under Chris Huber's direction after Homeboy failed before provider execution.
