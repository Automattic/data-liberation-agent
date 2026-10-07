# HTTP source acquisition

## Orchestrated review capture

The existing capture entry point and CLI/MCP liberation verb accept explicit
HTTP acquisition. Browser capture remains the default.

```sh
data-liberation https://example.blogspot.com/ --acquisition http \
  --route-limit 25 --runtime-route-limit 3 --output ./review-captures
```

```js
await captureWebsite({
  url, outputDir: './review-capture', acquisition: 'http',
  http: { routeLimit: 25, runtimeRouteLimit: 3 },
});
```

The orchestrator owns detection, discovery, actual HTTP responses, shared
asset acquisition, optional runtime observation/staging, and website export.
The route limit bounds requested routes; discovered routes outside it remain
named diagnostics. Runtime observation defaults to zero routes and can be
bounded to 0–50 eligible routes, distributed across the requested inventory.
Each selected variant replays its hash-verified acquired source response,
then uses platform-owned readiness and the shared region observer. Source
browser acquisition and full fluid sweeps are not run in this mode.

Profiles with multiple variants declare `exportVariants` explicitly; a single
variant can be exported directly. `prepareRuntimeRegions` supplies optional
platform-specific readiness without host checks in the generic orchestrator.
Runtime failures remain diagnostics and do not promote rendering coverage.
The same settings are `acquisition`, `routeLimit`, and `runtimeRouteLimit` on
the existing MCP `liberate` tool.

HTTP output is always a review candidate with `complete: false`; `strict:
true` rejects it through the existing `IncompleteCaptureError` contract.
Results count discovered/requested/exported routes separately and carry
`data-liberation/http-capture` provenance. Resume and source-screenshot capture
are explicitly unsupported. No frozen fidelity reference is invented.

HTTP acquisition is a source-evidence layer underneath capture. It fetches
the actual route documents, retains raw bytes and prepared documents with
SHA-256 identities, and optionally stages deduplicated dependencies using
the existing resource store. Acquisition itself does not produce a portable
`website/` or certify rendering. Explicit materialization can produce a
localized review candidate. The four CLI/MCP operations remain unchanged.

## Public API

```js
import { acquireHttpDocuments, detectPlatform, resolvePlatform } from 'data-liberation';

const url = 'https://example.blogspot.com/';
const platform = resolvePlatform((await detectPlatform(url)).platform);
if (!platform.acquisition) throw new Error('Platform has no HTTP acquisition profile');

const result = await acquireHttpDocuments({
  url,
  urls: [url, 'https://example.blogspot.com/2026/08/article.html'],
  outputDir: './source-evidence',
  profile: platform.acquisition,
  collectAssets: true,
});

console.log(result.coverage, result.resources, result.verification);
```

Callers own the requested route inventory. A platform's `discover` supplies
its inventory through the existing registry; acquisition does not invent
routes or a shared page shell. Browser capture remains the default
`captureWebsite` implementation.

## Platform contract

`Platform.acquisition` declares an `HttpAcquisitionProfile`:

- `id`: profile identity recorded with the evidence.
- `variants`: unique identifiers and optional origin-scoped request headers.
- `prepare(html, context)`: returns a prepared source document and optional
  metadata/browser-region requirements, or `undefined` when the document
  is outside the profile and needs browser acquisition.

The generic layer owns bounded concurrency, SSRF-safe fetches, byte limits,
HTML content-type/encoding checks, response identity, bounded transient
retries and dependency deduplication. Headers do not transfer off origin.
Every requested variant gets an acquired, browser-required or failed row.
Failed or unsupported variants are not silently dropped.

Raw and prepared content types are recorded separately; prepared strings
are written as UTF-8. Consumers serving them should honor
`documentContentType` rather than reuse the original response encoding.

## Artifacts

- `source-documents/*.response.html`: unchanged successful HTTP response
  bytes, including source runtime where present.
- `source-documents/*.html`: profile-prepared HTML with canonical CSS URL
  spelling. Author CSS and route-specific structure are retained.
- `resources/manifest.json`: optional staged source dependencies and their
  failures. These are not yet localized into a website.
