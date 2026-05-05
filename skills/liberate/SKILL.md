---
name: liberate
description: Extract content from a closed web platform (GoDaddy Websites & Marketing, Hostinger, HubSpot, Shopify, Squarespace, Webflow, Weebly, Wix) into a WordPress-compatible WXR file
---

# Liberate a website

Help the user extract their content from a closed web platform.

## Workflow

1. Ask for the URL of the site to liberate (if not already provided)
2. Call `liberate_detect` to identify the platform
3. Call `liberate_discover` to inventory the site — show the counts and **platform features** to the user
   - Discovery now returns `platformFeatures` — flags for stores, bookings, forms, members areas, scheduling, forums, and events
   - Tell the user which features were detected and whether they transfer automatically
   - Features marked `transferable: true` (like stores) are handled during extraction
   - Features marked `transferable: false` include a `wpRecommendation` with a suggested WordPress plugin
4. Confirm with the user before proceeding
5. Call `liberate_extract` with an appropriate outputDir
6. Call `liberate_verify` on the outputDir to check the extraction quality — report stale CDN URLs, failed pages, failed media, and quality scores
7. If there are failures, offer to retry specific URLs or investigate
8. When the user is ready to import:
   - If the environment provides its own import mechanism (e.g. `import-liberated-data` skill, or `wp_cli` tool): call `liberate_setup` with `delegate: true`, then call `liberate_import` with `delegate: true` to get a structured import manifest. Hand off to the environment's import skill/tool.
   - Otherwise: call `liberate_setup` with site/username/token to validate the REST API connection, then call `liberate_import` with REST API credentials

## Resuming

If the user asks to resume a previous extraction (e.g. "resume", "continue where I left off", "it crashed"):

1. Ask for the URL (if not provided) — the outputDir is derived from the URL
2. Call `liberate_extract` with `resume: true` — this skips already-processed URLs
3. If the extraction was already complete (`.discovery-complete` exists), skip straight to reporting results and offer to import

The `resume` flag causes the extraction to:
- Skip platform detection and discovery if a completed WXR already exists
- Skip URLs that were already successfully processed (tracked in `extraction-log.jsonl`)
- Rebuild media dedup hashes from existing files to avoid re-downloading
- Append to the existing WXR rather than starting fresh

## Products

Any platform may have e-commerce products. When products are detected during extraction:

- Products are streamed to `products.jsonl` during extraction, then compiled into `products.csv` (WooCommerce import format) alongside the WXR
- Report the product count to the user: "Also extracted N products → products.csv"
- The CSV is ready for WooCommerce import via Products → Import in WP admin

## Discoveries

If you encounter something notable during extraction — a new API endpoint, a platform quirk, a workaround for blocked content, a better extraction technique — add an entry to `DISCOVERIES.md` at the top of the repo. Follow the format in the existing entries. This is how the tool gets smarter over time.

## Verification

After extraction completes, always run `liberate_verify` on the output directory. This checks:
- Stale CDN URLs still embedded in content (Shopify, Squarespace, Webflow, Wix CDN domains)
- Failed page extractions and failed media downloads
- Quality score breakdown (high/medium/low)
- Media files on disk vs media attachments in the WXR
- Redirect map completeness

Show the user the verification report and flag anything that needs attention before importing.

## WordPress Import

If the environment provides an import skill (e.g. `import-liberated-data` in WordPress Studio), use `delegate: true` with both `liberate_setup` and `liberate_import`. The setup call returns requirements, the import call returns a structured manifest with file paths. Hand off to the environment's import skill to execute the actual import.

If no environment import skill is available, use the built-in REST API import. Validate the WordPress connection with `liberate_setup` first:
- Checks site reachability, REST API availability, and authentication
- Returns step-by-step guidance if anything fails (e.g. how to create an Application Password)
- Once setup passes, ask the user about author handling before calling `liberate_import`

**Ask the user about authors:**
- "Would you like to import the original content authors as WordPress users, or assign all content to your account?"
- If they want authors: pass `importAuthors: true` to `liberate_import` — this creates WordPress user accounts for each author found in the WXR and assigns posts to them
- If they want everything under their account: pass `importAuthors: false` (default) — all content is owned by the authenticated user

If the user doesn't have a WordPress site yet, guide them:
1. Create a WordPress site (wordpress.com, self-hosted, or WordPress Studio for local development)
2. Generate an Application Password (WordPress Admin > Users > Profile > Application Passwords). On WordPress.com / wpcomstaging.com sites, generate it from the site's own wp-admin — the account-level one at wordpress.com/me/security/application-passwords only works for the WordPress.com public API, not the site-native /wp-json/wp/v2/ endpoint we use.
3. Run `liberate_setup` to validate the connection

## Platform-specific notes

### Squarespace

Squarespace sites benefit significantly from **admin extraction via CDP**. Without it, you only get public content — no drafts, no unlisted pages, and Squarespace 7.1 fluid engine sites often return empty content from the `?format=json` API.

**Guide the user through admin setup:**

