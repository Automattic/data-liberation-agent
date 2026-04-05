# Shopify to WordPress.com Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my website from Shopify to WordPress.com. My Shopify store URL is: **[PASTE YOUR STORE URL HERE]** (e.g. `yourstore.myshopify.com`)

I have (or will create) a WordPress.com account. Please help me migrate using the playbook at https://github.com/Automattic/data-liberation-agent — read AGENTS.md first for full instructions.

Here's what I need you to do:

## Step 1: Set up browser session

Help me launch Chrome with remote debugging and log into my Shopify admin — this lets the script access all my content without needing API keys:

```bash
# Linux / Windows (WSL)
google-chrome --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Once Chrome opens, navigate to `https://[MY-STORE].myshopify.com/admin` and log in if not already. Leave the browser open.

## Step 2: Inventory my store

- Run `node scripts/shopify/discover.js [MY-STORE].myshopify.com --cdp-port 9222`
- This connects to the logged-in browser, navigates to the admin products/pages/blog sections, and intercepts the internal GraphQL responses
- Show me the inventory counts and a sample from each content type
- Wait for my approval before proceeding to extraction

## Step 3: Extract all content

For each item in the inventory:
- Run `node scripts/shopify/extract.js [MY-STORE].myshopify.com --inventory output/inventory.json --cdp-port 9222`
- This navigates to each item's admin detail page and captures the full GraphQL response
- It downloads all images from Shopify's CDN into `output/media/`
- It rewrites image URLs in content to point to local files
- Flag any items that returned no content (I may need to check those manually)

## Step 4: Set up WordPress.com

I need to create/have a WordPress.com site. Help me:
- Recommend a theme that matches my current store's visual style
- Create all blog categories and tags from my Shopify blog
- Configure basic settings: site title, tagline, permalink structure

Generate an Application Password at wordpress.com/me/security/application-passwords and share it with you.

## Step 5: Publish blog posts and pages

```bash
node scripts/import.js --site [MY-SITE].wordpress.com \
  --username [MY-USERNAME] --token [APP-PASSWORD]
```

In this order:
1. Upload all images to the WordPress media library
2. Create all pages with correct slugs
3. Create all blog posts with correct dates, categories, tags, and featured images
4. Generate a redirect map (`output/redirect-map.json`)

## Step 5b: Publish products to WooCommerce

First, generate WooCommerce API credentials at **WooCommerce → Settings → Advanced → REST API** (Read/Write permissions).

Then run:
```bash
node scripts/shopify/import-products.js \
  --site [MY-SITE].wordpress.com \
  --username [MY-USERNAME] --token [APP-PASSWORD] \
  --wc-key ck_xxxx --wc-secret cs_xxxx
```

This:
1. Uploads product images to the WordPress media library
2. Creates WooCommerce product categories from Shopify product types
3. Creates simple or variable products (with variations, SKUs, prices, stock quantities)

## Step 6: Verify

When done:
- Give me a URL mapping table: old Shopify URL → new WordPress URL
- Flag any posts/pages/products that are missing or had import errors
- Check for any content still referencing Shopify CDN image URLs
- List everything needing manual attention (checkout, metafields, apps, theme customizations)

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step. If you hit something unexpected, tell me what you found rather than guessing.
