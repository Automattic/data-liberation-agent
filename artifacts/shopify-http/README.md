# Shopify HTTP projection — responsive review slice

Tracker: https://github.com/Automattic/data-liberation-agent/issues/467
Initial base: released v0.20.0, `701b0d79289253d0dd780fb2b6a06da3f7fb2c65`.
Reviewed base: current upstream `fbda520f`, including the shipped clone-aware
fluid-baseline owner. The existing owner also restores unlearned geometry after
returning to the capture viewport; callback rejection uses its failure cleanup.
Branch: `fix/467-shopify-responsive-projection`; source was uncommitted at measurement time.
`report.json` pins capture-time source bytes, current source and local evidence.

## Delivered

- Subtree requirements can retain acquired root attributes, including absence,
  while projecting runtime descendants. Collection image/label and price regions
  preserve authored responsive geometry instead of carrying a stale equal-height
  ancestor. No source viewport is patched to make the comparison pass.
- Brooklyn uses the direct `slickPause()` API, not `slick('slickPause')`. The
  observed phase is retained; no slide number is selected by the adapter.
- An export-only hook reuses the existing fluid learner after source evidence is
  recorded. Track/slide widths and opt-in relative offsets become ordinary CSS.
	 Source-owned motion preparation runs before each sample. Default browser
  routing and default fluid property discovery remain unchanged.
- Independent visitor checks call readiness alone, never export projection.
  Resize evidence, independent visitors and volatile app presentation remain
  distinct. Products retain the shipped body-CSS and wallet geometry work.
- Relative offsets are learned only for elements that remain relatively
  positioned across all samples. Verification measures horizontal position;
  callback failures restore the baseline viewport/styles and remove markers.
- Finite animation pose is finalized before both counters and screenshots,
  preventing a fade from reporting missing imagery that the screenshot contains.

## Measured result

Independent final evidence: `.tmp-test/shopify-responsive-current-reviewed/` — **8 retained
acquired documents, 8 new runtime observations, 92 projected regions, 4 routes,
44 views**. All routes have independent 390/768/1440 visitors; homepage and
collection additionally have independent 601/1024 visitors. No other intermediate
coverage is inferred.

The first normal `captureWebsite` run acquired the eight documents in 144.446s.
A subsequent acquisition hit HTTP 429 for one product variant and is retained
as incomplete. Final hash-verified retained-acquisition reprojection took
**151.036s**, including source-evidence callbacks. This is not a new acquisition
time, full-site benchmark or quality-equivalent speedup.

| Independent visitor | Text equal | Height delta | Changed full-page pixels |
| --- | --- | --- | --- |
| Homepage 390 | yes | 0px | 0.101% |
| Homepage 601 | yes | 0px | 0.065% |
| Homepage 768 | yes | 0px | 0.156% |
| Homepage 1024 | yes | 0px | 0.155% |
| Homepage 1440 | yes | 0px | 0.017% |
| Collection 390 | yes | 0px | 0.002% |
| Collection 601 | yes | -3px | 5.198% |
| Collection 768 | yes | 0px | 0.329% |
| Collection 1024 | yes | 0px | 0.274% |
| Collection 1440 | yes | -1px | 2.830% |

The before-fluid control measured homepage fresh-visitor differences of 7.36%
at 768 and 12.05% at 1024. Final selected-source tablet pixels are 0.0012%; the
independent tablet remains a separate measurement at 0.156%.

Collection fresh tablet is **3712px**, matching portable. The unchanged resized
source is **3940px**: six rows still retain 377px heights instead of 339px. The
copy deliberately matches the independent visitor, not that stale pose.
Collection painted/decoded image counts match 13/13 at every measured width.
Homepage painted/decoded counters now agree at 6/6 after normalizing the finite
fade pose. The earlier 6/4 diagnostic came from reading visibility before the
animation-disabled screenshot completed the fade, not omitted source images.

## Remaining parity blockers

- Collection runtime rounding: at 601px, six rows differ by 0.5px each; at 1440,
  authored 376.65625px boxes differ from runtime-rounded 377px boxes. Retaining
  authored geometry solves the 228px loss but does not model quantization. The
  next primitive needs independent fresh-width samples and explicit rounding
  provenance; the fluid fitter's 2px tolerance cannot establish exact rounding.
- Product selected-source and independent visitor text/height match at all three
  widths in this reproduction. An earlier fresh phone session differed by 50px,
  localized entirely to recommendations. That observation stays retained as
  source-session/app drift rather than being attributed to a new code fix.
- Informational content retains +2px, video/poster differences and source broken
  media. Wallet children, forms/checkout backends, gallery/header interactions,
  full inventory and WordPress acceptance remain unverified.

Overall rendering remains **measured, incomplete and unaccepted**. No frozen
`compare` reference or exact whole-site parity claim is synthesized.

## Verification and reproduction

131 targeted tests across 10 files plus 11 relevant fluid browser tests passed,
along with TypeScript, build and relocated-package checks. Generated `dist/`
matches the reviewed base. Current integration logs:
`.tmp-test/shopify-responsive-upstream-checks/` — **139 tests across 11 files and
15 affected fluid browser tests**, TypeScript, build and relocated-package checks
passed. These include clone replacement/removal and the shared baseline owner.
An affected-file gate including the entire fluid capture file timed out at 300s;
that attempt is retained separately and is not counted as passing. Full-suite CI
remains main's gate.

```sh
PROOF_OUTPUT=.tmp-test/shopify-responsive-review npx tsx scripts/shopify-runtime-proof.ts
VERIFY_OUTPUT=.tmp-test/shopify-responsive-review-checks node scripts/verify-shopify-runtime-proof.mjs
VERIFY_OUTPUT=.tmp-test/shopify-responsive-review-checks node scripts/report-shopify-runtime-proof.mjs .tmp-test/shopify-responsive-review
node scripts/validate-shopify-http-evidence.mjs .tmp-test/shopify-responsive-review/projection-report.json
```

For rate-limited acquisition, set `PROOF_ACQUISITION` to a complete retained run
and use a fresh `PROOF_OUTPUT`. The runner verifies every raw/prepared hash and
uses the same observation, staging and export owners; reports label reprojection
explicitly. `PROOF_BEFORE` optionally selects a retained comparison report.
Raw DOM, responses, screenshots and logs stay ignored and local.

A retained earlier attempt stopped at an uninitialized source slideshow in the
independent 1024px session. Diagnosis recorded source `$`/`Modernizr` errors;
separate retained-response and live-visitor probes subsequently initialized
correctly. The final strict proof completed all 44 views without changing its
readiness timeout. The interrupted run and source diagnostics remain local
evidence; no stability or source-bootstrap root-cause fix is claimed.

Direct OpenCode work in this Homeboy-native isolated worktree was authorized
after the two-attempt recovery budget. Runtime/session evidence and commands are
retained locally in `.tmp-test/shopify-responsive-session.md`. Independent review
and reproduction corrected the offset restriction and animation-pose evidence
before finalization. Human authorization remains required for merge/release.

AI assistance: OpenAI `openai/gpt-6.1-sol` using OpenCode implemented and measured
this slice and its neutral regressions under human direction.
