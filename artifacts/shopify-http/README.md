# Shopify HTTP projection — verified review milestone

Tracker: https://github.com/Automattic/data-liberation-agent/issues/467
Baseline: `53b52d46`; candidate source hashes and evidence are pinned in `report.json`.

## Delivered

- Declared runtime subtree/attribute projection through the existing HTTP
  observer → staging → exporter path, preserving route/variant identities.
- Valid parent content survives incomplete embedded children. Expected node
  counts, projected indices and unresolved children remain explicit.
- Runtime CSS includes active styles inserted under body, preserves source order
  and media conditions, and diagnoses location-dependent implicit scopes.
- Responsive assembly retains native important priority, including shorthand
  conflicts, and leaves identity-free browser-tolerated CSS untouched.
- The Shopify-owned Brooklyn profile projects lazy images, initial gallery,
  reviews/recommendations, selected sort, header and measured wallet presentation.
  Backend purchasing/forms and interaction reconstruction remain unverified.

## Fresh measured result

`.tmp-test/shopify-http-reviewed-projected/` contains **8 acquired documents,
8 runtime observations, 68 projected regions, 4 exported routes and 28 views**:
12 selected source, 12 offline portable, plus 4 independent fresh tablet visitors.
Capture with source-evidence callbacks took **127.677 seconds**. This is a bounded
review workload, not a full-inventory benchmark or quality-equivalent speedup.

| Route | Source→portable height delta at 390 / 768 / 1440 | Changed full-page pixels |
| --- | --- | --- |
| Homepage | 0 / 0 / 0px | 0.10% / 8.30% / 0.020% |
| Collection | 0 / 0 / 0px | 0.057% / 0.0019% / 0.0013% |
| Product | 0 / 0 / 0px | 0.029% / 0.256% / 0.280% |
| Informational | +2 / +2 / +2px | 0.816% / 1.557% / 3.438% |

Product and collection main text match all selected-source widths. Homepage
tablet text still differs. Painted images are measured separately: duplicated
hidden responsive image elements are not additional preserved source images.

**Fresh tablet validation remains red:** the collection's resized source session
retains a stale 377px equal-height value, while a fresh 768px visitor has 339px
cards. Six rows × 38px explains the +228px portable difference. Homepage tablet
slideshow state, volatile product recommendations, native video/poster losses,
unresolved wallet children and interaction/backend behavior also remain explicit.
No frozen `compare` evidence or accepted-site completeness was synthesized.

## Verification

93 scoped tests across 8 files, TypeScript, build and relocated-package checks
passed in `.tmp-test/shopify-http-verified-checks/`. Regressions cover actual
browser observation/staging/export, partial children, CSS media/order/scope,
shorthand priority, responsive layout and closed-shadow wallet presentation.
Fixtures use intercepted/injected resources; CI does not fetch the storefront.

The broader `npm test -- --maxWorkers 2` run was interrupted at the 900-second
tool deadline on the busy host, without a terminal result. It is not an all-pass
claim; authoritative CI must establish the repository-wide gate.

```sh
PROOF_OUTPUT=.tmp-test/shopify-http-review npx tsx scripts/shopify-runtime-proof.ts
VERIFY_OUTPUT=.tmp-test/shopify-http-review-checks node scripts/verify-shopify-runtime-proof.mjs
VERIFY_OUTPUT=.tmp-test/shopify-http-review-checks node scripts/report-shopify-runtime-proof.mjs .tmp-test/shopify-http-review
node scripts/validate-shopify-http-evidence.mjs .tmp-test/shopify-http-review/projection-report.json
```

The proof pins four routes via the existing adapter dependency seam; normal HTTP
CLI/API capture uses the same registered profile. Use a fresh output directory.
Historical before/localization artifacts are optional for fresh reproduction.
Raw DOM, network data, screenshots and logs stay in ignored local evidence.

## Workflow

Direct isolated-worktree implementation was explicitly authorized after Homeboy
recovery exhausted its two-attempt budget. Orchestrator review reproduced the
source findings and candidate, then corrected the product's omitted body CSS and
source-owned wallet geometry. Full-site capture and WordPress conversion have
not resumed: representative interaction and intermediate-width gates remain open.

AI assistance: OpenAI `openai/gpt-6.1-sol` using OpenCode implemented, measured,
independently reviewed and regression-tested this candidate under human direction.
