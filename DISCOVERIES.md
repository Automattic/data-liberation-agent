# Discoveries

A living log of findings from real migrations. Newest entries at the top.

AI agents: when you contribute an improvement, add an entry here. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required format.

---

## 2026-04-28 — Wix product pages expose stable `data-hook` selectors

**Found by:** Claude + human contributor
**During:** Migrating Wix Stores sites where JSON-LD was malformed or
missing AND the products API call hadn't been captured during navigation
**Type:** platform quirk | content type

### What I found
Wix product pages tag key elements with `data-hook="..."` attributes
that have been stable across every Wix Stores site we've tested. When
JSON-LD is missing or malformed *and* the products API call hasn't
been captured, the rendered DOM is still extractable via these hooks —
no need to give up on the product.

| Element | Selector |
|---|---|
| Product title | `[data-hook="product-title"]` |
| Product price (clean) | `[data-hook="formatted-primary-price"]` |
| Product price (wrapper, includes SR "Price") | `[data-hook="product-price"]` |
| Product gallery root | `[data-hook="product-gallery-root"]` |
| Main product image | `[data-hook="main-media-image-wrapper"] img` |
| Thumbnail images | `[data-hook="thumbnail-image"] img` |
| Product description | `[data-hook="product-description"]` |
| Product options | `[data-hook="product-options"]` |

The `[data-hook="product-price"]` wrapper contains a screen-reader span
(`[data-hook="sr-formatted-primary-price"]`) with the literal word
"Price" — use `[data-hook="formatted-primary-price"]` for the clean
value.

### How it works
Added a third fallback path in `extractWixProduct()` after the
JSON-LD and captured-API paths. When both upstream paths fail, parse
the rendered HTML using the hooks above. Required adding an optional
`pageHtml` field to `PageData` so the raw HTML (already captured for
media-URL extraction) is available to the product extractor.

### Why it's better than the previous approach
Before: `extractWixProduct()` returned `null` whenever JSON-LD was
missing AND the product API call wasn't captured (e.g. cached
navigation, slow hydration, throttled requests). After: name, price,
description, and gallery images recover from the rendered DOM —
typically the worst-case path that still yields a usable product
record.


## 2026-04-16 — Wix Tag Manager poisons content extraction

**Found by:** Claude + human contributor
**During:** Migrating a 45-page Wix ecommerce site (bestiehugs.com)
**Type:** bug fix

### What I found
Wix's Tag Manager API (`/_api/tag-manager/api/v1/tags/sites/...`) returns a field named `content` containing analytics `<script>` blocks. `deriveContent()` matches this first (key="content", >50 chars, contains "<"), returns qualityScore "high", and never consults the rendered DOM — which has the real page content in `[data-testid="richTextElement"]` elements. After `stripNonContentTags()` removes the script, the WXR gets empty `content:encoded`.

### How it works

Added a post-match validation step: after `findHtmlContent()` returns a match from an API call, strip `<script>` and `<style>` tags and verify >50 chars of real HTML remain. If not, skip and continue to the next content source (rendered DOM, JSON-LD, accessibility tree).

### Why it's better than the previous approach

Tested against 7 live Wix sites. 5 of 7 had tag-manager responses that triggered this bug, producing completely empty page content. After the fix, all 5 extract real content (424–5684 chars) from the rendered DOM. The 2 unaffected sites remain unchanged.


## 2026-04-17 — Wix blog URL classification: `/single-post/` and bare `/blog` listings

**Found by:** Claude + human contributor
**During:** Testing the Wix adapter against a range of live Wix sites
**Type:** bug fix

### What I found

Two separate URL-classification bugs in `classifyUrl()` in `src/lib/extraction/sitemap.ts`:

1. **Older Wix Blog format** uses `/single-post/<slug>` URLs (distinct from newer `/post/<slug>` or `/blog-1/post/<slug>` patterns the classifier already matched). One sizeable Wix blog encountered during testing had ~1000 blog posts at `/single-post/*` URLs; every single one was written to the WXR as `wp:post_type=page` — the whole blog archive landed in WordPress as pages.

