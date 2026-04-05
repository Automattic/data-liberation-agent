# Discoveries

A living log of findings from real migrations. Newest entries at the top.

AI agents: when you contribute an improvement, add an entry here. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required format.

---

## 2026-04-05 — Shopify admin internal GraphQL API via CDP

**Found by:** Claude + human contributor (HackerOne corpus analysis + architecture research)
**During:** Planning Shopify extraction pipeline
**Type:** API endpoint | architecture

### What I found

The Shopify admin dashboard does NOT use the public Admin API (`/admin/api/{version}/graphql.json`) for its own browser requests. Shopify has migrated their admin to `admin.shopify.com` and the actual internal GraphQL endpoint pattern is:

```
https://admin.shopify.com/api/operations/{hash}/{OperationName}/shopify/{shopAlias}
```

The operation name is both in the URL path and as an `operationName` query parameter. The `shopAlias` is a short internal identifier (e.g. `pz4bf6-qe`), not the `.myshopify.com` subdomain. This endpoint is authenticated via session cookies — no API key or OAuth token required.

> **Note:** Older research (HackerOne reports pre-2024) referenced `{store}.myshopify.com/admin/internal/web/graphql/core` — this endpoint no longer applies. Shopify migrated to `admin.shopify.com` and the new endpoint pattern above is what fires in practice.

**Confirmed operations and data paths from live testing:**

#### Inventory (list views)

| Admin URL | Operation | Response path |
|-----------|-----------|---------------|
| `/admin/products` | `ProductIndex` | `data.filteredProducts.edges` |
| `/admin/pages` | `PageList` | `data.onlineStore.pages.edges` |
| `/admin/articles` | `ArticleList` | `data.onlineStore.articles.edges` |

> **Note:** Blog posts use `/admin/articles` (not `/admin/blogs` or `/admin/blog_posts`). `/admin/blogs` fires `BlogList` which returns blog containers (e.g. "News"), not individual articles.

> **Note:** `ProductIndex` response does NOT have a top-level `products` field — products are under `filteredProducts`.

#### Detail views (per-item extraction)

Navigating to an individual item's admin URL fires multiple operations. The useful ones:

| Item type | Operation | Key data |
|-----------|-----------|----------|
| Product | `AdminProductDetails` | `data.product` — `title`, `handle`, `descriptionHtml`, `seo`, `options`, `status` |
| Product | `ProductMedia` | `data.product.media.nodes[]` — image URLs at `.preview.image.url` |
| Product | `AdminProductDetailsVariants` | `data.product.variants.nodes[]` — `price`, `sku`, `inventoryQuantity`, `selectedOptions` |
| Page | `PageDetails` | `data.onlineStore.page` — `title`, `body`, `handle`, `seo`, `isPublished` |
| Blog post | `ArticleDetails` | `data.onlineStore.article` — `title`, `body`, `handle`, `seo`, `image`, `tags`, `author`, `summary` |

**Important:** Product detail operations use **`nodes`** not `edges` for connections (variants, media). This is different from the list-view operations which use `edges`.

**Blog post images** are at `article.image.src` (not `.url`). The `image` field is `null` when no featured image is set.

**Product `selectedOptions`** nest the value under `optionValue.name` rather than a direct `name`/`value` — e.g. `selectedOptions[i].optionValue.name`. Correlate with `product.options[i].name` by position to get the attribute name.

**Shell/nav operations to ignore:** `Frame`, `RequestDetails`, `Betas`, `CriticalAppData`, `CoreExperiment`, `AdminNotifications`, `NavHeader`, `AppInstallationsContextProvider`

### How it works

Connect to the user's logged-in browser (Chrome or Brave) via `chromium.connectOverCDP()`. Use `page.on('response', handler)` to intercept all JSON responses from URLs containing `admin.shopify.com/api/operations/`. Navigate to each admin section — the dashboard's React app triggers GraphQL calls automatically. Filter by `operationName` in the URL to target specific content types.

### Why it's better than the API key approach

Most Shopify migration tools (including the WooCommerce plugin) require creating a private app, configuring OAuth scopes, and managing tokens. The CDP approach:
- Zero setup — user just logs into their normal browser
- No Shopify developer account or private app required
- Draft and unpublished content is accessible (unlike the public Storefront API)
- Session cookies valid for weeks — no token refresh logic needed
- Works with Brave browser when Chrome remote debugging has profile conflicts

---

## 2026-04-02 — Squarespace admin extraction via CDP

**Found by:** Claude + human contributor (live testing against a Squarespace site)
**During:** Building the Squarespace extraction pipeline
**Type:** API endpoint | architecture

### What I found

Connected to a logged-in Chrome session via CDP and intercepted Squarespace's admin API calls and `__NEXT_DATA__` hydration state. Key findings:

**Admin API endpoints discovered:**
- `/api/catalog-preview/` — page catalog with IDs, URLs, visibility status
- `/api/content/` — page content with structured sections
- `/config/pages` — page configuration and navigation structure

**`__NEXT_DATA__` hydration:** Squarespace's admin uses Next.js. The `window.__NEXT_DATA__` object contains page props with structured content, descriptions, and metadata that aren't available through the public API.

