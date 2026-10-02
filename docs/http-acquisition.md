# HTTP source acquisition

HTTP acquisition is a source-evidence layer underneath capture. It fetches
the actual route documents, retains raw bytes and prepared documents with
SHA-256 identities, and optionally stages deduplicated dependencies using
the existing resource store. It does not produce a portable `website/` or
certify rendering. The four CLI/MCP operations remain unchanged.

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
asset localization and explicit sampled fidelity coverage before the
HTTP path replaces per-route rendering. Complete under-hour capture and
WordPress acceptance remain separate gates under issue 467.