2. **Bare `/blog`, `/news`, `/articles`** were classified as `post` because the regex `/\/(blog|post|posts|...)(\/|$)/` allowed end-of-string after the keyword. These URLs are the blog *listing* pages, not individual posts. They got written to WXR as authorless "posts" with titles like "Our blog" — polluting the post archive. Seen on multiple tested sites where the `/blog` URL was listed in both `pages-sitemap.xml` and `blog-categories-sitemap.xml`.

### How it works

Two changes to the classifier regex:

- Added `if (/\/single-post\//.test(path)) return 'post';` for the older Wix Blog URL pattern.
- Changed the main blog-keyword regex from `(\/|$)` to `\/[^/]` — require a non-slash character after the keyword's trailing slash. This means `/blog/my-post` still matches (post), but bare `/blog` and `/blog/` now fall through to the `page` default (listing page).

### Why it's better than the previous approach

Tested on the affected sites: blog archives now classify correctly (individual posts as `post`, bare `/blog` as `page`). The existing `classifies blog paths as post` test was updated to remove the now-wrong `/blog → post` expectation, and two unit tests were added covering both new patterns.

---

## 2026-04-16 — Wix Product JSON-LD uses non-standard casing

**Found by:** Claude + human contributor
**During:** Migrating a Wix ecommerce site (20 products)
**Type:** bug fix

### What I found
Wix emits Product JSON-LD with non-standard casing: `"Offers"` (uppercase O) instead of schema.org's `"offers"`, and `"Availability"` (uppercase A) instead of `"availability"`. Product images use `"contentUrl"` (per schema.org ImageObject spec) but the adapter only checked for `"url"`. Result: all product prices, images, and stock status were silently lost.

### How it works

Changed `extractWixProduct()` to check both cases for offers (`obj.offers || obj.Offers`) and availability (`offer.availability || offer.Availability`), and to accept both `url` and `contentUrl` for image objects.

### Why it's better than the previous approach

Tested against 2 live Wix Stores. Before: price="" and images=0 on every product. After: site recovers price=200 (ILS) and 5 images; site recovers price=1295 (GBP) and 11 images. Stock status also corrected (hoodie correctly shows OutOfStock).

## 2026-04-16 — Wix /product-page/ URLs misclassified as pages

**Found by:** Claude + human contributor
**During:** Migrating a Wix ecommerce site 
**Type:** bug fix

### What I found

Wix uses `/product-page/<slug>` URLs for store products. `classifyUrl()` only matched `/(products?|store|shop)/`, so product pages were classified as regular pages. This caused them to be added to the WXR as empty page items in addition to the products.csv, cluttering the WordPress Pages list on import.

### How it works

Added `product-page` to the product URL regex in `classifyUrl()`. The Wix adapter already had its own `/product-page/` check for CSV routing, but the shared URL classifier needed it too so the extraction loop skips adding products as WXR pages.

### Why it's better than the previous approach

Product pages are now correctly routed to WooCommerce CSV only, not duplicated as empty WordPress pages. No regressions on other URL patterns (blog, shop, product, gallery, event, homepage all unchanged).

## 2026-04-13 — GoDaddy Websites & Marketing hydrates blog bodies from `window._BLOG_DATA` (Draft.js)

**Found by:** Claude + Matt (adding the `godaddy-wm` adapter against cruisewarehouse.com and skywaydiner.com)
**During:** Building the GoDaddy W+M adapter for lonestardomains' 300-post blog migration
**Type:** platform architecture | content format

### What I found

GoDaddy's legacy Websites & Marketing platform (aka "Go Daddy Website Builder", the pre-Airo builder) renders blog post **pages** as static HTML, but the post body itself is **not** in the rendered DOM. Meta tags (`og:*`, `<title>`), navigation chrome, and header/footer are server-rendered normally — but the actual post content lives inside a `window._BLOG_DATA={...}` JSON blob embedded in a `<script>` tag near the end of the document, and hydrates client-side.

