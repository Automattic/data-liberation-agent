# AGENTS.md — Instructions for AI Agents

This file is the entry point for any AI agent using this repository. Read it before doing anything else.

## What this repo does

`wix-escape` helps people migrate their websites from Wix to WordPress.com. It provides:

1. **Extraction scripts** — bypass Wix's content barriers to recover all site content
2. **Import scripts** — publish extracted content to WordPress.com via REST API or MCP
3. **A user prompt** — non-technical users paste this into their AI to drive the whole migration
4. **A living playbook** — this repo improves itself through AI-contributed discoveries

## If you're helping a user migrate their site

### Step 1 — Understand the site

```bash
node scripts/discover.js <wix-url>
```

This fetches the sitemap, categorizes all URLs, and writes `output/inventory.json`. Review this with the user before proceeding.

### Step 2 — Extract all content

```bash
node scripts/extract.js <wix-url>
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
- No posts still have `wix.com` image URLs (they'll expire)
- Navigation menus match the original structure

Generate a redirect map (old Wix paths → new WP paths) for the user to configure in their domain settings or a redirect plugin.

---

## Using Claude in Chrome MCP

If the user has the Chrome DevTools MCP set up (`npx chrome-devtools-mcp@latest`), you can drive extraction directly from the browser without running scripts:

1. Have the user open their Wix site in Chrome
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
3. Use `read_network_requests` to find Wix API calls made during page load
4. Navigate to each page in the sitemap and repeat
5. Use `get_page_text` for quick text extraction when full structured data isn't needed

---

## What Wix makes hard (and how to handle it)

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

If you discover something useful during a migration — a new API endpoint, a better content type handler, a Wix feature we hadn't handled — please contribute it back so everyone benefits.

**The process is designed to be completable by an AI agent without human help** (except for the user authorizing the PR):

1. Fork the repo
2. Create a branch: `improvement/short-description`
3. Make your change to the relevant script or guide
4. Add an entry to `DISCOVERIES.md` describing what you found and why it's better
5. Submit a PR using the template in `.github/pull_request_template.md`

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process and what makes a good contribution.

---

## File structure

```
wix-escape/
├── AGENTS.md              ← you are here
├── README.md              ← human-facing overview
├── CONTRIBUTING.md        ← how to submit improvements
├── DISCOVERIES.md         ← log of community-contributed findings
├── prompt.md              ← what users paste into their AI to start a migration
├── package.json
├── scripts/
│   ├── discover.js        ← step 1: inventory the Wix site (sitemap + categorization)
│   ├── extract.js         ← step 2: extract all content via network interception
│   └── import.js          ← step 3: publish to WordPress.com via REST API
├── examples/
│   ├── wix-api-blog-post.json    ← example of Wix internal API response for a blog post
│   └── wp-rest-post-body.json    ← example WordPress REST API request body
└── output/                ← created at runtime, gitignored
```

---

## Known limitations

- **Wix Stores**: Product migration requires a separate WooCommerce import. The extractor captures product data but import.js doesn't handle it yet — see issue #TODO.
- **Wix Bookings/Forms**: Can't be automatically recreated. The extractor notes these for the user.
- **Password-protected pages**: Require the user to provide credentials.
- **Very large sites (500+ pages)**: Add `--delay 2000` to extract.js to avoid rate limiting.
- **Wix Members Area**: No migration path yet.

If you hit a limitation and find a workaround, please add it here and in DISCOVERIES.md.