- `http-acquisition.json`: `data-liberation/http-acquisition/v1` receipt,
  exact coverage, final URLs, hashes, attempts and elapsed times.

`verification` explicitly reports rendering/interactions unverified and
assets not localized. Acquired response coverage is not rendered coverage.
`browserRegions` identifies platform-owned surfaces needing observation;
it does not contain fabricated geometry or readiness reports and is not
an exhaustive rendered-interactivity audit.

## Blogger profile

Blogger detection and feed/route knowledge live in its registered adapter.
The HTTP profile recognizes generator/widget/editorial markup, retains
author styles and inert JSON-LD, removes executable script elements and
prepares native details consistently. Missing editorial content and canvas
documents remain browser-required.

Discovery retains sitemap/homepage routes and actual archive/label links.
The feed supplies accounting evidence; without a sitemap it supplies a
bounded paginated fallback. A requested 500-entry page can contain only
150 entries, so pagination advances by the observed count. Partial or
unavailable feed coverage is reported explicitly.

## Shopify profile

The registered Shopify profile recognizes measured Brooklyn server-rendered
homepage, collection, product and informational documents. Shopify identity,
expected route sections, a headed main document and matching canonical URL are
required. Declared Shopify CDN width templates can supply an authored fallback
rendition. Unknown themes, missing sections and unsupported documents stay
browser-required. Executable scripts are removed; inert JSON and source CSS remain.

With runtime observation requested, Shopify's bounded readiness settles lazy
images, initial gallery/slideshow state and route-owned review/recommendation
content. Declared subtrees and HTML/body attributes enter the existing staging
and export path. Header and selected sort presentation survive; commerce and
form backends remain separate. Rendering and interactions are still unverified.

The four-route proof and its precise feasibility blockers are documented in
`artifacts/shopify-http/README.md`. `scripts/validate-shopify-http-evidence.mjs`
checks the retained observations and honest incomplete coverage.

## Observed subtree and attribute projection

`RuntimeRegionRequirement.projection` explicitly selects `subtree` or
`attributes`. Omitted requirements retain child-document-only staging. The
observer serializes current native form selection and observes head stylesheet
dependencies, source base URL, UA and DPR. Staging verifies prepared-document,
observed-node and stylesheet identities, preserving root tag/ID and route/variant
mapping. Subtrees must be addressable in the acquired document; no whole-document
or whole-main replacement is implied.

Captured linked CSS is placed into the existing responsive reconciliation before
viewport-only class aliases are emitted. Its URL dependencies retain the original
stylesheet base. Uncaptured/imported CSS and incomplete observations remain
diagnostics. Each acquired variant selects one observed viewport; the existing
responsive assembler handles those documents, not a new three-point responsive
model. Unsampled widths, partial child regions and functional behavior remain
unproven. Source/staged byte hashes and containment checks run before publication;
modified attributes are rejected transactionally. HTTP `complete` remains false.

## Evidence and next integration boundary

On the Reflecting the Image 25-route corpus, the implemented API acquired
all 50 desktop/mobile documents and staged 162 unique resources in 17.4s.
One provider authorization stylesheet returned an empty non-CSS response
and remains a dependency failure. A first raw-resource experiment exposed
135 bogus 404 paths from CSS-escaped scheme punctuation; shared URL decoding
and canonical preparation resolved that upstream interpretation mismatch.

Acquired article content matched browser evidence for all 21 sampled
posts in both variants. Representative prepared baseline text/image/font
checks passed with source-hosted assets. Full-page geometry revealed why
this layer is not yet a browserless portable capture: Blogger's blank
comment editor is a 410px placeholder until runtime assigns its URL and
resizes it to 104px at phone width or 86px at tablet/desktop width. Followers
are also runtime-mounted surfaces. Their requirements are recorded as
browser regions rather than promoted to static rendering claims.

The next integration is bounded browser-region observation/materialization,
and explicit sampled fidelity coverage before the
HTTP path replaces per-route rendering. Complete under-hour capture and
WordPress acceptance remain separate gates under issue 467.

## Localized review candidate

