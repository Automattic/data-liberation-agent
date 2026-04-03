# Instagram to WordPress.com Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my Instagram photos and posts to WordPress.com. My Instagram username is: **[PASTE YOUR USERNAME HERE]**

I have (or will create) a WordPress.com account. Please help me migrate using the playbook at https://github.com/Automattic/data-liberation-agent — read AGENTS.md first for full instructions.

**Important**: Instagram requires an authenticated browser session. I'll need to have Chrome (or another Chromium browser) open and logged into Instagram before we start.

Here's what I need you to do:

## Step 1: Set up browser access

Help me launch Chrome with remote debugging enabled so the migration scripts can connect:

1. Quit Chrome completely
2. Relaunch with: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.data-liberation/cdp-profile/chrome" --restore-last-session`
3. Log into Instagram in the browser window that opens
4. Confirm the connection works

## Step 2: Discover all my posts

```bash
node scripts/instagram/discover.js MY_USERNAME --cdp-port 9222
```

This connects to my browser, navigates to my profile, and intercepts Instagram's internal GraphQL API responses as it scrolls through all my posts. It captures:
- Post metadata (captions, dates, locations, hashtags, tagged users)
- Post types (photos, videos, carousels with slide counts)
- Image and video URLs
- Profile information

Show me the inventory summary and wait for my approval before proceeding.

**If it stalls or gets rate limited**: Add `--delay 3000` for a gentler pace.

## Step 3: Extract full content and download media

```bash
node scripts/instagram/extract.js MY_USERNAME --cdp-port 9222
```

This visits each post individually to get:
- Full-resolution images (not thumbnails)
- All carousel slides (uses `?img_index=N` to access each slide directly)
- Video URLs
- Tagged users, location details, accessibility captions

All media is downloaded locally — Instagram CDN URLs expire, so this must happen promptly after discovery.

## Step 4: Import to WordPress.com

```bash
node scripts/import.js --site my-wp-site.wordpress.com --token MY_APP_PASSWORD
```

This creates WordPress posts from the extracted data:
- Each Instagram post becomes a WordPress post (as draft)
- Images uploaded to the media library
- Captions become post content with @mentions and #hashtags linked
- Original post date preserved
- Instagram shortcode and URL stored as post meta

**For a custom post type** (e.g. a "photo" CPT): add `--post-type photo`

## Step 5: Verify

When done:
- Show me how many posts were imported vs. discovered
- Flag any posts with missing images or import errors
- Check that carousel posts have all their slides
- List the date range covered (oldest → newest)

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step.
