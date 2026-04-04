# Squarespace to WordPress.com Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my website from Squarespace to WordPress.com. My Squarespace site URL is: **[PASTE YOUR SQUARESPACE URL HERE]**

I have (or will create) a WordPress.com account. Please help me migrate using the playbook at https://github.com/Automattic/data-liberation-agent — read AGENTS.md first for full instructions.

Here's what I need you to do:

## Step 1: Inventory my site

- First, help me launch Chrome with remote debugging (`google-chrome --remote-debugging-port=9222`) and log in to my Squarespace admin — the admin session gives access to drafts, unlisted pages, and richer metadata
- Run `node scripts/squarespace/discover.js [SQUARESPACE URL] --cdp-port 9222 --cdp-admin` to inventory all content via the admin dashboard
- Categorize each URL (page, blog post, product, gallery, portfolio, etc.)
- Note my navigation structure and menu items
- Flag any Squarespace-specific features (commerce, memberships, scheduling, forms) that won't transfer automatically — I need to know these upfront
- Show me the inventory and wait for my approval before proceeding

## Step 2: Extract all content

For each page and blog post:
- **Use the admin extraction approach** — run `node scripts/squarespace/extract.js [SQUARESPACE URL] --inventory output/inventory.json --cdp-port 9222 --cdp-admin` from the data-liberation-agent repo
  - This intercepts Squarespace's admin API calls and `__NEXT_DATA__` hydration to get structured content
  - It falls back to public DOM extraction automatically if admin data is sparse for a given page
  - It downloads all media from Squarespace's CDN
- For blog posts: extract the full archive, not just what's visible on the first page
- Download every image — don't just save the URL, the files need to actually be retrieved
- Preserve for each piece of content: title, URL slug, publish date, categories/tags, SEO title and description, featured image

## Step 3: Set up WordPress.com

I need to create/have a WordPress.com site. Help me:
- Recommend a theme that matches my current site's visual style
- Create all categories and tags from my Squarespace site
- Configure basic settings: site title, tagline, permalink structure

For connecting to WordPress.com, I need to generate an Application Password at wordpress.com/me/security/application-passwords.

Tell me when you need it.

## Step 4: Publish everything

Run `node scripts/squarespace/import.js --site [MY-SITE].wordpress.com --username [MY-USERNAME] --token [APP-PASSWORD]`

In this order:
1. Upload all images to the WordPress media library (Squarespace CDN URLs are rewritten to WordPress URLs)
2. Create all pages with correct parent/child relationships
3. Create all blog posts with correct dates, categories, tags, and featured images
4. Products are logged but skipped — WooCommerce migration is out of scope
5. Generate a redirect map (`output/redirect-map.json`)

## Step 5: Verify

When done:
- Give me a URL mapping table: old Squarespace URL → new WordPress URL (for setting up redirects)
- Flag any posts/pages that are missing or had import errors
- Check for any images still pointing to Squarespace CDN URLs
- List everything that needs manual attention (forms, commerce, memberships, scheduling) with your recommendation for what plugin to use

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step. If you hit something unexpected, tell me what you found rather than guessing.