The blob shape:

```js
window._BLOG_DATA = {
  head: { title, meta: [{type, key, value}, ...] },
  post: {
    blogId, postId,
    title, slug,
    date, publishedDate,
    content,          // truncated plain-text excerpt (~200 chars, ends in "...")
    fullContent,      // JSON-encoded Draft.js ContentState — THE REAL POST BODY
    featuredImage,    // full-resolution img1.wsimg.com URL
    categories: ["Category A", ...],
    hideCommenting, featureFlags, socialSharing
  }
}
```

`post.fullContent` is a **Draft.js** ContentState (`{blocks: [...], entityMap: {...}}`). Blocks use the standard Draft.js types: `unstyled`, `header-one` through `header-six`, `unordered-list-item`, `ordered-list-item`, `blockquote`, `code-block`, and `atomic` (used for images via an `IMAGE` entity). Inline styles (`BOLD`, `ITALIC`, `UNDERLINE`, `STRIKETHROUGH`, `CODE`) and entity ranges (`LINK`, `IMAGE`) are standard Draft.js.

**Pages** (non-blog-post URLs) behave differently — they're fully server-rendered into the DOM, no JSON blob. Section titles and hero images are tagged with stable `data-aid` attributes like `ABOUT_SECTION_TITLE_RENDERED` and `ABOUT_IMAGE_RENDERED0`, so page extraction can strip them reliably.

### How the adapter uses this

The `godaddy-wm` adapter detects `_BLOG_DATA` at the start of `extractPage`. If present, it:

1. Parses the JSON blob
2. Parses `post.fullContent` as Draft.js ContentState
3. Drops the first block if it's an atomic image matching `post.featuredImage` (otherwise the body would lead with the same image that's already captured via mediaUrls)
4. Converts blocks to HTML: `unstyled` → `<p>`, `header-N` → `<h1..6>`, list items wrapped in `<ul>`/`<ol>`, atomic IMAGEs → `<figure><img/></figure>`, plus inline style and LINK entity application
5. Uses `post.title`, `post.publishedDate`, `post.categories`, and `post.featuredImage` as the canonical source of truth (all higher-fidelity than scraping HTML meta tags)

See `src/adapters/godaddy-wm.ts` — `draftToHtml()`, `parseBlogData()`, and the blog-post branch of `extractPage`.

### Gotchas

- **`post.content` is a truncated excerpt**, not the real body. It's the first ~200 characters of `fullContent` with a trailing `...`. Don't use it as post content — use `fullContent` and convert. Do use a cleaned version of `content` as the excerpt / `seoDescription`.
- **The first Draft.js block is almost always an atomic image of the featured image.** If you also add `post.featuredImage` to `mediaUrls` (you should, for attachment tracking), dedupe by dropping the Draft.js block.
- **`classifyUrl` doesn't recognize W+M's blog URL shape.** Blog posts live at `/<section-slug>/f/<post-slug>` (e.g. `/news%2C-updates-and-reviews/f/do-people-steal-your-towel`). That path doesn't match the generic `/blog/`, `/post/`, `/news/` regex. The adapter works around this by fetching `sitemap.blog.xml` and `sitemap.website.xml` individually in `discoverWmUrls` and tagging URLs by source sitemap rather than relying on `classifyUrl`.
- **The sitemap index always lists `sitemap.ols.xml`** (GoDaddy Online Store) even on sites without a store. Don't trust the index — fetch the sub-sitemap and check for a 404.
- **Detection fingerprints:** `<meta name="generator" content="...Go Daddy Website Builder...">` in page source is the strongest signal. Also `img1.wsimg.com/isteam/` CDN pattern in source and `X-SiteId` / `dps_site_id` cookie from GoDaddy's DPS infrastructure. Custom domains mean URL-based detection is useless.

