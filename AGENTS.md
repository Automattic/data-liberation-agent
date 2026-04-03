# AGENTS.md — Instructions for AI Agents

This file is the entry point for any AI agent using this repository. Read it before doing anything else.

## What this repo does

`data-liberation-agent` helps people migrate their websites from closed platforms to WordPress.com. It provides:

1. **Extraction scripts** — platform-specific scripts to recover all site content
2. **Import scripts** — publish extracted content to WordPress.com via REST API or MCP
3. **User prompts** — non-technical users paste these into their AI to drive the whole migration
4. **A living playbook** — this repo improves itself through AI-contributed discoveries

Currently supports: **Wix** and **Substack**. Squarespace, Webflow, and Shopify are planned.

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

## If you're helping a user migrate from Substack

### Step 1 — Understand the publication

```bash
node scripts/substack/discover.js <substack-url>
```

This queries Substack's public API to list all posts, categorize them (free/paid/podcast), and writes `output/inventory.json`. No browser needed.

### Step 2 — Extract all content

```bash
node scripts/substack/extract.js <substack-url>
```

This fetches each post via the API. For **paid posts**, the API only returns the free preview. To get full paid content:

1. Ask the user to export from Substack: Settings > Exports > Create new export
2. They'll get a ZIP with a CSV file
3. Unzip it and pass the CSV:

```bash
node scripts/substack/extract.js <substack-url> --csv-export posts.csv
```

The extractor merges API metadata (rich) with CSV content (complete), giving you the best of both.

**If scripts aren't available**, you can extract directly:
1. Fetch the archive: `<substack-url>/api/v1/archive?sort=new&limit=50&offset=0`
2. For each post: `<substack-url>/api/v1/posts/<slug>` — returns full JSON with `body_html`
3. Download images by unwrapping CDN URLs: `substackcdn.com/image/fetch/.../https://substack-post-media.s3.amazonaws.com/...` — the real URL is embedded after the transform params

### Step 3 — Import to WordPress.com

Same as Wix — the import script is platform-agnostic:

```bash
node scripts/import.js --site <wordpress-site> --token <app-password>
```

### Step 4 — Handle Substack-specific concerns

After import, help the user with:
- **Subscribers**: Export from Substack (Settings > Exports), import into their email service or WordPress.com newsletter
- **Paid subscriptions**: Complex — involves Stripe migration. Discuss options before acting.
- **Redirects**: If they have a custom domain, set up redirects from `/p/<slug>` to new WordPress paths. If on `*.substack.com`, they can't redirect — suggest a pinned farewell post.
- **Podcast hosting**: Audio files need to be re-hosted if they have podcast episodes.

---

## Platform-specific barriers

### Wix

| Problem | Solution |
|---|---|
| No HTML export | Intercept Wix's internal JSON API calls during page load |
| RSS capped at 20 posts | Scrape blog archive pages directly (`/blog?page=2`, etc.) |
| Images are CDN URLs that expire | Download immediately; don't store URLs alone |
| JavaScript-rendered content | Use Playwright with `waitUntil: 'networkidle'` |
| Anti-bot blocking | Use real browser via Playwright (not fetch/curl); add delays |
| Dynamic pages (CMS collections) | Query Wix's `/_api/wix-data-server/` endpoints directly |

### Substack

| Problem | Solution |
|---|---|
| Paid content truncated in API | Use Substack's CSV export (`--csv-export`) for full body HTML |
| No official API | Undocumented `/api/v1/posts` and `/api/v1/archive` endpoints are public |
| Images behind CDN wrapper | Unwrap `substackcdn.com/image/fetch/.../` URLs to get original S3 paths |
| URL structure (`/p/slug`) | Generate redirect map; set WordPress permalinks to match if possible |
| Subtitles not in WordPress | Add as styled first paragraph or use a subtitle plugin |
| Subscriber migration | Separate CSV export; requires email service setup |
| Paid subscriber migration | Stripe account transfer needed; no automated path |
| Comments not exportable | Not included in any export; consider a scraping approach if critical |
| Notes/threads | Newer feature; may not export cleanly via API |

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
│   └── substack.md        ← what users paste into their AI for a Substack migration
├── scripts/
│   ├── wix/
│   │   ├── discover.js    ← inventory the Wix site (sitemap + categorization)
│   │   └── extract.js     ← extract all content via network interception
│   ├── substack/
│   │   ├── discover.js    ← inventory the Substack publication via API
│   │   └── extract.js     ← extract content via API + CSV export
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

### General
- Import creates everything as **drafts** — the user must review and publish manually.
- WordPress.com Application Passwords must be created by the user (AI can't do this step).
- Domain transfer / DNS changes must be done by the user.

If you hit a limitation and find a workaround, please add it here and in DISCOVERIES.md.
