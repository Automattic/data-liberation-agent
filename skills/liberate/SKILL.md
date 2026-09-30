---
name: liberate
description: Inspect or liberate a website into a complete, portable HTML site by driving the data-liberation CLI. A URL becomes a directory of HTML, CSS, assets, routes and navigation that runs on its own — that directory is the deliverable and HTML is the contract. Covers source inspection, liberation, verification, and publication.
---

# Liberate a website

**What you produce:** a directory that runs on its own — every retained route, its CSS, media, fonts, navigation, same-page anchors, and responsive behavior, with references rewritten to point inside the copy.

**HTML is the contract.** That directory is the deliverable, not an intermediate step toward a platform.

The CLI does the work. Your job is to run it, read what it reports, verify the result, and tell the operator what they got.

## The whole surface

| Command | What it does |
|---|---|
| `data-liberation inspect <url>` | Bounded read-only source assessment with explicit coverage and unknowns |
| `data-liberation <url>` | Detect the platform, discover routes, liberate every one, write the site |
| `data-liberation compare <run-dir>` | Verify baseline fidelity against frozen capture-session source evidence |
| `data-liberation publish <run-dir> --to <target>` | Put the copy on a live URL |

## Step 1 — Liberate

```bash
data-liberation https://example.com/
```

Writes the site and exits, reporting two lines:

```
Liberated 12/12 routes (3 reused)
Site: /Users/you/data-liberation/example.com/website
```

The run directory is that path with `website` removed — pass it to `compare` and `publish`.

- `--output <dir>` chooses where the run lands. Default is `~/data-liberation/<host-slug>`.
- `--resume` reuses what is already on disk and reports it as `reused`. Add it when re-running against a site you have already liberated; without it the run captures the source again.
- `--screenshots` adds desktop and mobile PNGs when the operator wants visual evidence.
- Leave fluid learning on. It is what keeps the copy reflowing like the source instead of freezing at one width.

## Step 2 — Verify

```bash
data-liberation compare <run-dir>
```

This runs two tiers, and the report says which found what.

**Self-consistency, over every route, offline.** Does the copy work on its own terms — every same-page and cross-page anchor resolving to exactly one target, every internal link landing on a real file, no asset still pointing at the origin. This needs no browser and no network, so it covers the whole site in milliseconds.

**Frozen source fidelity, in a browser.** Does the copy match the cleaned source observed during capture — text and geometry at 390, 768 and 1440 pixels, over all receipt routes by default. Replay never visits the source. Missing, stale or ambiguous evidence is unproven and prevents a pass. Old runs need recapture to obtain frozen evidence.

`--candidate <url>` selects materialization: portable capture → candidate. Compose that result with capture-stage verification for chain acceptance. Only explicit `--stage drift` revisits today's live source, sampling routes and unsampled widths; motion contracts require drift. Baseline evidence excludes dialogs, zoom and motion. Report those as unknown; downstream acceptance requiring them must request the states through the API or keep them pending. See `docs/fidelity-reference.md` for the exact API and scope.

**Exit 0 proves the reported scope. Exit 1 means report failed or unproven evidence.** Each failure names what diverged:

```
self-consistency FAIL anchor-ambiguous: 1 route(s) — / /index.html#introduction matches 2 targets
capture /anchor/ 1440px baseline FAIL: text 62 chars !== source 707
```

The closing line states the scope measured, and both tiers must pass:

```
Passed: 4 route(s) checked offline, 4 of 4 in capture scope, against https://example.com/
```

Report the stage, required/measured cell coverage, pending evidence and unknown states. When drift samples fewer routes than captured, say so rather than describing the whole site as verified. Add `--screenshots` to write source, copy, and diff PNGs. The pixel score is evidence for a human; pass or fail comes from the named checks.

## Step 3 — Publish

Run this when the operator asks for a live URL.

```bash
data-liberation publish <run-dir> --to <target>
```

Ask the operator where it should go. `spacefast` is the default when `--to` is omitted. To see what a build actually offers, name a target that does not exist — the error lists the registered ones:

```
Unknown publish target "list". Available: spacefast.
```

A publish reports the same shape whichever target serves it:

```
Published 1 files to spacefast.
Live: https://gzipped-nest.view.fast/
Version: https://v1--gzipped-nest.view.fast/
This space is private by default, so the live URL returns 403 until access is granted.
Claim it to keep it: https://my.spacefast.com/claim#sfc_…
Claim expires: 2026-08-28T06:58:13.658Z
```

Give the operator every line of that. **A claim link and its deadline matter most.** When a target publishes anonymously, the space belongs to nobody until it is claimed, and it can stay private meanwhile — the run above answers 403 to everyone until the operator acts on the link. Reporting the live URL alone would tell them the publish worked and leave them looking at an error.

`--token`, or the target's token environment variable such as `SPACEFAST_TOKEN`, publishes into an account they already own.

Publishing reads what is on disk, so a repaired copy or a different target can ship without touching the source site again.

## Showing the copy to a human

```bash
data-liberation https://example.com/ --resume --serve
```

`--serve` keeps a local server running on the copy until it is interrupted, so offer it when someone wants to browse the result. With `--resume` alongside it, the site is already on disk and the server comes up immediately. Every run that does not serve prints this same command on stderr.

Run it only when a human is waiting for it, since the command holds until interrupted.

## What a run leaves behind

| Path | Contents |
|---|---|
| `website/` | The deliverable. Serve this directory anywhere |
| `capture-receipt.json` | Source URL, route table mapping each page to the URL it came from, assets, profile |
| `diagnostics.json` | Everything the source withheld or the capture could not resolve |
| `source-profile.json` | Measured behavior: one document or per-device, declarative or runtime-written geometry, switch width |

## Reporting a run

Give the operator:

1. Routes liberated, reused, and failed, from the CLI's own summary.
2. The compare result per width, quoting any failure text verbatim.
3. Any `diagnostics.json` key that came back non-empty, named and counted.

The keys worth surfacing are `failures`, `resourceFailures`, `unresolvedDependencies`, `unresolvedMedia`, `unresolvedAnchors`, `interactionFailures`, `excludedRoutes`, and `duplicateRoutes`.

## Reading a compare failure

| Failure text | Where to look |
|---|---|
| `widest image … Δ` or `doc width` | Geometry froze at the capture width — confirm fluid learning ran, in `source-profile.json` under `geometry` and `learned` |
| `nav … same-page anchor(s) missing` or `match more than one target` | `diagnostics.unresolvedAnchors` names the fragment and the reason |
| `copy requested N external host(s)` | `diagnostics.unresolvedDependencies` and `resourceFailures` |
| `internal link(s) 404` | `diagnostics.excludedRoutes` and `duplicateRoutes`, plus the route table in the receipt |
| `title … !== source` or `text … chars` | Compare the receipt's route table against the URL the source actually serves |

Report the failure and the matching diagnostics together, so the operator sees both the symptom and the evidence.

## Done

A baseline liberation is verified when `compare` exits 0 and the operator has the run directory, the route counts, measured scope, and any unresolved entries or unknown states. Broader interaction acceptance stays pending until its requirements are proven. A live URL is complete when `publish` has reported it, along with the claim link when the publish was anonymous.
