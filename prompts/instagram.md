# Instagram to WordPress Migration Prompt

Copy everything below this line and paste it into your AI assistant (Claude, ChatGPT, Gemini, etc.).

---

I want to migrate my Instagram posts to WordPress. My Instagram username (or profile URL) is: **[PASTE YOUR USERNAME OR PROFILE URL HERE]**

I have (or will create) a WordPress site. Please help me migrate using the playbook at https://github.com/Automattic/data-liberation-agent — read AGENTS.md first for full instructions.

**Important**: Instagram has no public sitemap and no unauthenticated API. The Instagram adapter requires an authenticated browser session connected via Chrome DevTools Protocol (CDP). I'll need Chrome (or another Chromium browser) launched with `--remote-debugging-port` and logged into Instagram **before** we run discovery or extraction.

## Step 1: Inspect

```bash
npm run inspect -- https://www.instagram.com/[MY-USERNAME]/
```

This confirms the platform is detected as Instagram and shows what the adapter expects.

## Step 2: Launch Chrome with remote debugging and log in to Instagram

```bash
# macOS:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.data-liberation/cdp-profile/chrome" \
  --restore-last-session

# Linux:
google-chrome --remote-debugging-port=9222

# Windows:
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

In that Chrome window, navigate to `https://www.instagram.com/` and log in. Confirm I'm logged in before continuing.

## Step 3: Discover all my posts

```bash
npm run liberate -- https://www.instagram.com/[MY-USERNAME]/ --output ./output --cdp-port 9222 --verbose --discover-only
```

The Instagram adapter will:
- Open a new tab in the connected Chrome window and navigate to my profile
- Scroll the profile, intercepting Instagram's GraphQL responses to capture post metadata (captions, dates, locations, hashtags, photo/video/carousel type, slide counts)
- Build an inventory at `output/inventory.json`

**If it stalls or gets rate limited**, add `--delay 3000` for a gentler scroll cadence.

Show me the inventory summary (counts by type, total post count, profile metadata) and wait for my approval before extracting.

## Step 4: Extract content and download media

```bash
npm run liberate -- https://www.instagram.com/[MY-USERNAME]/ --output ./output --cdp-port 9222 --verbose
```

For each post the adapter will:
- Visit the post URL in the connected browser
- Capture full-resolution images from the intercepted media API responses
- For carousels, walk `?img_index=N` for every slide and dedupe by Instagram media ID
- Download all images and videos locally (Instagram CDN URLs expire — this must happen promptly after discovery)
- Build a `wp:image` block for photos, `wp:video` for videos, and `wp:gallery` for carousels
- Convert hashtags to WordPress tags and `@mentions` / `#hashtags` in captions to links
- Append a "View on Instagram" source link to each post

If extraction is interrupted, resume with `--resume`.

## Step 5: Verify

```bash
npm run verify -- ./output
```

Show me the verification report and flag any posts with missing media or failed extractions.

## Step 6: Import to WordPress

```bash
npm run setup -- --site [MY-WORDPRESS-SITE] --username [MY-USERNAME] --token [APP-PASSWORD]
npm run import -- ./output --site [MY-WORDPRESS-SITE] --username [MY-USERNAME] --token [APP-PASSWORD]
```

Work methodically — do one step at a time, show me progress, and wait for my go-ahead before moving to the next step.
