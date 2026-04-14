# Discoveries

A living log of findings from real migrations. Newest entries at the top.

AI agents: when you contribute an improvement, add an entry here. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required format.

---

## 2026-04-13 — Hostinger Website Builder platform adapter

**Found by:** Claude + human contributor
**During:** Adding Hostinger Website Builder as a new supported platform (fastest-growing proprietary builder per w3techs: +103.9% YoY)
**Type:** platform adapter

### What I found

Hostinger Website Builder (formerly Zyro) is built on Astro and serves images from a dedicated CDN. Sites run on custom domains only — there's no `hostinger.com` subdomain pattern to key detection off of.

**Detection signals:**
- `zyrosite.com` references in page source (strongest signal — every Hostinger site loads images from `assets.zyrosite.com` via Cloudflare Image Resize)
- `<meta name="generator" content="Hostinger Website Builder">` tag (reliable fallback for sites with no inline images)
- `astro-island` / `astro-slot` custom elements confirm the Astro-based build but aren't needed for detection

**Content structure:**
- Content rendered as a series of `<section class="block ...">` elements with chrome (sticky bars, headers, footers) using distinguishing modifier classes (`block-sticky-bar`, `block-header`, `block--footer`, `block-blog-header`)
- Generic `class="block"` sections contain real content; modifier-class sections are site chrome
- `<main>` wraps ALL page sections including chrome, so main-based extraction pulls in site furniture — must extract by section classes instead
- Blog posts include rich JSON-LD `Article` schema with `headline`, `datePublished`, `articleSection` (categories), and `author.name`
- Product pages include JSON-LD `Product` schema and render the product block with `class="block-product-wrapper"`
- Blog templates render the post title as `<h1 class="block-blog-header__title">` inside the content — must be stripped to avoid duplicate titles when WordPress renders `post_title`
- Images served from `assets.zyrosite.com/cdn-cgi/image/format=auto,w=N,h=N,fit=crop/SITE_ID/hash.png` — the `/cdn-cgi/image/PARAMS/` prefix is a Cloudflare Image Resize transformation; stripping it yields the original asset URL
- CSS class names are hashed/obfuscated (e.g. `globalClass_2ebe`) — not useful as targeting selectors

**Sitemaps:** Standard XML sitemaps at `/sitemap.xml` with pages, blog posts, and category landing pages.

**Blog URL convention:** `/blog-post1`, `/blog-post2`, ... (sequential numeric slugs) — used for blog post classification.

### How it works

The adapter follows the established fetch-and-scrape pattern:
1. `detect()` is URL-less — relies on HTTP fingerprinting via `zyrosite.com` source signal and generator meta tag in `detect-platform.ts`
2. `discover()` fetches the homepage + sitemap, extracts site metadata from OG tags and `<html lang>`, classifies URLs (with `/blog-post*` and `/blog/*` treated as posts)
3. `extract()` uses `runExtractionLoop()` with a Hostinger-specific `extractPage` that:
   - Parses JSON-LD for Article metadata (headline, date, author, categories) and Product data
   - Extracts content by collecting non-chrome `<section class="block">` blocks
   - Strips the embedded `<h1>` title to prevent duplication with `post_title`
   - Resolves relative `src`/`href` attributes to absolute URLs so WordPress can match attachments during import
   - Signals product pages via `detectedType: 'product'` so they route to `products.csv` instead of being imported as pages
4. A per-URL `productCache` lets the adapter pre-extract WooProduct data from JSON-LD (which lives in `<head>`, outside our extracted content) and hand it to the shared loop's `extractProduct` callback

Content extraction uses `<section class="block">` blocks as the primary strategy with `<article>`, `<main>` (chrome-stripped), and `<body>` fallbacks. Media URLs are normalized by stripping the Cloudflare Image Resize prefix so byte-identical images aren't downloaded multiple times with different resize parameters.

### Why it's better than the previous approach

Hostinger Website Builder was not previously supported. This adds coverage for the fastest-growing proprietary website builder per w3techs data (+103.9% YoY, +2.16 daily sites gained), making it a high-value migration target for users who chose Hostinger's free/cheap tier and want to move to WordPress. Tested end-to-end against 5 live sites (content blog, multi-language villa site, AI marketing site, small bakery, commerce-enabled affiliate site) with pages, posts, products, and media all importing into WordPress correctly.

---

## 2026-04-13 — Weebly platform adapter

**Found by:** Claude + human contributor
**During:** Adding Weebly as a new supported platform
**Type:** platform adapter

### What I found

Weebly sites use a consistent HTML structure across all sites with reliable fingerprints for detection. Key findings from analyzing multiple live Weebly sites:

**Detection signals:**
- URL pattern: `weebly.com` subdomains
- CDN: All Weebly sites load assets from `editmysite.com` (cdn1/cdn2)
- HTML markers: `wsite-` class prefix on all structural elements, `_W.configDomain` JS variable referencing `weebly.com`

**Content structure:**
- Main content container: `#wsite-content`
- Navigation: `li.wsite-menu-item-wrap > a.wsite-menu-item` with flyout submenus in `.wsite-menu-wrap`
- Blog posts: Minimal semantic markup — titles in `<h2>` with anchor links, dates as plain text in MM/DD/YYYY format, categories linked via `/blog/category/slug`
- Products: `.wsite-product` with commerce backed by Square (Weebly's parent company)
- No JSON-LD or structured data on any tested sites

**Sitemaps:** Standard XML sitemaps available at `/sitemap.xml` with pages, blog posts, products, and category pages.

### How it works

The adapter follows the same fetch-and-scrape pattern as the Webflow adapter:
1. `detect()` matches `weebly.com` in the URL
2. `discover()` fetches the homepage HTML + sitemap, extracts navigation from the `wsite-menu` structure, and classifies URLs (with special handling for `/blog/` paths as posts)
3. `extract()` uses `runExtractionLoop()` with a Weebly-specific `extractPage` function that pulls content from `#wsite-content`, media from `editmysite.com`/`weeblycloud.com` CDN URLs, and blog metadata from category links and date text

Platform detection in `detect-platform.ts` uses two source signals: `editmysite.com` in page source (high confidence) and `wsite-` class markers or `_W.configDomain` variable (medium confidence). Custom domain sites without `weebly.com` in the URL are detected via these HTTP fingerprints.

### Why it's better than the previous approach

Weebly was not previously supported. This adds the fifth platform adapter, covering another significant website builder with a large install base of small business sites.

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
