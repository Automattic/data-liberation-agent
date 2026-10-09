# AGENTS.md — Instructions for AI Agents

## Overview

`data-liberation-agent` copies a website into a complete, portable HTML site. HTML is the contract: the liberated directory is the deliverable. Shared-part comments require include-aware serving or compilation; expanded pages run without this tool, a browser assembly runtime, or any destination platform.

The product is four verbs, and everything else exists to serve them:

```
data-liberation <url>                 liberate
data-liberation inspect <url>         inspect
data-liberation compare <run-dir>     verify
data-liberation publish <run-dir>     publish
```

Three entry points share the same code: the CLI (`src/cli.ts`), the MCP server (`src/mcp-server.ts`), and the `liberate` skill, which drives the CLI. MCP exposes the same four verbs and calls the same functions — it is a transport, not the architecture. Adding pipeline phases to it recreates a surface that has to be maintained against every refactor and invites callers to reimplement the CLI. `inspect` is a bounded, read-only, destination-neutral assessment; it must report sampling coverage and unknowns rather than predict destination compatibility.

The platform registry (`src/platform/`) owns built-in and consumer platform registration plus automatic detection. Add a built-in with one `registerPlatform(...)` call in `src/platform/builtins.ts`; consumers use the public `registerPlatform` API documented in `docs/platform-api.md`.

## Pipeline

```
url → detect platform → discover routes → capture each route in a browser
    → learn how the source reflows → export → localize → self-contain → website/
```

- `src/lib/capture.ts` — orchestrates a run.
- `src/lib/screenshot/` — the browser work: rendering, settling, DOM capture, CSS aggregation, interaction capture, fluid learning.
- `src/lib/capture-export.ts` — turns captured routes into the portable `website/` tree: route paths, link rewriting, media localization, diagnostics. It consumes one responsive assembly result rather than classifying and assembling separately, and localizes one portable media plan rather than re-selecting families while copying. Publication of that tree and the export-owned root sidecars is one same-filesystem transaction (`src/lib/export-publication.ts`). Pre-commit failures restore the previous public generation; post-commit cleanup failures keep the new generation. A stale recoverer is not stolen, and a malformed journal fails closed. See `docs/export-publication.md`.
- `src/lib/portable-media-plan.ts` — the portable media plan. One pass over retained pages records which known reference strings meet the raw replacement-boundary check, then releases each page. Each family gets one eligibility, homepage-priority, byte-budget, and content-hash decision, in the original family order. The plan owns the existing rendition limits.
- `src/lib/portable-media.ts` — admitted-media materialization. It consumes the plan and retained family references, copies/deduplicates files in family order, allocates names and projects exclusion/failed-media fallbacks. Its stage-owned indexes seed resource materialization; the returned media summary and diagnostics feed evidence projection.
- `src/lib/portable-resources.ts` — captured-resource materialization. It owns recursive dependency copying, cycles, collision/deduplication state and captured-response media fallback. Media indexes are read-only seeds; the stage returns assets, local paths, replacements and diagnostics for page/evidence projection. Embedded HTML uses the caller's page-sanitization policy. Shared asset/path primitives live in `portable-assets.ts`; dependency and replacement semantics live in `portable-references.ts`.
- `src/lib/shared-stylesheets.ts` — shared inline stylesheet materialization. It records source hoisting restrictions before sanitization, groups eligible styles across distinct staged route documents, localizes and deduplicates emitted CSS, and rewrites the private staged pages in place. It returns emitted assets, served paths and bounded diagnostics; the existing `portableInlineStyle` export remains available from `capture-export.ts`.
- `src/lib/capture-export-evidence.ts` — evidence ownership. It indexes bounded source asset references before localization, builds semantic shards, then projects geometry, source profiles, state summaries, cleanup coverage, diagnostics and the receipt into the private generation after rendering. Report/receipt decisions share one owner; the existing schema constants are re-exported from `capture-export.ts`.
- `src/lib/responsive-assembly.ts` — one responsive assembly. The source pair is the raw captures: it decides the binding phone-only body-class gate and which documents are assembled. A raw collapse is rendered from that same analysis. A raw structural dual is assembled from the already-normalized portable pair, and that emitted analysis — not a second look at the source pair — is what the receipt records. Portable rendering stays ordered around the choice: dual inputs are already normalized; a raw collapse is normalized after assembly. A missing body ships the desktop document alone and records that, even when the source pair had a binding gate.
- `src/lib/self-contain.ts` — strips anything that would still reach the network.
- `src/lib/shared-chrome.ts` — the final export step, after evidence projection and before atomic publication. Exact site-level semantic landmark ranges become `website/parts/<role>-<sha256>.html` only when two or more route documents share them and total bytes decrease (including the part). Neutral root wrappers are allowed; content-local chrome and real variants stay distinct. Apply all replacements against one original byte sequence, without DOM serialization. Never overwrite an existing resource. Parts are resources, never receipt routes; no parallel authoring tree or manifest owns them.
- `src/lib/site-includes.ts` — shared HTML-comment parser and bounded root-contained resolver used by preview serving and offline fidelity. Grammar is exactly `<!--#include virtual="/parts/<safe-name>.html" -->`; include-looking raw text/scripts are not directives. Missing, malformed, cyclic, escaping, symlinked and over-limit includes fail visibly. Evidence and geometry hashes describe resolved bytes, not compact comments. A plain static server must compile includes or support them itself; browsers do not assemble parts.
- `src/lib/fidelity/` — the gate. See below.
- `src/lib/publish/` — the destination boundary.

