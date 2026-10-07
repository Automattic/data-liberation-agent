# Source cleanup and destination attribution

Tracking: https://github.com/Automattic/data-liberation-agent/issues/211

Capture applies a versioned source cleanup policy by default before settling, HTML, screenshots, responsive evidence and interaction capture. A bounded mutation observer removes matching late-inserted nodes. The eight built-in platform adapters supply provider identities; shared mechanics remove provider credit links and plain-text footer credits while preserving the owner's copyright, footer content and authored articles about platforms.

Wix free banners and Webflow badges have explicit rules. Generic rules recognize declared advertising slots, Google advertising frame identifiers, advertising-network script/frame hosts, and Outbrain/Taboola containers. Provider acquisition-bar recognition is shared with overlay detection and legacy export cleanup. Host recognition for provider links and network rules compares URL hostnames, not incidental query-string mentions.

Provider service UI that only works on the provider is a third category, `provider-service`. Wix Members login is the first: its dialog (`wix-members-dialog`) is removed wherever the "Sign In" control opens it, so it never reaches the captured HTML or the dialog states. Dialog probing sweeps the installed policy before it records an opened dialog, so this holds after the mutation observer's budget is spent.

The controls that opened that login stay, because they are part of the owner's layout, but with the dialog gone they lead nowhere. Where a reader should sign in is the destination's decision (a static host has no accounts; WordPress has `wp_login_url()`), so capture neither invents a target nor changes the element. The adapter's `beforeSerialize` only marks every member sign-in entry point (`src/lib/member-login.ts`), with the class `dla-member-login-<provider>` and the attribute `data-dla-member-login="<provider>"`. The class is the durable marker, since block conversion keeps classes on buttons and links where it drops data attributes. Wix's login-bar button stays a focusable `<button>` with its icon and label. Same-origin links into the Wix members area keep their `href`: that area is `/account/...` on a connected domain and `/<site>/account/...` on a free `wixsite.com` site. A destination with a login points every marked control at it; one without can hide them.

A rule can also mark an **access gate** (`accessGate: { provider }`): an element that withholds the whole route, such as the blocking layer Wix shows on a members-only page (`wix-members-gate`, listed before the dialog rule so a blocking gate is recorded as the gate). A visitor-side capture can never see that content, and copying the gate ships a dead login form, while skipping the route breaks every menu link to it. A route counts as gated only when the gate's removal is recorded on the settled page, before any probe clicks, **and** the page kept no content root (`main` or `[role="main"]`). The same Wix blocking layer also wraps the login when it opens over a public page, and that page keeps its content. A gated route is captured as a placeholder instead (`src/lib/access-gate.ts`):

- The site's public root is loaded and cleaned.
- Its `main` content is replaced with a heading and a note ("This page was members-only on your Wix site, so its content couldn't be copied. Add the content here, or protect this page with a password."). The heading is the page's label from the navigation; other same-path links don't count.
- The navigation links to the route get `aria-current="page"`.
- The title becomes `<label> | <gate title>`, unless the gate title already starts with the label.
- `og:title` and `twitter:title` follow the title. The canonical URL, `og:url` and history entry are restored to the gated route.
- The root page's description and share image (`description`, `og:description`, `og:image*`, `twitter:description`, `twitter:image*`) are removed rather than reused. Screenshots, geometry and HTML then all describe that one document. The manifest entry and the receipt's route record `accessGate: { rule, provider, shell, label }`. When the gated route is the site root, the note goes into the gated document as it is.

A final `builder-chrome` rule catches host-platform badges from builders with no adapter of their own: a viewport-fixed element making an authoring offer ("edit/made/built/created/designed/generated with/on/by/using", text or image `alt`/`aria-label`/`title`) that also serves an asset or link from the named entity's own domain. Naming without owning a domain (a "Made with love in Brooklyn" credit) or serving assets from the site's own origin (an owner's authored tooling link) is not chrome and stays untouched — the domain-ownership check is what keeps authored content safe. A platform that registers its own rule (Lovable's `#lovable-badge`, Wix, Webflow) is removed by that named rule first and keeps its identity in the evidence; this one is what runs for the platforms nobody named.

Removal collapses the matched slot and up to four empty ad-only wrappers. A fixed bar's matching top/bottom body padding is reclaimed. A bar whose runtime publishes its measured height into custom properties names them on its rule (`reclaimVariables`), and those are zeroed at `:root` in a stylesheet that travels with the captured document: the reservation leaves with the bar instead of staying frozen at whatever the live session measured, in every rule that reads it. A property that is undeclared or already zero is left untouched, so `var(--name, fallback)` readers keep their fallback. Normal content landmarks and mixed-content parents are retained. Plain-text credits spanning styled spans are removed by text range, preserving surrounding owner text. A credit verb may carry one conjoined qualifier ("Powered and secured by Wix"); the qualifier leaves with the credit and the owner's copyright in the same paragraph stays.

## Extension API

