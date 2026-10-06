# Soloist tenant discovery

Soloist serves customer sites under the first path segment of a shared origin.
The adapter fetches that tenant's homepage once, merges its authored same-origin
page links with the published Next page list, and checks the exact handle path
boundary. It classifies routes relative to the tenant, so the customer handle
does not affect route types. It retains section anchors in navigation while
deduplicating them into the homepage route.

The global sitemap is not a tenant inventory. Discovery never requests it or
the platform homepage. External links remain authored links in capture; this
adapter only filters the route inventory and tenant navigation. Discovery
coverage is limited to homepage links and published page metadata. Missing or
unparseable metadata does not prove that no additional pages exist.

## Implementation evidence — 2026-10-06

- Owning tracker: https://github.com/Automattic/data-liberation-agent/issues/568
- Homeboy run: `agent-task-50c73f73-8b31-4575-b5a0-daa1407907d9`
- Execution: operator-authorized direct OpenCode fallback in isolated worktree
  `data-liberation-agent@feat-568-soloist-tenant-discovery`; finalization outside
  Homeboy. AI contribution: OpenCode, `openai/gpt-6.1-sol`, investigation,
  implementation, regression tests, and verification.
- Node fetch of `https://soloist.ai/bethstuqui/` returned HTTP 200, redirected to
  `/bethstuqui`, and exposed `props.pageProps.handle = "bethstuqui"`,
  `pagePath = "/"`, and `data.websiteSettings.pages` containing only `path: "/"`.
- Authored tenant links: `/bethstuqui/`, `#services-1`, `#gallery-1`, and
  `#contact-1` under that root. Instagram is external. The made-with badge points
  to `https://soloist.ai/` with referral parameters.
- Registered detection: `soloist`, high confidence. Live discovered inventory:
  `[{ "url": "https://soloist.ai/bethstuqui/", "type": "homepage" }]`.
- Fresh Chromium navigation with `locale: "en-US"` returned HTTP 200 at
  `https://soloist.ai/bethstuqui`, title
  `Beth Stuqui: Beleza em óleo sobre tela - Beth Stuqui`. Rendered links confirmed
  the same tenant section targets and external footer badge.

Reproduce registered discovery from the source checkout:

```sh
node --import tsx --input-type=module -e '
import { detectPlatform, resolvePlatform } from "./src/index.ts";
const url = "https://soloist.ai/bethstuqui/";
const detection = await detectPlatform(url);
console.log(detection);
console.log(await resolvePlatform(detection.platform).discover(url, {}));
'
npx vitest run src/adapters/soloist/discover.test.ts src/adapters/nextjs/detection.test.ts --maxWorkers=2
npm run build
npm run test:package
```

The focused gate passed 17 tests. Build and installed-package/relocated-runtime
integration passed, including browser-backed workflows. Generated `dist/` is
restored before committing, per repository policy.

Live verification here proves tenant discovery and ordinary browser navigation,
not Beth Stuqui's full capture/fidelity comparison. Shared browser locale work
belongs to issue #570; integration should verify fresh capture and compare with
that change. No global sitemap scan was performed.