## Adapters

An adapter contributes platform knowledge to discovery and capture. It never owns a destination.

`liberation?: LiberationHooks` removes platform-specific chrome before portable HTML, screenshots, and mobile variants are produced. Use it for source-specific capture behavior.

```ts
interface PlatformAdapter {
  id: string;
  detect(url: string): boolean;
  discover(url: string, opts): Promise<unknown>;
  probe?(url, urls, opts): Promise<unknown[]>;
  capture?: AdapterCapture;
}
```

`AdapterCapture` (`src/adapters/page-actions.ts`) is the seam for behaviour that only a platform can know:

- `removeSelectors` — chrome removed from the live page before anything is captured, so one removal cleans every artifact.
- `prepare(page, ctx)` — imperative escape hatch, run after removals. Wix uses it to resolve same-page anchors, which its click runtime handles rather than authored targets: the page is observed settling, and a real target is left behind so the copy can scroll there once the runtime is gone.
- `responsiveImages(page, ctx)` — the per-viewport image variants a platform's runtime swapped in, as `{media id → url}`. The browser step stays generic and reads what the runtime settled on; recognising which URLs are that platform's CDN is adapter knowledge, and lives where it can be unit-tested.

All three are best-effort: a throw is swallowed and capture continues.

**Keep destination knowledge out of the adapter interface.** The barrel exports whole adapter objects, so anything declared on `PlatformAdapter` is statically wired to every platform. That is how WXR extraction, WooCommerce CSV, and WordPress block policy previously ended up on the liberation critical path.

To add a platform: create `src/adapters/<platform>/` with an `index.ts` that assembles `detect` + `discover` from focused siblings, register it in `src/adapters/index.ts`, and add it to the README table.

## The fidelity gate

`compare` is what makes the one-for-one claim defensible, and it runs in two tiers because they answer different questions at wildly different cost.

- **Self-consistency** (`src/lib/fidelity/self-consistency.ts`) — every route, offline, milliseconds. Anchors resolving to exactly one target, internal links landing on a real file, no asset still pointing at the origin. Links resolve through the same resolver the preview server uses, so a dangling link it reports is one a reader would hit.
- **Frozen fidelity** (`src/lib/fidelity/check.ts`) — all receipt routes by default, in a browser, against capture-session source evidence at 390/768/1440 in baseline state. Missing/stale/ambiguous evidence stays unproven. A candidate selects portable capture → candidate materialization; only explicit `--stage drift` revisits the live source with route sampling, unsampled widths and interaction checks. See `docs/fidelity-reference.md`.

Both must pass for exit 0 within the declared scope. Baseline excludes dialogs, zoom and motion; downstream acceptance must request required states or leave them pending. When adding a check, put it in the cheap tier if it can be answered from disk.

## Test cost

Ship a fix with the cheapest test that fails when the fix is reverted, usually a unit test of the pure function. Add a real-Chromium end-to-end test when the behavior exists only end to end. Reuse an existing pipeline run in the same file with `beforeAll` where possible, run one browser pass per behavior rather than per parameter value, and state the expected wall time in the PR. This keeps coverage focused: 81 browser-test files accounted for more than 99% of test time, and PR CI grew from about 2 minutes in mid-September to about 19 minutes on Oct 8.

Three things the gate has been wrong about before, all worth remembering:

- The source is not what a visitor's first load shows. Capture dismisses takeover modals and consent banners before it serializes, so the copy never has one; comparing that copy to a live source with its banner still up measures two different documents, and every route fails by exactly the banner's length. Both sides now run the same `dismissOverlays` primitive, and `compare/overlay-evidence.json` records what came off each side.
- Resolving is not the same as resolving correctly. `getElementById` returns the first match, so a fragment duplicated across the desktop and mobile documents reported success while sending the reader to the hidden one.
- A route is not a URL path. A site captured at a subpath serves its entrypoint as the copy's `/`, so resolving routes against the source origin asks the live site for a page that was never captured — and a 404 page then becomes the thing the copy is compared to.

## Fluid capture

A copy is only faithful at the width it was captured at, because platform runtimes write inline pixel geometry that survives serialization while the runtime that computed it does not. Rather than freezing one width, capture sweeps widths with the source's runtime alive, fits a model per element (constant, proportional, floored, or a genuine breakpoint), and emits the result as ordinary CSS that needs no runtime.