```js
import { materializeHttpDocuments } from 'data-liberation';

const receiptPath = materializeHttpDocuments({
  outputDir: './source-evidence',
  sourceUrl: url,
  platform: platform.id,
  desktopVariant: 'desktop',
  mobileVariant: 'mobile',
});
```

Materialization reads `http-acquisition.json` directly and verifies prepared
document hashes, source origin and variant identities before replacing the
review candidate. It reuses capture export for route allocation, shared
dependency localization and responsive document handling. Acquire with
`collectAssets: true` first to stage dependencies. Missing/failed variants,
unresolved dependencies and unobserved browser regions remain diagnostics.

`capture-receipt.json` links the original acquisition receipt by SHA-256,
marks rendering/geometry/interactions unverified, and keeps `summary.complete`
false. Geometry remains unverified in the source profile. No screenshot
manifest, cleanup audit, or frozen browser evidence is synthesized. Keep
browser evidence in a separate output directory; mixed frozen/geometry
artifacts are rejected. Browser-region reconstruction and fidelity validation
remain prerequisites for accepted capture.

## Bounded runtime-region evidence

`observeRuntimeRegions(page, sourceUrl, document.browserRegions)` observes
declared regions on a caller-owned browser page after the caller establishes
readiness. It records real DOM and SHA-256 identities, bounding boxes,
visibility, and child iframe document HTML (including cross-origin children
accessible through Playwright). It does not navigate, click, scroll or mutate
the page, and rejects source-route drift before and after observation.

Bounds: 32 selectors, 16 matches per selector, 16 child documents, 256 KiB per
HTML snapshot, 2 MiB total HTML, and a 10-second observation budget with
timeout-contained locator reads. Missing regions, invalid selectors, blank
child documents, exhausted budgets and partial snapshots are explicit.
`observed` means a DOM snapshot was obtained, not that readiness, responsive
behavior, interaction or rendering was proven. Raw runtime HTML is evidence;
it can contain executable scripts and session URLs and must be reconstructed
and localized before inclusion in an accepted website.

The returned `data-liberation/runtime-regions/v1` report retains
`projection: not_materialized` and rendering/interactions unverified. Region
evidence is scoped to its actual route and viewport, not generalized to all
routes or widths. Child forms and sign-in controls need functional handling;
retaining an external iframe URL does not satisfy self-contained acceptance.

## Observed embedded-document attachments

```js
import { stageRuntimeRegions, materializeHttpDocuments } from 'data-liberation';

await stageRuntimeRegions({
  outputDir: './source-evidence',
  attachments: [{ variant: 'desktop', observation: desktopRegionReport }],
});
materializeHttpDocuments({
  outputDir: './source-evidence', sourceUrl: url, platform: platform.id,
  desktopVariant: 'desktop', mobileVariant: 'mobile', embeddedDocuments: true,
});
```

Select one actual observed viewport per acquired variant. Staging matches
declared regions, verifies node/child hashes and observed child geometry, and
writes `embedded-documents.json`, original child snapshots in
`embedded-source/*.html`, and inert `embedded-documents/*.html`.
Executable scripts and nested child frames are removed. Child document base
URLs are resolved before shared dependency staging. Staging is bounded to
100 attachments and 16 MiB of region/child HTML; partial observations are
retained as unresolved acquisition diagnostics rather than projected.

Explicit materialization verifies child bytes, file containment and parent
prepared-document identities before replacing the candidate. It inserts
observed regions, retains authored iframe width/border geometry, recursively
localizes child HTML dependencies through the existing resource exporter,
and serves sandboxed local child documents. It records the attachment receipt
hash; HTTP rendering/geometry/interactions and embedded interactions remain
unverified, and `complete` remains false.

This is a localized static projection. Removing provider scripts leaves
controls such as sign-in, Follow and Next functionally unverified. When
desktop/mobile child HTML or height differs inside equivalent parents, the
exporter preserves both children in width-scoped document islands. It uses
the existing export switch-width policy; a default switch is not a learned
source breakpoint. Behavior between observed widths remains unverified.
No region is generalized to routes without its own attachment.