### Media fidelity: the isteam CDN URL upgrade trick

W+M's `img1.wsimg.com/isteam` CDN encodes image transforms directly in the URL path after a `/:/` segment marker — e.g. `/isteam/ip/<uuid>/<filename>.jpg/:/rs=w:370,cg:true,m`. The `rs=` specifies resize, `cr=` crop, `cg:true` preserves aspect. Extracting images straight from the live DOM gives you whatever small variant was rendered on the page (usually 370–1200px wide).

**Stripping the `/:/<transforms>` suffix does NOT give you the original.** `https://img1.wsimg.com/isteam/ip/<uuid>/<filename>.jpg` returns a default ~600px thumbnail. The CDN has no "no transform = original" mode.

**What works:** append `/:/rs=w:4000,cg:true`. The CDN caps at 3840px wide (more specifically, 3840×3840 for square-cropped stock images, 3840×<aspect-preserved-height> for user-uploaded images). Requesting larger widths still returns 3840. Dropping `cg:true` caps at 1732. Without any transform you get ~600px. So `rs=w:4000,cg:true` is the universal "give me the biggest thing you've got" form.

For a real user-uploaded image: without transform → 45KB / 602×345; with `rs=w:4000,cg:true` → 500KB / 3840×2201. ~10× the file size, ~6× the linear resolution.

**Two places this must be applied consistently** — the WP importer rewrites media URLs via exact string match, so the `<img src>` that ends up in post/page body HTML must equal the URL stored on the media attachment. Rewrite at *both* the adapter's `mediaUrls` collection *and* wherever body HTML is generated (Draft.js atomic block renderer + cheerio `img[src]`/`source` rewriter for pages).

**Responsive `srcset` is unsalvageable by parsing.** W+M emits `<picture><source srcset="...1x, ...2x, ...3x"><img src>...</picture>` where the URLs inside `srcset` contain their own commas (from crop params like `cr=t:12.53%25,l:0%25,w:100%25,h:74.93%25`). A naive comma-split corrupts the URLs. Rather than write a URL-aware srcset parser, the adapter **drops `srcset` and `data-srcsetlazy` entirely** and promotes the lazy URL into `src`. WordPress regenerates its own srcset from the uploaded media on import, so nothing is lost — the body still displays at the right size, it just lets WP control the variants.

**The shared media downloader also needed a fix.** It derives the local filename via `basename(urlObj.pathname)` — fine for ordinary URLs, but broken for URLs with `/:/` transforms because the last path segment becomes the transform spec itself (e.g. a file literally named `rs=w:4000,cg:true`). `src/lib/extraction/media.ts` now looks for the `/:/` marker and uses the segment before it as the filename source, falling back to a content-type-derived extension when the derived name has none (e.g. `/isteam/getty/1142417322` → filename `1142417322.jpg`).

### v1.1 follow-ups

- **OLS product extraction** — W+M sites with a GoDaddy Online Store surface products via `sitemap.ols.xml`. Not yet implemented because neither test site (cruisewarehouse.com, skywaydiner.com) actually has a store despite advertising the sub-sitemap.
- **Authenticated fidelity mode** — a Playwright-based variant that uses a user-provided `dashboard.godaddy.com/websites` session to intercept W+M's internal JSON APIs could rescue draft posts, accurate publish dates, and original-resolution media. Only worth building if scraped fidelity turns out to be insufficient.

---

## 2026-04-13 — HubSpot CMS platform adapter

**Found by:** Claude + human contributor
**During:** Adding HubSpot CMS as a new supported platform
**Type:** platform adapter

### What I found

HubSpot CMS Hub powers a wide range of sites from SMB marketing pages to enterprise content hubs. Sites run on custom domains and use a well-structured class naming convention that makes detection and extraction straightforward once you know the patterns.