Some runtimes regenerate their own `<style>` element instead of writing inline pixels. A top-level rule whose pixel offset changes across the sweep is runtime-owned by that observation; its learned media rules ship in a `data-dla-fluid-sheet-rules` sibling of the owning sheet, so device-document scoping and cascade order follow the source sheet. Each rule must reproduce the capture-width geometry before it is kept.

Elements that fit badly fall back to frozen values rather than adopting a confident wrong formula. `source-profile.json` records what was measured: one document or per-device, declarative or runtime-written geometry, the detected switch width, and how many elements were learned versus frozen.

## Resume state

- `extraction-log.jsonl` (`ExtractionLog`) — append-only per-URL dedupe. Source of truth for "did we process this URL".
- `session.json` (`ImportSession`) — stage, original opts, counters. Single-writer, atomic rename; corrupt files become `session.json.corrupt.<ts>` rather than being silently deleted.
- `media-stubs.json` (`MediaStubStore`) — per-asset status with a retry cap, so permanently-broken URLs stop retrying across resume runs.
- `sections/<slug>.json` (`SectionSpecsStore`) — per-URL capture-once cache, written atomically, self-describing via `SECTION_SPECS_SCHEMA`. Bump the schema whenever `SectionSpec` changes so stale caches invalidate instead of silently degrading fidelity.

Reuse is opt-in: a plain re-run recaptures, and `--resume` is what reports `reused`.

## Build and distribution

- `src/index.ts` is the generic public product API. Package imports (`data-liberation` and `data-liberation/runtime`) resolve to the same committed `dist/capture-engine.bundle.mjs`, sharing one set of extension registries. `src/capture-engine.ts` re-exports that API; its filename is historical. Keep runtime browser imports lazy so HTTP-only inspection and registration remain available without Playwright. `npm run test:package` exercises actual browserless and browser-backed workflows from relocated bundles, plus installed types and registry identity. See `docs/runtime-api.md`.

- `.mcp.json` starts the server through `scripts/mcp-launcher.mjs`: dev checkouts run `src/` via tsx, plugin installs run the committed bundle `dist/mcp-server.bundle.mjs`. The launcher only falls back to the bundle when dependencies do not resolve, so a dev environment never runs a stale dist.
- Committed bundles support dependency-free plugin installs. The serialized `Release` workflow owns `dist/` on **main**: build, package integration, and tests pass before bundles are committed, checked for reproducibility, and handed to Homeboy for release. A concurrent merge rejects the normal push; the queued run rebuilds the latest main. GitHub-token commits do not trigger another push workflow.
- Feature PRs contain source and tests, with `dist/` unchanged from their merge-base. Run `npm run build` and `npm run test:package` locally, then restore generated output before committing (`git restore --source=HEAD --staged --worktree -- dist`). CI rejects PR-authored `dist/` changes and tests freshly built bundles rather than stale committed bytes. For an older PR that already committed bundles, restore `dist/` from `git merge-base HEAD origin/main` and commit that restoration. Merge main normally afterwards. Bundles are never hand-merged. Main can briefly carry the previous bundles until the distribution job completes; dependency-free consumers should pin a successful release, and source checkouts should build locally.
- `playwright` and `single-file-cli` stay external to the bundle behind guarded dynamic imports that degrade with install guidance.
- Playwright's Chromium is not installed on `npm install`. Run `npm run setup:browser` once.

## Non-obvious details

- **The MCP server is one long-lived process — editing `src/` does not hot-reload it.** ESM modules are cached per process, so a re-called tool keeps running the code loaded at server start. Restart it after editing. Vitest always uses on-disk source.
- Liberation writes the site and exits. `--serve` opts into a server that holds the process until interrupted. Anything automated should not pass it.
- Guidance goes to stderr; stdout stays the machine-readable result.
- `validateOutputDir` rejects paths containing `..` or outside `process.cwd()`. Tests use a cwd-local `.tmp-test/` directory rather than `os.tmpdir()`.
- Same-origin enforcement: every captured URL must share an origin with the `url` argument, or throw `SameOriginViolation`.
- Media filename collisions use numeric suffixes (`-2`, `-3`), not hashes.
- `detect-platform` uses domain-level URL patterns and HTTP fingerprinting — no path-based detection. Sites detecting as `unknown` resolve to the `default` adapter via `resolveAdapter`, so "No adapter available" is unreachable.
- Scrolled-state screenshots are skipped silently when a page is too short to have a distinct scrolled state.
- Screenshot capture restarts the browser every 100 URLs at batch boundaries to bound memory.
- Cross-origin stylesheets are skipped when aggregating design tokens — their `.cssRules` throw.

## Verifying a change

Run the gate against a real site, not only the unit tests:

```bash
data-liberation https://example.com/ --output /tmp/check
data-liberation compare /tmp/check/example.com
```

Claims about behaviour should come from a command that was actually run. Documented behaviour in this repository has been wrong before — reuse was described as automatic when it needs `--resume`, and an anonymous publish was described as returning a live URL when the space is private until claimed.
