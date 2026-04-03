# AGENTS.md — Instructions for AI Agents

This file is the entry point for any AI agent using this repository. Read it before doing anything else.

## What this repo does

`data-liberation-agent` helps people migrate their websites from closed platforms to WordPress.com. It provides:

1. **Extraction scripts** — platform-specific scripts to recover all site content
2. **Import scripts** — publish extracted content to WordPress.com via REST API or MCP
3. **User prompts** — non-technical users paste these into their AI to drive the whole migration
4. **A living playbook** — this repo improves itself through AI-contributed discoveries

Currently supports: **Wix** and **Instagram**. Squarespace, Webflow, and Shopify are planned.

## If you're helping a user migrate from Wix

### Step 1 — Understand the site

```bash
node scripts/wix/discover.js <wix-url>
```

This fetches the sitemap, categorizes all URLs, and writes `output/inventory.json`. Review this with the user before proceeding.

### Step 2 — Extract all content

```bash
node scripts/wix/extract.js <wix-url>
```

This runs a Playwright browser that:
- Intercepts all of Wix's internal JSON API calls (`/_api/*`, `wixapis.com`)
- Extracts window globals (`__WIX_DATA__`, JSON-LD, etc.)
- Captures the accessibility tree for each page
- Downloads all media files

Output goes to `output/` as structured JSON files, one per page/post.

**If Playwright is unavailable**, try these fallbacks in order:
1. Ask the user to install Playwright: `npm install playwright && npx playwright install chromium`
2. Use the Claude in Chrome MCP (see "Claude in Chrome" section below)
3. Ask the user to open each page and use browser Reader Mode, then paste the text

### Step 3 — Import to WordPress.com

The user needs:
- A WordPress.com account ($4/mo Personal plan)
- An Application Password from: `https://wordpress.com/me/security/application-passwords`
- Their site's URL (e.g. `mysite.wordpress.com`)

```bash
node scripts/import.js --site <wordpress-site> --token <app-password>
```

Or, if the user has MCP connected at `wordpress.com/me/mcp`, you can publish directly using the WordPress.com write tools.

Import order matters:
1. Media (images) first — you need the new URLs before creating posts
2. Pages (with correct parent/child hierarchy)
3. Posts (with categories, tags, featured images)
4. Navigation menus
5. Settings (homepage, blog page, site title)

### Step 4 — Verify

