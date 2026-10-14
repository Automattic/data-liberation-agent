# data-liberation-agent

Liberate any website into a complete, portable HTML site.

## The problem

Closed platforms make it hard to leave. Wix has no HTML export and caps RSS at 20 posts. JavaScript-rendered content and limited APIs leave your site locked inside.

## The solution

Point it at a URL and get your site back as plain files:

```bash
data-liberation https://example.com/
```

Every retained route becomes a directory of HTML, CSS, media, and fonts, with references rewritten so navigation works locally. Sites with shared headers/footers need include-aware serving or compilation as described below; the rendered pages need no DLA or browser assembly runtime.

**HTML is the contract.** The liberated site is the deliverable — not an intermediate format on the way to somewhere else, and not tied to any destination.

## Four commands

```bash
data-liberation <url>                        # liberate a site
data-liberation inspect <url>                # assess a source before liberation
data-liberation compare <run-dir>            # verify the copy against its source
data-liberation publish <run-dir> --to spacefast   # put it on a live URL
```

That is the whole surface. Inspection is bounded and read-only; it reports measured route/document facts, coverage, issues, and explicit unknowns without writing a site. Liberation writes the site and exits; add `--serve` to keep a local server running so you can click through it.

See [rendered inspection and complexity](docs/inspection.md) and [source cleanup, comparison, and destination attribution](docs/source-cleanup.md) for their API contracts, evidence, and limits.

Embedded Node consumers can import the same operations from [`data-liberation/runtime`](docs/runtime-api.md), or use the committed standalone `dist/capture-engine.bundle.mjs`. Both expose inspect, capture, compare, publish, and their extension registries.

Comparison defaults to [immutable capture-session evidence](docs/fidelity-reference.md) at 390/768/1440px. `--candidate <url>` compares the portable capture to another rendered copy; `--stage drift` explicitly revisits the live source. Missing reference evidence stays unproven.

### Inspect

```bash
data-liberation inspect https://example.com/ --discovery-limit 50 --sample-limit 5
```

The JSON result is versioned and destination-neutral. It samples the entry route plus distinct discovered route types, up to the configured limits. It does not claim browser-rendered layout, responsive reflow, or activated interactions: those remain explicit unknowns until full liberation and comparison.

### Liberate