```ts
import { registerPlatform, providerCreditRules } from 'data-liberation';

registerPlatform({
  id: 'example-builder',
  discover: discoverExampleRoutes,
  liberation: {
    cleanupRules: [
      ...providerCreditRules('example-builder', ['builder.example'], 'Example Builder'),
      { id: 'builder-bar', category: 'source-attribution', selector: '#builder-bar',
        reclaimVariables: ['--builder-bar-height'] },
      { id: 'builder-badge', category: 'source-attribution', selector: '.builder-badge' },
      { id: 'builder-ad', category: 'advertisement', selector: '[data-builder-ad]' },
    ],
  },
});
```

The policy is persisted in `capture-receipt.json`. Per-page/viewport removal evidence lives in `cleanup-evidence.json`: matched rule/category, bounded selector/text, action, padding treatment, any custom properties reclaimed with the removal (`reclaimedVariables`), failures, truncation and detected residuals. A resumed capture with an absent or different policy is recaptured. Policy-schema changes are required when removal semantics change.

Limits: at most 100 rules, 20 reclaimed custom properties per rule, 1,000 removal actions per viewport, 100 mutation batches, and 200 detailed records. Invalid selectors, residual matches at the action limit and exhausted mutation processing fail capture/comparison instead of silently succeeding. Record truncation is reported separately from rule execution failure.

This is rule-based recognition, not a claim that arbitrary first-party sponsored content can always be distinguished from owner content. Retained embedded surfaces and open shadow roots are explicitly reported as uninspected. `cleanup.complete` means the recorded rule execution completed; it is not a universal ad-detection guarantee. Consumers can inspect `unknowns` and extend rules for additional sources.

## Comparison

Default `compare` uses the cleaned, frozen capture-session source observations and their cleanup audit, without revisiting the source. `compare --stage drift` replays the capture's exact supported policy on the live source before text, image, typography and geometry observations. Routes captured as access-gate placeholders are set aside and logged: the live source only ever shows its login there, so replaying it would report the placeholder itself as drift. Requesting one explicitly is an error. Frozen capture and materialization comparisons still include them. Drift records reference-side removals in `compare/cleanup-evidence.json` and logs the removal count. Retained-content checks remain active; there is no rectangular mask or tolerance exemption for arbitrary missing content.

The candidate is also audited: a matching ad or source credit remaining in the liberated artifact fails comparison. An interrupted/failed drift comparison writes `completed: false` cleanup evidence instead of leaving a previous successful report looking current. Frozen stages report pending evidence and findings in `compare/<stage>/report.json`.

An incomplete recorded cleanup or unsupported policy fails explicitly. Older captures without a policy are compared against the original unnormalized source and identified as legacy in the log; recapture to use cleanup-aware comparison.

## Publish targets

The public package exports `registerPublishTarget`, `publishSite` and their types. A target may provide an optional `attribution({ directory })` hook. It receives a disposable staging copy before `publish` receives that same directory. Staging is removed on success, attribution failure or publish failure. The canonical liberated directory is unchanged. Targets without the hook add no DLA attribution.

```ts
import { registerPublishTarget, publishSite } from 'data-liberation';

registerPublishTarget({
  name: 'example-host',
  async attribution({ directory }) {
    // Add the destination's chosen attribution to its staging copy.
    await addHostAttribution(directory);
  },
  async publish({ directory }) {
    return uploadToExampleHost(directory);
  },
});
await publishSite({ directory: './run', target: 'example-host' });
```

## Reproduce verification

```sh
npm ci
npx tsc --noEmit
npx vitest run src/lib/source-cleanup.test.ts src/lib/access-gate.test.ts src/ui/publish.test.ts
npm test
npm run build
npm run test:package
node dist/cli.js https://example.com --output .tmp-test/cleanup-live --no-learn-fluid
node dist/cli.js compare .tmp-test/cleanup-live/example.com
```

The browser fixtures cover a free banner, split-span footer credit, owner copyright, authored platform discussion, inline/framed/late ads, reclaimed spacing at desktop/mobile widths, and a Wix-shaped bar whose height is published into custom properties read by a sticky header, the page root and a pinned menu layer. The actual screenshot capture/export pipeline produces a clean artifact, cleanup-aware comparison passes, and deleting retained owner content fails. Publisher tests verify default output, destination attribution, immutable source and cleanup on both failure paths. Invalid cleanup selectors produce recorded failures.

Final integration with merged inspection PR #212 passed 96 files / 1,001 tests using `npm test -- --maxWorkers=2 --testTimeout=45000`, plus build/typecheck and installed-package checks. Lower concurrency and a longer per-test timeout were used after a busy-controller run timed out; the timed-out browser test passed in isolation. The 128 MiB export test also passed in isolation and in the final full run without changing its heap limit.

On September 15, 2026, the built public-source workflow captured `example.com` (1/1 routes) and passed comparison at 1600px, 1728px and the 390px interaction check, with zero offline findings. That source has no ads or provider credits: the removal behavior is proven by controlled browser fixtures rather than inferred from that public-source pass.

AI assistance: OpenAI gpt-6-astra through OpenCode implemented and verified this work directly in an isolated worktree under Chris Huber's direction. Homeboy failed before provider execution; direct implementation followed the user's instruction to bypass it.
