# Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my website from Wix to WordPress.com. My Wix site URL is: **[PASTE YOUR WIX URL HERE]**

I have (or will create) a WordPress.com account. Please help me migrate using the playbook at https://github.com/[REPO]/wix-escape — read AGENTS.md first for full instructions.

Here's what I need you to do:

## Step 1: Inventory my site

- Fetch my sitemap at [WIX URL]/sitemap.xml and list all pages, blog posts, and other content URLs
- Categorize each URL (static page, blog post, product, gallery, etc.)
- Note my navigation structure and menu items
- Flag any Wix-specific features (bookings, stores, forms, members area) that won't transfer automatically — I need to know these upfront
- Show me the inventory and wait for my approval before proceeding

## Step 2: Extract all content

For each page and blog post:
- **Don't try to scrape the rendered HTML** — instead, use one of these approaches (in order of preference):
  1. Run `node scripts/extract.js [WIX URL]` from the wix-escape repo if you have terminal access
  2. If you have the Chrome DevTools MCP connected, intercept Wix's internal API calls as each page loads — these return clean JSON with the real content
  3. Use `page.evaluate()` to extract window globals (`window.__WIX_DATA__`, JSON-LD script tags)
  4. If all else fails, ask me to open the page and copy the text

- For blog posts: don't rely on the RSS feed (it only shows 20 posts). Scrape the blog archive pages directly.
- Download every image — don't just save the URL, the files need to actually be retrieved
- Preserve for each piece of content: title, URL slug, publish date, categories/tags, SEO title and description, featured image

## Step 3: Set up WordPress.com

I need to create/have a WordPress.com site. Help me:
- Recommend a theme that matches my current site's visual style
- Create all categories and tags from my Wix site
- Configure basic settings: site title, tagline, permalink structure

For connecting to WordPress.com, I can either:
- Enable MCP at wordpress.com/me/mcp and connect you directly
- Generate an Application Password at wordpress.com/me/security/application-passwords

Tell me which you need.

## Step 4: Publish everything

In this order:
1. Upload all images to the WordPress media library (needed first to get the new URLs)
2. Create all pages with correct parent/child relationships
3. Create all blog posts with correct dates, categories, tags, and featured images
4. Rewrite all internal links from old Wix URLs to new WordPress URLs
5. Set up navigation menus matching the original site
6. Configure homepage and blog page

## Step 5: Verify

When done:
- Give me a URL mapping table: old Wix URL → new WordPress URL (for setting up redirects)
- Flag any posts/pages that are missing or had import errors
- Check for any images still pointing to Wix CDN URLs
- List everything that needs manual attention (forms, bookings, store, etc.) with your recommendation for what plugin to use

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step. If you hit something unexpected, tell me what you found rather than guessing.