| Flag | |
|---|---|
| `--output <dir>` | Output base. Default `~/data-liberation`, or `DLA_OUTPUT_DIR` |
| `--resume` | Reuse what is already on disk instead of recapturing |
| `--acquisition http` | Acquire and export an explicitly unverified HTTP review candidate; browser capture remains the default |
| `--route-limit <n\|all>` | Route budget, shared by browser and HTTP acquisition: capture at most n routes, homepage included, counting linked pages. The homepage is always kept and the rest is an even, deterministic spread over the discovered inventory. Default: 50 for browser capture, `all` for HTTP. Omitted routes are diagnosed and counted in `routesOmitted`, never as failures. See [route budget](#route-budget) |
| `--route-selection <mode>` | How the route budget picks routes: `discovery-order` (default, the even spread) or `template-coverage` (one route per template group first; writes `template-groups.json`). See [template coverage](#template-coverage-selection) |
| `--runtime-route-limit <n>` | Observe declared runtime regions on at most 0–50 HTTP routes (default 0) |
| `--screenshots` | Also write full-page desktop and mobile PNGs |
| `--serve` | Keep a local server running until interrupted |
| `--no-learn-fluid` | Freeze the layout at one width instead of learning how it reflows |
| `--device-mode <mode>` | `auto` (default) checks the homepage once before capture. When the adapter declares no per-device documents and phones receive the same server HTML (nonces, CSRF tokens and timestamps ignored), each route first gets a cheap phone check (images, media and fonts blocked, a few seconds). A route whose server HTML, element structure or body classes differ at phone width is captured in both profiles; every other route is captured once at desktop and the copied CSS supplies its phone layout. Otherwise every route is captured in both profiles. A phone-width probe of the homepage keeps controls that only appear on phones, such as a hamburger menu. The receipt's `deviceMode` records the decisions, the dual routes and why. `dual` always captures both profiles; `reflow-only` always captures desktop only |
| `--reference-sample <n\|all>` | Freeze baseline reference evidence for the homepage plus n-1 sampled routes; unsampled routes skip reference navigation and compare reports them as uncompared scope. Default: 1 (homepage only). Use `all` for full-route parity |

Fluid learning is on by default. The capture sweeps widths with the source's own runtime alive, fits how each element is sized, and emits that as ordinary CSS — so the copy keeps reflowing after the runtime is stripped, instead of being pinned to the width it was captured at.

### Compare

Verification runs in two tiers, and the report says which found what.

- **Self-consistency**, across every route, offline: anchors resolving to exactly one target, internal links landing on a real file, no asset still pointing at the origin. Milliseconds.
- **Source fidelity**, across a sample, in a browser: text, geometry and reflow at widths the capture never sampled, and dialogs opening as the source opens them. Roughly 25 seconds per route, so it samples rather than walking everything.

Exit code 0 means both passed. `--screenshots` writes source, copy, and diff PNGs; the pixel score is evidence for a human and never decides pass or fail.

### Publish

```bash
data-liberation publish <run-dir> --to spacefast
```

Publishing reads what is on disk, so a repaired copy or a different target can ship without touching the source site again. Without a token the publish is anonymous and returns a one-time claim link — the space stays private until it is claimed, so the live URL answers 403 to everyone until then. `--token`, or `SPACEFAST_TOKEN`, publishes into an account you own.

Naming an unknown target lists the registered ones.

## Supported platforms

| Platform | Status |
|---|---|
| Blogger | Browser capture + feed accounting; opt-in orchestrated HTTP review capture |
| Base44 | Ready (bounded probe for members-only `pushState` login rewrites) |
| EmDash CMS | Ready |
| Ghost | Ready |
| GoDaddy Websites & Marketing | Ready |
| Hostinger Website Builder | Ready |
| HubSpot | Ready |
| Next.js | Generic discovery + framework route-announcer cleanup |
| Shopify | Ready |
| Soloist | Tenant-scoped authored links + Next page metadata discovery |
| Squarespace | Ready |
| Substack | Ready |
| Webflow | Ready |
| Weebly | Ready |
| Wix | Ready |
| Any other website | Best-effort generic fallback |

Adapters contribute platform knowledge to discovery and capture — how a platform lists its routes, what its CDN URLs look like, how its runtime resolves anchors. Sites matching none of them fall back to a generic adapter that renders each page in a headless browser.

Soloist customer URLs (`https://soloist.ai/<handle>/`) are scoped to that handle,
including when starting at a child route. Discovery reads one tenant homepage's
authored links and `__NEXT_DATA__.props.pageProps.data.websiteSettings.pages`.
The tenant root is the homepage; section anchors are not extra routes. Platform
footer links, other tenants, and the global sitemap are excluded. Routes absent
from both homepage links and published page metadata remain undiscovered.

Registered HTTP profiles can acquire route response evidence and shared dependencies through the [HTTP acquisition API](/docs/http-acquisition.md). Portable preparation and rendered acceptance remain separate from acquisition coverage.

### Custom platforms

Consumers can register a platform that auto-detects, discovers routes, and applies source-specific liberation hooks without editing core. See [Platform API](/docs/platform-api.md) for the public contract and example.

## Output

A run produces, under `~/data-liberation/<host>/`:

| Path | |
|---|---|
| `website/` | **The deliverable.** Serve with include support, or compile includes for a plain static host. Same-site server redirect aliases are recorded as Netlify-format `website/_redirects` when any were captured. |
| `capture-receipt.json` | Source URL, the route table mapping each page to the URL it came from, assets |
| `asset-evidence.json` | Bounded v1 source-asset evidence. Each source URL records retained-route references, retrieval separately from portable inclusion, and its canonical `portableAssetId` when bytes were deduplicated; consumers group source records by that ID. It retains the first 10,000 reachable source URLs in captured-route traversal and emits them lexically; `assetCount` is exact unless `assetCountExact` is false, when it is a lower bound and `assetsTruncated` identifies omitted detail. `totalReferenceCount` remains exact, while per-asset `referencesTruncated` identifies omitted locations. The receipt links this sidecar as `assetEvidence.path`. |
| `diagnostics.json` | Everything the source withheld or the capture could not resolve |
| `source-profile.json` | Measured behaviour: one document or per-device, declarative or runtime-written geometry, switch width |

### Shared site chrome

Repeated byte-identical site-level semantic headers and footers are stored once in
`website/parts/header-<sha256>.html` or `website/parts/footer-<sha256>.html`. Pages
reference them at their original positions with literal HTML comments:

```html
<!--#include virtual="/parts/header-<sha256>.html" -->
```

The portable include contract is literal: double quotes, the spaces shown, and
lowercase `#include virtual`. The root-relative path names one `.html` file under
`/parts/`, with an ASCII filename containing letters, digits, `_` or `-`.
Fragments may reference other fragments with the same syntax. Any producer or
consumer can implement this HTML contract; it carries no destination identity.

Sharing requires at least two retained route documents and a net byte reduction
including the stored part and every reference. Route-specific navigation and
mobile variants remain distinct; chrome inside `main`, `article`, or `section`
stays local. IDs, styles, scripts and assets retain their authored bytes. Parts
are resources, not routes. There is one canonical `website/` tree; receipts and
existing evidence still own coverage and size reporting.

DLA's `--serve`, runtime `serveCapture`, preview screenshots, and offline fidelity
resolve these comments before interpreting HTML. Editing one part updates every
referencing route on the next request. Ordinary static file servers and `file://`
do **not** expand HTML comments: use an include-aware host or compile the comments
to fragment bytes before deployment. Compilation must parse real HTML comments,
not script strings, and resolve virtual paths relative to the website root. It
does not require client-side fetching. DLA retains no expanded authoring copies.
See [runtime serving and limits](docs/runtime-api.md#shared-parts-and-serving).

### Route budget

Browser capture renders every route in several profiles, so a store-sized inventory cannot finish inside a typical hosted deadline. One measured source inventoried 3,689 routes and reached about 180 of them in an hour. Capture therefore takes at most `routeLimit` routes (CLI `--route-limit`, MCP `routeLimit`, `captureWebsite({ routeLimit })`):

- **Default:** 50 for browser capture, about 17 minutes at that worst observed throughput. HTTP review acquisition is unbounded by default: it fetches documents without rendering them, so the same inventory finishes in minutes. Pass `all` to capture every route in either mode.
- **Selection:** the entrypoint, then an even spread over the remaining inventory (the same rule as `referenceSample`). The same inventory always yields the same selection. The budget counts the entrypoint.
- **Linked pages:** linked-page discovery keeps its own `maxPages`, but its admissions draw from the same budget, so the total stays bounded. A redirect target continues a route already admitted and does not spend budget.
- **Omitted routes:** each is a `route_omitted_by_budget` entry in `discoveryDiagnostics` and counts in `summary.routesOmitted`. Omitted routes are never attempted, so they are not in `routesDiscovered`, `routesFailed` or `missingRoutes`. Links to them stay unresolved anchors with reason `target route was omitted by the route budget`.

The budget is the caller's chosen scope, so omission does not make a capture incomplete: `complete` means every route inside the budget was captured. A caller that needs the whole source checks `summary.routesOmitted === 0` or passes `routeLimit: 'all'`.

### Template coverage selection

An even spread can spend the whole budget inside one template (a few hundred posts) and never reach the one-off templates: the contact form, a landing page with its own CSS, the shop. `routeSelection: 'template-coverage'` (CLI `--route-selection template-coverage`, MCP `routeSelection`) spends the budget by template instead:

1. After discovery and before any browser starts, capture fetches each discovered route's server HTML. The pass is bounded: at most 1,000 routes (an even spread of a larger inventory), 6 requests at a time on the entry origin, 15 s per request, 8 MiB per document, 256 MiB and 120 s in total (a tenth of `timeBudgetMs` when that is smaller). If the source throttles (429 or 503), the pass waits for `Retry-After`, continues one request at a time, and stops at the next refusal, so it never spends the rate limit the browser capture needs. Routes it does not fingerprint belong to no group.
2. Each document gets a template fingerprint: a hash of the body's skeleton (tag, stable class names and `role`; text and inline elements ignored; classes with digits, CSS-in-JS prefixes, taxonomy or author terms such as `category-news`, and state words such as `active` or `current-menu-item` dropped; repeated siblings collapsed; classless prose blocks and the inside of content containers such as `article` or `.entry-content` treated as content) plus a divergence fingerprint compared exactly: the page's own `<style>` text, its stylesheet and script URLs, executable inline scripts, forms and interactive controls (tabs, disclosures, `details`, dialogs), each by tag and stable classes, and embeds (`iframe`, `video`, `audio`, `canvas`, `object`, `embed`). Routes with the same fingerprint form a group; its representative is its first member in inventory order.
3. When the budget truncates the inventory, the entrypoint comes first, then one representative per group (larger groups first), then the even spread over the remaining routes. When the inventory fits the budget, every route is captured as before.

The pass only chooses routes; captured pages are produced exactly as in `discovery-order`. It writes `template-groups.json` next to `website/` (never inside it, so importers do not see it) and adds a `templateGroups` count summary to `capture-receipt.json`. Grouping never fails a capture: if the pass itself fails, routes are selected in discovery order and the capture records one `template_grouping_unavailable` discovery diagnostic, which is not a loss.

`template-groups.json` (schema `data-liberation-agent/template-groups/v1`) is static and deterministic for the same responses: no timings.

| Field | |
|---|---|
| `sourceUrl` | Entry URL |
| `fingerprint` | `{ version, maxSkeletonDepth }` of the rules above |
| `limits` | The pass bounds that applied |
| `coverage` | `{ routes, fingerprinted, unfingerprinted, groups, singletons }` over the deduplicated inventory |
| `groups[]` | `{ id, key, skeleton, divergence, representative, size, members }`, ordered by first member; `id` is `t1`, `t2`, … |
| `unfingerprinted[]` | `{ url, reason, httpStatus? }`; `reason` is `not_sampled`, `time_budget`, `byte_budget`, `rate_limited`, `http_status`, `not_html`, `redirected`, `too_large` or `fetch_failed` |
| `selection` | `{ mode, limit, selected, groupsRepresented, groupsOmitted }` for the routes the budget kept |

### Capture time budget

A caller with a hard deadline sets `timeBudgetMs` (CLI `--time-budget 14m`, MCP `timeBudgetMs`, `captureWebsite({ timeBudgetMs })`; browser capture only). It is the time from the start of the capture until export must begin, so a deadline yields a partial site instead of nothing. Default: no budget, and capture behaves exactly as before.

- **Admission:** the entrypoint starts first and is always captured. Other routes start until the budget minus a grace window (25% of the budget, at most 60 s); after that no new route or linked-page wave starts.
- **Deadline:** routes still running at the budget are abandoned: the browser closes and they get at most 5 s to unwind. The entrypoint is never abandoned: if it is still running, capture waits for it (its own navigation and stage timeouts bound it). Section media stops downloading at the deadline, and the live-source behavior discovery that normally follows export is skipped once the budget is spent.
- **Result:** export, the homepage preview and the fidelity reference run on what was captured. Each route left out is a `route_capture_skipped_budget` finding (`unit: 'route'`, `severity: 'error'`, `metrics.timeBudgetMs`). It is a missing route, counted in `routesFailed`, so `complete` is `false` and `usable` follows `isUsableCapture`. The findings reach `website/source-findings.json`, in Static Site Importer's neutral schema.

**Recommended value:** the caller's deadline minus the post-capture headroom. Measured on a 10-route capture of `wordpress.org/news` (macOS, Node 24): export 4.0–5.2 s, homepage preview 5.2–5.3 s, reference finalization under 0.1 s. A 90 s budget finished in 99.5 s of wall time, process start and exit included. Export grows with the route count, about 0.5 s per route in that run, so for the default 50-route limit use **`timeBudgetMs = deadline − 60 s`**. That covers the 5 s abandonment drain, export, the preview and a margin. Leave more headroom when the entrypoint itself is slow, because the budget always waits for it.

### Per-file export limit

Export writes no file larger than `maxFileBytes` into `website/` (CLI `--max-file-bytes`, MCP `maxFileBytes`, `captureWebsite({ maxFileBytes })`). The default is 50 MiB (`DEFAULT_MAX_FILE_BYTES`, 52,428,800 bytes). It matches Static Site Importer's per-file intake limit for staged archives, which refuses larger files, so change the two together. Capture itself keeps accepting larger media (videos up to 100 MiB).

- **Assets over the limit** are not written. References to them resolve like any uncaptured asset: an image becomes the transparent placeholder, and other dependencies keep their source URL or are removed. Each asset is an `asset_exceeds_file_limit` finding (`unit: 'asset'`, `metrics: { bytes, limit }`). The page still exports, and the capture's completeness does not change.
- **Page documents over the limit** fail that route through per-route export containment (`route_export_failed`). A page document over the limit at the entrypoint fails the capture.

### Total export budget

Export keeps `website/` within `maxTotalBytes` and `maxFiles` (CLI `--max-total-bytes`, `--max-files`; MCP and `captureWebsite()` take `maxTotalBytes` and `maxFiles`). Every file in `website/` counts, including the homepage preview and `source-findings.json`. The defaults are 250 MiB (`DEFAULT_MAX_TOTAL_BYTES`, 262,144,000 bytes) and 5000 files (`DEFAULT_MAX_FILES`). They match Static Site Importer's staged-archive intake limits, `max_total_uncompressed_bytes` and `max_entries` (`static_site_importer_staged_archive_limits()`), and the importer refuses a larger archive whole. Change the two together. Any runner that archives `website/` for import must accept at least these bounds.

When the site would exceed the budget, export drops units in this order and builds the site again without them:

1. **Assets the entrypoint does not need**, largest first, fonts last. At equal size a video goes before audio, and audio before an image. Media and captured page resources are droppable. Each one becomes an `asset_exceeds_total_budget` finding (`unit: 'asset'`, `metrics: { bytes, limit, fileLimit }`). References to it resolve like any uncaptured asset, and the capture's completeness does not change.
2. **Non-entry routes**, last in route order first, when dropping assets is not enough. Each one becomes a `route_exceeds_total_budget` finding (`unit: 'route'`, `severity: 'error'`). It is a missing route, counted in `routesFailed`, so `complete` is `false` and `usable` follows `isUsableCapture`.

The entrypoint document and every file it references are never dropped. If they alone exceed the budget, export writes them anyway and the receipt says so. Export reserves up to 8 MiB and 16 files, never more than a quarter of the budget, for the files capture writes into `website/` after export. The receipt's `exportBudget` records the budget, the size of the export, the drop counts and, once capture has written every file, the `final` size.

### Usable partial captures

A capture is `complete: true` only when every route inside the [route budget](#route-budget) was captured with a document for each declared capture profile and no link points at a missing route. Links to budget-omitted routes are not missing. A partial site is still written and returned with `complete: false` (`strict: true` rejects instead). One failed route should not sink an import, so the result carries what a caller needs to decide:

| Field | |
|---|---|
| `entrypointCaptured` | The entrypoint route is in the capture (also in `summary`). Always `true` on a resolved result: when the entrypoint is not rendered, capture rejects with the recorded cause, whatever happened to other routes. |
| `missingRoutes` | `{ url, code: 'route_capture_failed' \| 'route_capture_skipped_budget' \| 'route_export_failed' \| 'route_path_collision', reason }` for each route with no usable page (deadline, engine error, the [capture time budget](#capture-time-budget), uncaptured redirect target, a non-integrity error while exporting that route, or a website path another route already claimed; the entrypoint always keeps its path). A route whose HTML was saved counts as captured even when a stage failed on it. A declared capture profile that produced no document stays a `route_profile_uncaptured` finding (`unit: 'profile'`, named in `profile`) and makes the capture incomplete; other stage failures are a `route_capture_degraded` finding, an unparseable author stylesheet left unprojected is `stylesheet_unparseable`, and a native timeline or disclosure probe that failed on a page that was still saved is `native_timeline_unproven` or `disclosure_unrestored` (`unit: 'block'`), all in `discoveryDiagnostics`. Routes the source itself lacks (`route_not_found`), redirects off-site (`route_external_redirect`) or lists off the entry origin (`route_off_origin`) are not listed; they remain in the receipt's `discoveryDiagnostics`. |
| `summary.routesOmitted` | Discovered routes the [route budget](#route-budget) left out, one `route_omitted_by_budget` diagnostic each. Never counted as failed or missing. |
| `unresolvedAnchors` | Links to missing routes stay unresolved anchors. Links to budget-omitted routes carry reason `target route was omitted by the route budget`. |

Recommended default policy (`USABLE_PARTIAL_CAPTURE_POLICY`, version 2; `isUsableCapture(result)`; surfaced as `usable` by `liberate` and the MCP tool): a capture is usable when the entrypoint was captured and it is either complete or its failed routes are at most `max(1, 10%)` of the routes attempted. Routes the caller's budgets left out count in neither: route-budget omissions are not in `summary.routesDiscovered`, and time-budget skips (`route_capture_skipped_budget`) stay in `missingRoutes` but are excluded from both counts, so a deadline bounds scope instead of failing the capture. A capture whose entrypoint failed is never usable. Import a usable partial capture and report `missingRoutes` instead of failing. Capture itself never applies the policy.

## Using it from an agent

The `liberate` skill drives the CLI. It is the only skill: a URL becomes a verified, portable site, and optionally a live URL.

### Claude Code

```bash
claude plugin marketplace add Automattic/data-liberation-agent
claude plugin install data-liberation@data-liberation
```

Then `/liberate https://your-site.com`.

### Codex

```bash
cd data-liberation-agent && codex
```

`.codex-plugin/plugin.json` and `.mcp.codex.json` register the server and skill automatically, since Codex does not expand `${CLAUDE_PLUGIN_ROOT}`. Then `$liberate https://your-site.com`.

### Gemini CLI

```bash
cd data-liberation-agent && gemini extension link .
```

### Any MCP client

```bash
npm run mcp     # or: npx tsx src/mcp-server.ts
```

The server exposes the same four verbs as tools — `inspect`, `liberate`, `compare`, `publish` — calling the same entry points the CLI calls. MCP is a transport here, not the architecture: nothing requires it, and it deliberately does not expose internal pipeline phases.

> **First-time browser setup.** Capture uses Playwright's Chromium, which is not installed automatically:
>
> ```bash
> npm run setup:browser
> ```

## Additional documentation

- [Platform API — custom platforms](/docs/platform-api.md)
- [Wix authenticated content endpoints](/docs/wix-content-endpoints.md) — the load-bearing content endpoints behind Wix's editor and dashboard auth
- [Loss ledger contract](/docs/contracts/loss-ledger.md) — how capture, compile and import report degraded units, and the one caller-side acceptance policy
- [Capture evidence names](/docs/contracts/capture-evidence.md) — the producer-neutral attribute, class and schema names capture writes, owned by Blocks Engine

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [Spacefast](https://spacefast.com/) — agent-first static hosting, the default publish target