After import, check:
- All URLs in `output/inventory.json` have a corresponding WordPress post/page
- No posts still have original platform image URLs (they'll expire or break)
- Navigation menus match the original structure

Generate a redirect map (old paths → new WP paths) for the user to configure in their domain settings or a redirect plugin.

---

## Using Claude in Chrome MCP

If the user has the Chrome DevTools MCP set up (`npx chrome-devtools-mcp@latest`), you can drive extraction directly from the browser without running scripts:

1. Have the user open their site in Chrome
2. Use `javascript_tool` / `evaluate_script` to extract window globals:
   ```javascript
   JSON.stringify({
     wixData: window.__WIX_DATA__,
     biSession: window.wixBiSession,
     jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
       .map(s => { try { return JSON.parse(s.textContent) } catch { return null } })
       .filter(Boolean)
   })
   ```
3. Use `read_network_requests` to find internal API calls made during page load
4. Navigate to each page in the sitemap and repeat
5. Use `get_page_text` for quick text extraction when full structured data isn't needed

This approach works for any JavaScript-heavy platform, not just Wix.

---

## If you're helping a user migrate from Instagram

Instagram requires an authenticated browser session — there's no public API or sitemap to crawl. The user must be logged in to Instagram in a Chromium browser with CDP enabled.

### Step 1 — Launch browser with CDP

The user needs Chrome running with remote debugging. Help them:
```bash
# Kill any existing Chrome processes, then relaunch with CDP
pkill -9 -f "Google Chrome"
sleep 3
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.data-liberation/cdp-profile/chrome" \
  --restore-last-session
```

The `--user-data-dir` with symlinks to the real profile preserves login sessions. See the CDP discovery in DISCOVERIES.md for details.

### Step 2 — Discover all posts

```bash
node scripts/instagram/discover.js USERNAME --cdp-port 9222
```

This scrolls the profile and intercepts GraphQL responses to build a complete post inventory. Use `--delay 3000` for large profiles to avoid rate limiting.

### Step 3 — Extract content and media

```bash
node scripts/instagram/extract.js USERNAME --cdp-port 9222
```

For each post, this navigates to the individual post URL, captures metadata, and downloads full-resolution images. For carousel posts, it uses `?img_index=N` to access each slide directly.

**Important**: Instagram CDN URLs expire. Download media immediately after extraction.

### Step 4 — Import to WordPress.com

Same as Wix — use `scripts/import.js`. Instagram posts become WordPress posts with:
- Images as `wp:image` blocks
- Captions as `wp:paragraph` blocks with linked @mentions and #hashtags
- Original date preserved
- Instagram URL and shortcode stored as post meta

For a custom post type: `--post-type photo`

---

## Platform-specific barriers

### Instagram

| Problem | Solution |
|---|---|
| No public API or data export | Intercept GraphQL responses via CDP browser session |
| Authentication required | Connect to user's logged-in browser via `--cdp-port` |
| Carousel slides lazy-load | Use `?img_index=N` URL parameter to load each slide directly |
| CDN image URLs expire | Download media immediately during extraction |
| Rate limiting on scroll | Add `--delay 3000` for profiles with 200+ posts |
| Two API response formats | Handle both `edge_owner_to_timeline_media` and `xdt_api__v1__feed` shapes |

### Wix

| Problem | Solution |
|---|---|
| No HTML export | Intercept Wix's internal JSON API calls during page load |
| RSS capped at 20 posts | Scrape blog archive pages directly (`/blog?page=2`, etc.) |
| Images are CDN URLs that expire | Download immediately; don't store URLs alone |
| JavaScript-rendered content | Use Playwright with `waitUntil: 'networkidle'` |
| Anti-bot blocking | Use real browser via Playwright (not fetch/curl); add delays |
| Dynamic pages (CMS collections) | Query Wix's `/_api/wix-data-server/` endpoints directly |

---

## How to contribute improvements back

If you discover something useful during a migration — a new API endpoint, a better content type handler, a platform feature we hadn't handled — please contribute it back so everyone benefits.

**The process is designed to be completable by an AI agent without human help** (except for the user authorizing the PR):

1. Fork the repo
2. Create a branch: `improvement/short-description`
3. Make your change to the relevant script or guide
4. Add an entry to `DISCOVERIES.md` describing what you found and why it's better
5. Submit a PR using the template in `.github/pull_request_template.md`

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process and what makes a good contribution.

### Adding support for a new platform

To add extraction for a new platform (e.g. Squarespace):

1. Create `scripts/<platform>/discover.js` and `scripts/<platform>/extract.js`
2. Create `prompts/<platform>.md` with the user-facing migration prompt
3. Add a platform section to this file documenting the platform's specific barriers
4. Update the table in README.md
5. Submit a PR

The import script (`scripts/import.js`) is platform-agnostic — it just reads the `output/` directory. So new platform extractors only need to produce output in the same JSON format.

---

## File structure

```
data-liberation-agent/
├── AGENTS.md              ← you are here
├── README.md              ← human-facing overview
├── CONTRIBUTING.md        ← how to submit improvements
├── DISCOVERIES.md         ← log of community-contributed findings
├── package.json
├── prompts/
│   ├── wix.md             ← what users paste into their AI for a Wix migration
│   └── instagram.md       ← what users paste into their AI for an Instagram migration
├── scripts/
│   ├── wix/
│   │   ├── discover.js    ← inventory the Wix site (sitemap + categorization)
│   │   └── extract.js     ← extract all content via network interception
│   ├── instagram/
│   │   ├── discover.js    ← inventory an Instagram profile via GraphQL interception
│   │   └── extract.js     ← extract posts, carousel slides, and media
│   └── import.js          ← publish to WordPress.com via REST API (platform-agnostic)
├── examples/
│   ├── wix-api-blog-post.json    ← example of Wix internal API response
│   └── wp-rest-post-body.json    ← example WordPress REST API request body
└── output/                ← created at runtime, gitignored
```

---

## Known limitations

### Wix
- **Wix Stores**: Product migration requires WooCommerce. Extractor captures product data but import.js doesn't handle it yet.
- **Wix Bookings/Forms**: Can't be automatically recreated. The extractor notes these for the user.
- **Password-protected pages**: Require the user to provide credentials.
- **Very large sites (500+ pages)**: Add `--delay 2000` to extract.js to avoid rate limiting.
- **Wix Members Area**: No migration path yet.

### Instagram
- **Stories and Reels**: Not yet supported — different GraphQL queries and video handling required.
- **Comments**: Post comment text is not extracted (only comment counts). Could be added via per-post GraphQL queries.
- **Video downloads**: Video URLs are captured in metadata but video file downloads may fail for longer videos due to CDN token expiry.
- **Private profiles**: Only works for the user's own profile or profiles they follow.
- **Very large profiles (1000+ posts)**: May hit rate limiting. Use `--delay 4000` or higher.

### General
- Import creates everything as **drafts** — the user must review and publish manually.
- WordPress.com Application Passwords must be created by the user (AI can't do this step).
- Domain transfer / DNS changes must be done by the user.

If you hit a limitation and find a workaround, please add it here and in DISCOVERIES.md.