1. Ask the user to launch Chrome with remote debugging:
   ```
   google-chrome --remote-debugging-port=9222
   ```
   (On macOS: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222`)
2. In that Chrome window, navigate to their Squarespace site and **log in to admin**
3. Once logged in, run extraction with `--cdp-port 9222` (CLI) or `cdpPort: 9222` (MCP)

The admin session gives the adapter access to:
- Squarespace's admin API responses (richer metadata, structured content)
- Draft and unlisted pages not visible publicly
- `__NEXT_DATA__` hydration payloads on 7.1 sites
- Automatic fallback to DOM extraction if JSON data is sparse

**Always offer CDP-based extraction for Squarespace.** Public-only extraction works but produces lower quality results.

### Wix

Extraction uses Playwright (headless browser) to intercept Wix's internal API calls and extract window globals. This is slower but captures content that isn't available via HTTP alone. Large sites may take several minutes.

### Webflow

Webflow requires a Webflow API token. Ask the user for their token and pass it via `--token` (CLI) or the `token` parameter (MCP).

### Shopify

Shopify has **two extraction tiers**. Always offer the richer one first and fall back only if the user can't produce an Admin API token.

**Tier 1 — Public JSON API (no credentials)**

Works for any public Shopify storefront. Pulls pages, blog posts, and products via the public `/pages.json`, `/blogs.json`, and `/products.json` endpoints plus HTML fallback for theme-rendered content. No token needed. Product data is limited to what the public API exposes — you lose compareAtPrice sale semantics, real stock policy, cost of goods, variant images, and collections.

**Tier 2 — Admin GraphQL (richer product data)**

When the user has admin access to their store, offer to use Shopify's Admin GraphQL API. This yields:
- `compareAtPrice` → proper sale/regular price mapping on simple + variable products
- `inventoryPolicy` + `inventoryItem.tracked` → real stock status (oversell-aware)
- `inventoryItem.unitCost` → cost of goods written to `meta:_wc_cog_cost`
- `inventoryItem.measurement.weight` → unit-normalized weight (kg)
- Variant-level images
- Collections → WooCommerce categories
- SEO metafields (`meta:_yoast_wpseo_title` / `_yoast_wpseo_metadesc`)
- Cursor-based pagination with mid-run resume

**Guide the user through admin setup:**

1. Direct them to Shopify Admin → **Settings → Apps and sales channels → Develop apps**.
2. Create a new custom app (name it "Data Liberation" or similar).
3. Under **Configuration → Admin API access scopes**, enable at minimum:
   - `read_products` (required)
   - `read_inventory` (for cost-of-goods + stock)
   - `read_online_store_pages` / `read_online_store_navigation` (for pages)
   - `read_content` (for blog articles)
4. Click **Install app** to generate the Admin API access token — copy it immediately, Shopify only shows it once.
5. Pass the token as `adminToken` (MCP) or via the adapter opts. **You do not need to ask the user for the shop domain** — `liberate_discover` auto-detects the `*.myshopify.com` hostname from the storefront HTML (`Shopify.shop` JS global) and stores it as `inventory.shopDomain`, even for sites served on custom domains.

**When to use which tier:**
- User has a Shopify login and some admin comfort → **prompt for Tier 2** and walk them through the custom app flow above
- User just wants "get my stuff out" and doesn't want to touch admin → **Tier 1 is fine** but tell them upfront what they'll lose (sale pricing, cost of goods, richer categories)
- User has a custom storefront domain (e.g. `shop.brand.com`) → Tier 2 still works because of auto-detection; do NOT ask them for the myshopify.com subdomain manually unless the detector failed

**If `liberate_discover` did not populate `inventory.shopDomain`** (rare — the site may be behind Cloudflare or heavy bot protection that blocks HTML fetch), ask the user directly:
"I couldn't auto-detect the myshopify.com subdomain. Can you paste the URL you see when you log into your Shopify admin? It looks like `https://admin.shopify.com/store/<name>` — the `<name>` is what I need."

Pass the admin-resolved value as `shopDomain` alongside `adminToken`.

**GraphQL failures fall back to Tier 1 automatically** — if the token is wrong or the scopes are insufficient, the adapter logs a warning and continues with the public JSON path, so the user's extraction still produces output.

### GoDaddy Websites & Marketing

Public-crawl adapter for GoDaddy's **legacy** Websites & Marketing platform (also called "Go Daddy Website Builder" in page sources). Not to be confused with the newer Airo AI Builder.

GoDaddy offers **no data export** from W+M — this adapter rescues content by crawling the public site. Detection looks for the `Go Daddy Website Builder` generator meta tag, the `img1.wsimg.com/isteam/` CDN pattern, and the `X-SiteId` header.

Discovery fetches the three standard W+M sub-sitemaps individually so blog posts can be tagged precisely (W+M's `/news,-updates/f/<slug>` URL shape doesn't match the generic classifier):
- `sitemap.website.xml` — pages
- `sitemap.blog.xml` — blog posts
- `sitemap.ols.xml` — products (**v1.1**, not yet implemented)

**Blog post bodies are hydrated client-side from a `window._BLOG_DATA` JSON blob.** The adapter parses this blob and converts the Draft.js ContentState (`post.fullContent`) into HTML — preserving paragraphs, headings, lists, blockquotes, code blocks, links, and images. Title, publish date, categories, and featured image are also pulled from `_BLOG_DATA` rather than HTML meta tags (higher fidelity).

Pages use DOM-based extraction: strip `HEADER_SECTION`, `FOOTER_*`, cookie banners, and the first-section title/image widgets (`*_SECTION_TITLE_RENDERED`, `*_IMAGE_RENDERED0`) which would otherwise duplicate the `<wp:post_title>` and media attachment.

**v1 limitations:** No GoDaddy Online Store (OLS) product extraction yet — sites with a store are flagged, but products need a real store URL for testing before v1.1 ships.

## General notes

- The extraction produces a WXR file (WordPress import format) + a media directory + a redirect map
- If the site has products, a `products.csv` (WooCommerce format) and `products.jsonl` are also produced
- All content is imported as drafts — the user reviews and publishes manually
