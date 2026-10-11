# Reference-cell ownership consolidation (#706)

## Why this path exists and what is deleted

`createReferenceCollector.observe()` freezes fresh-visitor documents at each
required viewport. A resized capture page can carry breakpoint/scroll history;
profile cells additionally need their own context because `setViewportSize()`
resets preset screen identity. Session storage is copied only at runtime.

This slice consolidates **cell cleanup ownership**, rather than reusing source
observations. It deletes the per-cell repeated source-context/browser/identity
lookup, sibling-page retry/catch fallback, and separate page/context cleanup
branches. Each cell owns either a context or a sibling page through one
`ownedResource`; a borrowed source page has no owned resource. Context ownership
is registered before init-script/page setup, and navigation-release failure
cannot bypass resource cleanup. After sibling capability is proven, an
acquisition failure remains that cell's unready outcome instead of borrowing the
source page concurrently.

The one capability check remains deliberately: Playwright's public API reveals
convenience ownership by rejecting `context.newPage()`. A preset-screen cell
cannot consume that sibling page. Removing this check while retaining both
preset-screen replay and serial convenience borrowing would require another
ownership contract or private API. The smaller consolidation avoids either.

Existing page helpers own readiness/pose, source navigation owns route and
external-boundary policy, and capture profiles own public browser identity.
Those primitives are reused. No new resource abstraction or configuration is
introduced. Source `reference.ts` shrinks from **260 to 254 lines**.

## Immutable base versus candidate

Base: `181d2ae9` (fetched `origin/main`). Four real-Chromium modes each observe
768/1440 success cells, followed by 768/1440 HTTP-500 cells. Spies delegate to
real Playwright methods and measure resource calls; the HTTP server, browser,
storage, screen, artifacts, navigation failures and cleanup are real.

Counts below cover both observations (four required cells). Owned-page closes
exclude the capability page, which is unchanged. All modes retain the source
page and finish with no owned pages/contexts remaining.

| Mode | Source sibling attempts, base → head | Owned contexts, base → head | Explicit owned-page closes, base → head | Owned-context closes, base → head | Fixture ms, base → head |
| --- | --- | --- | --- | --- | --- |
| Profile | 2 → 2 | 4 → 4 | 4 → 0 | 4 → 4 | 1923 → 2005 |
| Sibling | 6 → 6 | 0 → 0 | 0 → 0 | 0 → 0 | 1664 → 1976 |
| Borrowed convenience | 6 → 2 | 0 → 0 | 0 → 0 | 0 → 0 | 1816 → 1940 |
| Persistent | 6 → 6 | 0 → 0 | 0 → 0 | 0 → 0 | 1754 → 1848 |

Each mode preserves **six byte-identical artifact SHA-256 values**: observation,
HTML and PNG at both success widths. Across four modes that is **24 identical
artifact digests**, eight ready success cells and eight equivalent typed unready
HTTP-500 cells. Readiness comparisons normalize only the ephemeral local server
origin in `cleanup.url`; artifact hashes are compared without normalization.
All stored artifacts also pass the existing hash-validating reader.

The profile fixture proves 1920px screen identity at both target widths, the
declared user agent, four distinct contexts, and source-session storage
independence even when each successful reference cell mutates its own storage.
The borrowed fixture proves peak one source request and balanced runtime/crash
listener removal. Existing tests prove fresh versus resize-history outcomes,
ordered concurrent independent cells, mobile device/density replay, route drift,
protocol redirects, external boundaries, frozen provenance and font readiness.

The immutable base fails exactly the two deletion assertions: redundant profile
page closes and repeated rejected borrowed sibling attempts. Sibling and
persistent cases pass on both sides. Timings are single fixture measurements;
they establish **no runtime or end-to-end speedup**.

## Verification and artifacts

Commands run from the isolated issue-linked worktree:

```sh
npm ci
npx tsc --noEmit
DLA_REFERENCE_BASELINE="$BASELINE/src/lib/fidelity/reference.ts" \
  DLA_REFERENCE_EVIDENCE=.tmp-test/evidence/base \
  npx vitest run src/lib/fidelity/reference.test.ts \
  -t 'releases only owned' --maxWorkers=1
DLA_REFERENCE_EVIDENCE=.tmp-test/evidence/candidate \
  npx vitest run src/lib/fidelity/reference.test.ts \
  -t 'releases only owned' --maxWorkers=1
npx vitest run src/lib/fidelity/reference.test.ts \
  src/lib/fidelity/profile-capture.test.ts \
  src/lib/fidelity/redirect-outcome.test.ts \
  src/lib/source-navigation.test.ts --maxWorkers=4
npm run build
npm run test:package
git restore --source=HEAD --staged --worktree -- dist
npm test -- --maxWorkers=4
```

- Focused reference/profile/redirect/navigation: **41 passed**, four files.
- Final resource fixture: **4 passed**; types, build and actual relocated package
  workflows passed.
- Local full suite: **1975 passed, 60 failed, three existing skips**. The failure
  report includes `getaddrinfo ENOTFOUND localtest.me` and Chromium
  `ERR_NAME_NOT_RESOLVED` in the unchanged localtest.me discovery/inspection/
  cleanup/session/fidelity fixtures. This local run is not a passing full gate;
  the PR's required CI is the authoritative complete-suite gate.
- Bounded public-route check: `https://example.com/`, two independent desktop
  reference cells (768/1440), **2/2 ready and hash-valid**, 1473ms, source page
  open and one caller-owned context remaining. This is a reference-only check.
- `dist/` restored to the source base after build/package/full-suite commands.

Retained local artifacts: `.tmp-test/lifetime-base.log`,
`.tmp-test/lifetime-candidate.log`, `.tmp-test/lifetime-final.log`,
`.tmp-test/evidence/{base,candidate}/{profile,sibling,borrowed,persistent}.json`,
`.tmp-test/compare-evidence.mjs`, `.tmp-test/evidence-comparison.log`,
`.tmp-test/focused.log`, `.tmp-test/build-final.log`,
`.tmp-test/package-final.log`, `.tmp-test/full.log`,
`.tmp-test/source-spotcheck.ts`, `.tmp-test/public-spotcheck.log` and
`.tmp-test/public-reference/` (manifest, receipt, observation/HTML/PNG bytes).

AI disclosure: OpenAI `openai/gpt-6.1-sol` through OpenCode implemented,
self-reviewed and verified this refactor under the operator-authorized direct
recovery workflow. Implementation and finalization occurred outside Homeboy,
with no delegated agents. Human/parent owns merge.
