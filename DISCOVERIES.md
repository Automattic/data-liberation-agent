# Discoveries

A living log of findings from real migrations. Newest entries at the top.

AI agents: when you contribute an improvement, add an entry here. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the required format.

---

## 2026-04-03 — Instagram data extraction via CDP and GraphQL interception

**Found by:** Claude + human contributor (live testing against a real 308-post Instagram profile)
**During:** Building Instagram support for the data-liberation-agent
**Type:** API endpoint | content type | architecture

### What I found

Instagram is a React app that communicates with its backend via GraphQL queries to `https://www.instagram.com/graphql/query/`. By connecting to an authenticated browser session via CDP and intercepting these responses during profile scroll, we can capture the full structured JSON for every post — including captions, timestamps, locations, tagged users, image URLs, and engagement counts.

**Key discoveries:**

1. **Two API response formats**: Instagram returns post data in two different shapes depending on the endpoint version. The legacy format uses `edge_owner_to_timeline_media` with `edges[].node` containing post data. The newer format uses `xdt_api__v1__feed__user_timeline_graphql_connection` with a different node structure (`code` instead of `shortcode`, `image_versions2` instead of `display_url`). Both must be handled.

2. **Carousel slide direct access via `?img_index=N`**: Individual carousel slides can be loaded by appending `?img_index=1`, `?img_index=2`, etc. to the post URL (`/p/SHORTCODE/?img_index=N`). This is significantly more reliable than clicking through carousel arrows in the DOM, which requires finding the Next button (located outside the `article` element) and diffing image sets between clicks.

3. **Scroll-based pagination is more reliable than direct GraphQL**: While Instagram exposes cursor-based pagination via `page_info.end_cursor`, making direct `fetch()` calls to the GraphQL endpoint from `page.evaluate()` triggers rate limiting (returns HTML challenge pages instead of JSON). Scrolling the profile page with 2-3 second delays lets Instagram's own IntersectionObserver trigger pagination naturally, and we capture the responses via the existing response interceptor.

4. **Image CDN URLs expire**: Instagram CDN URLs (`scontent-*.cdninstagram.com`) are signed and time-limited. Media must be downloaded during or immediately after extraction — storing URLs alone is not sufficient.

5. **User ID from profile page**: The user's numeric ID (needed for some API calls) is embedded in the GraphQL profile response as `userData.id` or `userData.pk`. It can also be found in page source via `"profilePage_(\d+)"` or in the `al:android:url` meta tag.

### How it works

The extraction follows the same three-step pattern as Wix:

1. **Discover** (`scripts/instagram/discover.js`): Connects via CDP, navigates to the profile page, registers a `page.on('response')` handler that captures all GraphQL JSON responses. Scrolls to trigger pagination. Outputs `inventory.json` with full post manifest.

2. **Extract** (`scripts/instagram/extract.js`): For each post in the inventory, navigates to `/p/SHORTCODE/`. For carousels, iterates through `/p/SHORTCODE/?img_index=1` through `?img_index=N` to capture each slide's full-resolution image. Downloads all media files locally.

3. **Import** (`scripts/import.js`): The existing import script now detects Instagram data and generates WordPress block markup — `wp:image` blocks for photos, `wp:video` for videos, `wp:paragraph` for captions with @mentions and #hashtags converted to links. Supports `--post-type` flag for custom post types.

### Why it's better than the previous approach

Instagram offers a built-in data export (Settings → Your Activity → Download Your Information), but it has significant limitations:
- Takes 1-3 days to generate
- Provides lower-resolution images
- Exports messy JSON with inconsistent encoding
- No location data or tagged user details
- No engagement metrics

The CDP approach captures everything in real-time at full resolution, with complete metadata, and outputs structured JSON ready for WordPress import.

---

## 2026-04-03 — Chrome CDP port binding on macOS requires separate user-data-dir

**Found by:** Claude + human contributor (debugging during Instagram development)
**During:** Attempting to launch Chrome with `--remote-debugging-port=9222`
**Type:** bug fix

### What I found

On macOS, Chrome silently ignores the `--remote-debugging-port` flag if any Chrome processes are already running. Even after quitting Chrome via `Cmd+Q` or `osascript`, helper processes can persist and prevent the flag from taking effect. The `open -a "Google Chrome" --args --remote-debugging-port=9222` approach also fails silently.

The reliable solution is:
1. `pkill -9 -f "Google Chrome"` to kill all processes
2. Wait 2-3 seconds for cleanup
3. Launch with a separate `--user-data-dir` that symlinks to the real profile's `Default/` and `Local State` directories

This preserves the user's cookies and login sessions while avoiding profile lock conflicts. The repo's `cli.js` already implements this pattern.

### How it works

```bash
CDP_DIR="$HOME/.data-liberation/cdp-profile/chrome"
mkdir -p "$CDP_DIR"
ln -sf "$HOME/Library/Application Support/Google/Chrome/Default" "$CDP_DIR/Default"
ln -sf "$HOME/Library/Application Support/Google/Chrome/Local State" "$CDP_DIR/Local State"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$CDP_DIR" \
  --restore-last-session
```

### Why it's better than the previous approach

Without this, users would need to manually quit Chrome and know about the profile locking issue. The symlink approach means they don't lose their tabs, bookmarks, or login sessions — the CDP-enabled Chrome instance behaves identically to their normal browser.

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
