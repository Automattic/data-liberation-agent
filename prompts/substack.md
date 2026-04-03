# Substack to WordPress.com Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my publication from Substack to WordPress.com. My Substack URL is: **[PASTE YOUR SUBSTACK URL HERE]**

I have (or will create) a WordPress.com account. Please help me migrate using the playbook at https://github.com/Automattic/data-liberation-agent — read AGENTS.md first for full instructions.

Here's what I need you to do:

## Step 1: Inventory my publication

- Use the Substack API to list all my posts: fetch `[MY SUBSTACK URL]/api/v1/archive?sort=new&limit=50&offset=0` (paginate through all results)
- Categorize each post: free, paid, podcast, thread, page
- Note my publication name, description, and about page
- Count total posts, paid vs. free breakdown, and any podcast episodes
- Show me the inventory and wait for my approval before proceeding

## Step 2: Export and extract content

**For free content:**
- Fetch each post's full content via the API: `[MY SUBSTACK URL]/api/v1/posts/[SLUG]`
- This gives you the full HTML body, metadata, cover images, and dates

**For paid content (if I have any):**
- Ask me to go to Substack Settings > Exports > Create new export
- I'll download the ZIP and give you the CSV file
- Use the CSV's `body_html` column for paid post content — the API only gives the free preview

**For all content:**
- Download every image — Substack wraps images through `substackcdn.com/image/fetch/...`. Extract the original URL from inside the CDN wrapper to get full-resolution images
- Preserve for each post: title, subtitle, URL slug, publish date, categories/sections, cover image, audience (free/paid), word count

## Step 3: Set up WordPress.com

I need to create/have a WordPress.com site. Help me:
- Recommend a theme that works well for newsletters/blogs
- Create categories based on any Substack sections I have
- Configure basic settings: site title, tagline, permalink structure matching `/p/[slug]` if possible (for easier redirects)

For connecting to WordPress.com, I can either:
- Enable MCP at wordpress.com/me/mcp and connect you directly
- Generate an Application Password at wordpress.com/me/security/application-passwords

Tell me which you need.

## Step 4: Publish everything

In this order:
1. Upload all images to the WordPress media library (needed first to get new URLs)
2. Create all posts with correct dates, featured images, and content
3. Rewrite all internal links and image `src` attributes from Substack URLs to new WordPress URLs
4. Set up navigation and homepage

**Special handling needed:**
- **Subtitles**: Substack has a subtitle field — add it as the first line of the post in `<em>` tags, or use a subtitle plugin if available
- **Paid content**: If I want to gate content on WordPress, ask me which membership/paywall plugin to use (WooCommerce Memberships, Restrict Content Pro, etc.) and which posts should stay gated
- **Podcast episodes**: If I have podcast content, check if the audio files are downloadable from Substack and re-host them. Set up a podcasting plugin if needed.

## Step 5: Handle subscribers

- Ask me to export my subscriber list from Substack (Settings > Exports)
- Help me choose an email service (Mailchimp, ConvertKit, ActiveCampaign, etc.) or the built-in WordPress.com newsletter feature
- Import the subscriber list

**Note about paid subscribers**: If I have paid subscribers through Substack, this is complex — I may need to:
- Set up a new payment system (Stripe on WordPress)
- Communicate with subscribers about the move
- Plan a transition period

Tell me what my options are before doing anything.

## Step 6: Verify and redirect

When done:
- Give me a URL mapping table: old Substack URL → new WordPress URL (for setting up redirects)
- Check that no images still point to `substackcdn.com`
- If I use a custom domain on Substack, help me set up 301 redirects from `/p/[slug]` to the new WordPress paths
- If I'm on `[name].substack.com`, note that I can't set up redirects — but I can add a pinned post on Substack linking to my new site
- List anything that needs manual attention

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step. If you hit something unexpected, tell me what you found rather than guessing.