**Detection signals:**
- `<meta name="generator" content="HubSpot">` is the only reliable signal. Many non-HubSpot sites embed HubSpot marketing scripts (CTAs, forms, tracking), so `hubspot.com`, `hs-scripts.com`, and `hsforms.net` references in page source are NOT sufficient. For example, eplan.co.za has all the HubSpot scripts but its generator tag says TYPO3 — it's a TYPO3 site using HubSpot for marketing.

**Content structure:**
- `<body>` class identifies content type:
  - `hs-blog-post` on blog post pages (authoritative — used for classification)
  - `hs-site-page page` on regular pages
- Blog post content: `div.post-body` (clean article body)
- Regular pages: `div.body-container` (strip nav/header/footer)
- Content modules wrap in `div.hs_cos_wrapper` with `_type_rich_text`, `_type_form`, `_type_cta`, etc.
- Marketing widgets to strip during extraction: `.hs-cta-wrapper`, `.hs-cta-node`, `hs_cos_wrapper_type_form`, `hs_cos_wrapper_type_blog_comments`, AddThis social widgets
- Blog titles render as `<h1>` inside content — strip to avoid duplication with `post_title`
- Navigation: `.hs-menu-wrapper` with `.hs-menu-item`, `.hs-menu-depth-*`

**Blog post metadata:**
- Date: byline text "by Author, on Dec 6, 2024 6:57:40 PM" (parsed by adapter), plus `article:published_time` meta tag fallback
- Author: `<a href="/*/author/{name}">{display name}</a>`
- Topics (tags): `<a href="/*/topic/{slug}">{display name}</a>` in post footer

**Media hosts:**
- `/hubfs/*` paths on the site itself (HubSpot's file manager)
- `hubspotusercontent-*.net` CDN (regional, e.g. `-na1`, `-eu1`)
- `fs1.hubspotusercontent-*.net` for files

**Sitemaps:** Standard `/sitemap.xml`, auto-generated, comprehensive. Includes image sitemap extensions with alt text.

### How it works

The adapter follows the established fetch-and-scrape pattern:
1. `detect()` is URL-less — relies on the Hubspot generator meta tag in `detect-platform.ts`
2. `discover()` fetches the homepage + sitemap, extracts site metadata from OG tags and `<html lang>`, classifies URLs (with common HubSpot blog paths like `/blog/`, `/news/`, `/insights/` treated as posts — individual pages are reclassified at extract time via body class)
3. `extract()` uses `runExtractionLoop()` with a HubSpot-specific `extractPage` that:
   - Reads the `<body>` class to classify post vs page (overrides URL-based classification via `detectedType`)
   - Extracts blog content from `.post-body`, page content from `.body-container` with chrome stripped
   - Strips HubSpot marketing widgets (CTAs, forms, comments, AddThis) from content
   - Parses date from byline text when `article:published_time` isn't present
   - Extracts author from `/author/` link text, topics (tags) from `/topic/` link text
   - Strips the embedded `<h1>` title to prevent duplication with `post_title`
   - Resolves relative URLs so WordPress can match attachment URLs during import

### Known limitations

Tags are extracted from topic links and returned as post tags, but they don't currently land as WordPress taxonomy terms on import. The WXR builder writes the taxonomy section at `openStream()` time, before posts are extracted, so late-registered `<wp:tag>` entries aren't persisted in streaming mode. This is a shared-code gap affecting all adapters that pass tag slugs directly through `addPost`. Topics still appear as inline linked text in imported post content.

### Why it's better than the previous approach

HubSpot CMS was not previously supported. Adds coverage for a widely-deployed CMS used by large enterprises (Avast, FlightAware, Wattpad, HubSpot itself) and many mid-market companies. Tested end-to-end against eflexsystems.com (156 URLs: 32 pages, 124 posts, 930 media references) and maus.com (185 URLs). The 124 blog posts imported into WordPress with correct titles, dates, authors, and clean content bodies; title duplication avoided.

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
