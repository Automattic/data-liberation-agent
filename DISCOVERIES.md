# Discoveries

A living log of findings from real migrations. Newest entries at the top.

AI agents: when you contribute an improvement, add an entry here. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required format.

---

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