**Public `?format=json` API:** Squarespace exposes a no-auth JSON API by appending `?format=json` to any public URL. Returns collection metadata, item counts, tags, categories, and content. Useful as a fallback but lacks draft/unlisted pages and admin-only metadata.

### How it works

The extraction pipeline uses a three-tier fallback chain:
1. **Admin API interception** — CDP captures JSON responses from admin navigation, filtered to only include data relevant to the target page (excludes `/api/context/`, `/api/billing/`, user profile data)
2. **Admin `__NEXT_DATA__` hydration** — extracts structured page data from Next.js hydration state
3. **Public DOM extraction** — falls back to parsing the published page's DOM via the accessibility tree

Smart fallback heuristics trigger the public fallback when admin extraction produces <80 chars of content, <=1 section, or contains admin UI artifacts.

### Why it's better than the previous approach

The public `?format=json` API misses draft pages, unlisted content, and structured section data. Admin extraction via CDP captures everything the site owner can see, with the browser handling authentication automatically.

---

## 2026-03-31 — Wix Dashboard API reverse engineering via CDP

**Found by:** Claude + human contributor (live probing against Brave browser)
**During:** Building the probe tool against a real Wix account
**Type:** API endpoint | window global | architecture

### What I found

Connected to a live Brave browser session via CDP (port 9222) and probed both the Wix Dashboard (`manage.wix.com`) and Editor (`editor.wix.com`) pages. Key findings:

**Auth pattern**: Wix uses cookie-based auth + `X-XSRF-TOKEN` header + per-app `authorization` tokens (signed JWTs unique to each Wix "app" like blog, chat, etc.). The XSRF token comes from the `XSRF-TOKEN` cookie. The authorization tokens are embedded in the page at load time and are app-scoped.

**Key API endpoints discovered (all returning 200)**:
- `/_api/account-server/v1/users/my_accounts` — lists all user accounts
- `/_api/premium-store/plans/premiumStatus?metaSiteId=...` — shows plan type (FREE, PREMIUM, etc.)
- `/_api/site-actions/topology` — static asset URLs and service versions
- `/_api/header-server/init` — massive experiments config + feature flags
- `/_api/items-selection-service/v1/items-selection/installed-providers` — all installed Wix apps/providers (11KB+ of data)
- `/_api/notifications-widget-server/alerts` — site alerts
- `/_api/wix-laboratory-server/v1/laboratory/platform/conductAllInScope` — feature flag values per scope
- `/_api/dealer-offers-serving-service/v1/dealer/serving/offers/bulk` — 50KB of UI offers/placements

**Window globals of note**:
- `Wix` — object with `getSiteInfo`, `Dashboard`, `Utils`, `Settings`, `SuperApps`
- `__MEDIA_TOKEN__` — JWT for media CDN access (314 chars)
- `__WIXEXP_OWNER_ACCOUNT_ID_` / `__WIXEXP_LOGGED_IN_USER_ID_` — account UUIDs
- `__CAIRO_EXPERIMENTS__` — editor experiment flags
- `WIXCKEDITOR` — CKEditor instance (editor page only)

**What didn't work**: Calling `/_api/site-properties-service/properties` requires the metaSiteId as a specific header (not query param), and the blog API (`/_api/communities-blog-node-api/_api/posts/list`) requires a blog-specific `instanceId` different from the main site auth token.

### How it works

The `probe.js` script connects to a running browser via `playwright.chromium.connectOverCDP()`, then for each Wix page:
1. Scans `window` for all `__*` / `wix*` globals
2. Extracts JSON-LD structured data
3. Lists cookies and localStorage
4. Reads performance API entries for API endpoint discovery
5. Extracts site identity (metaSiteId, account IDs)

For deeper probing, we reload pages while the CDP Network domain captures full request/response pairs including auth headers and response bodies.

### Why it's better than the previous approach

Direct API probing against the user's own authenticated browser session means:
- No need to reverse-engineer auth — the browser already has valid cookies
- Response bodies captured via `Network.getResponseBody` give clean JSON
- The user-agent matches perfectly because it IS the user's browser
- Each Wix "app" (blog, store, forms) has its own auth token scoped to that app — intercepting during navigation is the reliable way to capture these per-app tokens

---

## 2026-03-31 — Initial extraction strategy

**Found by:** Human contributor (initial research)
**During:** Building this repo
**Type:** API endpoint | window global | architecture

### What I found
Wix sites make structured JSON API calls to their own backend during page load. Intercepting these calls gives cleaner data than parsing the rendered HTML output. Key endpoints include `/_api/wix-blog-frontend-server/`, `/_api/wix-public-data-webapp/`, and `www.wixapis.com`.

### How it works
Using Playwright's `page.on('response', ...)` handler to capture all `application/json` responses from `/_api/*` and `wixapis.com` URLs during normal page load. The responses contain structured blog post bodies, page metadata, CMS collection data.

### Why it's better than the previous approach
HTML scraping requires parsing Wix's heavily nested, obfuscated markup. API interception gives you clean JSON with semantic field names, correct dates, author information, and structured content — everything you'd want for a clean migration.

---

*This log grows with every migration. If you find something, add it.*
