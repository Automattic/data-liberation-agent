#!/usr/bin/env node
/**
 * discover.js — Step 1: Inventory an Instagram profile
 *
 * Connects to a browser where you're logged into Instagram, navigates
 * to your profile, and intercepts the GraphQL API responses as you
 * scroll to build a complete manifest of all posts.
 *
 * REQUIRES: a running browser with CDP enabled and an active Instagram session.
 * Instagram's API requires authentication — there's no public sitemap to crawl.
 *
 * Usage:
 *   node scripts/instagram/discover.js <username> --cdp-port 9222
 *   node scripts/instagram/discover.js <username> --cdp-port 9222 --limit 50
 *
 * Options:
 *   --cdp-port <port>   CDP port of your running browser (required)
 *   --limit <n>         Stop after N posts (for testing)
 *   --delay <ms>        Delay between scroll actions (default: 2000)
 *
 * Output:
 *   output/inventory.json — manifest of all discovered posts with metadata
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const username = args.find(a => !a.startsWith('--'));
if (!username) {
  console.error('Usage: node scripts/instagram/discover.js <username> --cdp-port <port>');
  process.exit(1);
}

const cdpPortArg = args.indexOf('--cdp-port');
const cdpPort = cdpPortArg !== -1 ? parseInt(args[cdpPortArg + 1]) : null;
if (!cdpPort) {
  console.error('Error: --cdp-port is required. Instagram needs an authenticated browser session.');
  console.error('Launch Chrome with: google-chrome --remote-debugging-port=9222');
  process.exit(1);
}

const limitArg = args.indexOf('--limit');
const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;
const delayArg = args.indexOf('--delay');
const scrollDelay = delayArg !== -1 ? parseInt(args[delayArg + 1]) : 2000;

mkdirSync('output', { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Classify an Instagram post by its type
function classifyPost(node) {
  if (node.__typename === 'GraphSidecar' || node.edge_sidecar_to_children) return 'carousel';
  if (node.__typename === 'GraphVideo' || node.is_video) return 'video';
  return 'photo';
}

// Extract post metadata from a GraphQL edge node
function extractPostMeta(node) {
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return {
    id: node.id,
    shortcode: node.shortcode,
    type: classifyPost(node),
    timestamp: node.taken_at_timestamp,
    date: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
    caption,
    displayUrl: node.display_url,
    thumbnailUrl: node.thumbnail_src || node.thumbnail_resources?.[0]?.src,
    dimensions: node.dimensions || null,
    isVideo: !!node.is_video,
    videoUrl: node.video_url || null,
    accessibilityCaption: node.accessibility_caption || null,
    locationName: node.location?.name || null,
    locationId: node.location?.id || null,
    likes: node.edge_media_preview_like?.count ?? node.edge_liked_by?.count ?? null,
    comments: node.edge_media_to_comment?.count ?? node.edge_media_preview_comment?.count ?? null,
    // For carousels, note how many slides
    carouselCount: node.edge_sidecar_to_children?.edges?.length || null,
    url: `https://www.instagram.com/p/${node.shortcode}/`,
  };
}

async function main() {
  console.log(`Discovering Instagram posts for: ${username}`);
  console.log(`Connecting to browser on CDP port ${cdpPort}...`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  const posts = new Map(); // shortcode → post data (dedupes)
  let profileData = null;
  let hasMore = true;
  let endCursor = null;
  let paginationRequests = 0;

  // Intercept GraphQL responses to capture post data
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/graphql/query') && !url.includes('/api/v1/')) return;

    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('text/javascript')) return;

    try {
      const body = await response.json();

      // Profile page initial load — data is in entry_data or in the graphql response
      const userData = body?.data?.user ||
                       body?.graphql?.user ||
                       body?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;

      if (userData) {
        // Extract profile info on first encounter
        if (!profileData && (userData.username || userData.full_name)) {
          profileData = {
            id: userData.id || userData.pk || null,
            username: userData.username || username,
            fullName: userData.full_name || '',
            biography: userData.biography || userData.bio_text || '',
            profilePicUrl: userData.profile_pic_url_hd || userData.profile_pic_url || '',
            postCount: userData.edge_owner_to_timeline_media?.count ??
                       userData.media_count ?? null,
            followerCount: userData.edge_followed_by?.count ??
                           userData.follower_count ?? null,
            followingCount: userData.edge_follow?.count ??
                            userData.following_count ?? null,
            isPrivate: userData.is_private || false,
            isVerified: userData.is_verified || false,
          };
          console.log(`  Profile: ${profileData.fullName} (@${profileData.username})`);
          if (profileData.postCount) {
            console.log(`  Total posts reported: ${profileData.postCount}`);
          }
        }

        // Extract posts from the timeline media edges
        const timeline = userData.edge_owner_to_timeline_media ||
                         userData.edge_web_feed_timeline;

        if (timeline?.edges) {
          for (const edge of timeline.edges) {
            const node = edge.node;
            if (node?.shortcode && !posts.has(node.shortcode)) {
              posts.set(node.shortcode, extractPostMeta(node));
            }
          }
          // Track pagination cursor
          if (timeline.page_info) {
            hasMore = timeline.page_info.has_next_page;
            endCursor = timeline.page_info.end_cursor;
          }
          paginationRequests++;
          console.log(`  Captured ${posts.size} posts (page ${paginationRequests})...`);
        }

        // Handle the newer API format (xdt_api__v1__feed)
        if (userData.edges) {
          for (const edge of userData.edges) {
            const node = edge.node;
            if (node?.code && !posts.has(node.code)) {
              posts.set(node.code, {
                id: node.pk || node.id,
                shortcode: node.code,
                type: node.carousel_media_count ? 'carousel' : node.video_versions ? 'video' : 'photo',
                timestamp: node.taken_at,
                date: node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null,
                caption: node.caption?.text || '',
                displayUrl: node.image_versions2?.candidates?.[0]?.url || '',
                thumbnailUrl: node.image_versions2?.candidates?.slice(-1)?.[0]?.url || '',
                dimensions: node.original_width && node.original_height
                  ? { width: node.original_width, height: node.original_height } : null,
                isVideo: !!node.video_versions,
                videoUrl: node.video_versions?.[0]?.url || null,
                accessibilityCaption: node.accessibility_caption || null,
                locationName: node.location?.name || null,
                locationId: node.location?.pk || null,
                likes: node.like_count ?? null,
                comments: node.comment_count ?? null,
                carouselCount: node.carousel_media_count || null,
                url: `https://www.instagram.com/p/${node.code}/`,
              });
            }
          }
          if (userData.page_info) {
            hasMore = userData.page_info.has_next_page;
            endCursor = userData.page_info.end_cursor;
          }
          paginationRequests++;
          console.log(`  Captured ${posts.size} posts (page ${paginationRequests})...`);
        }
      }
    } catch {
      // Not all responses are JSON — that's fine
    }
  });

  // Navigate to the profile
  const profileUrl = `https://www.instagram.com/${username}/`;
  console.log(`\nNavigating to ${profileUrl}`);
  try {
    await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    // networkidle can be flaky — if we already captured posts from the response
    // interceptor, we're fine
    if (posts.size > 0) {
      console.log(`  Navigation timeout, but ${posts.size} posts already captured — continuing`);
    } else {
      // Try again with just domcontentloaded
      console.log('  Retrying with relaxed wait...');
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000); // Give time for XHR requests to complete
    }
  }

  // Check if we're logged in by looking for login prompts
  const loginPrompt = await page.$('input[name="username"]');
  if (loginPrompt) {
    console.error('\nError: Not logged into Instagram in this browser session.');
    console.error('Please log in to Instagram in your browser first, then re-run.');
    await browser.close();
    process.exit(1);
  }

  // Check for private profile
  const privateMsg = await page.$('text=This account is private');
  if (privateMsg) {
    console.warn('\nWarning: This is a private profile. You can only extract your own posts or accounts you follow.');
  }

  // Also try to capture data from the page's window globals
  const windowData = await page.evaluate(() => {
    const result = {};

    // Instagram sometimes injects data into the page
    for (const key of Object.keys(window)) {
      if (key.startsWith('__additional') || key.startsWith('__NEXT') || key === '_sharedData') {
        try {
          result[key] = JSON.parse(JSON.stringify(window[key]));
        } catch {}
      }
    }

    // Check for require'd modules (older Instagram)
    try {
      if (window._sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user) {
        result.profilePageData = window._sharedData.entry_data.ProfilePage[0].graphql.user;
      }
    } catch {}

    return result;
  });

  // Extract any posts from window globals
  const globalUser = windowData?.profilePageData;
  if (globalUser?.edge_owner_to_timeline_media?.edges) {
    for (const edge of globalUser.edge_owner_to_timeline_media.edges) {
      const node = edge.node;
      if (node?.shortcode && !posts.has(node.shortcode)) {
        posts.set(node.shortcode, extractPostMeta(node));
      }
    }
    if (!profileData && globalUser.username) {
      profileData = {
        username: globalUser.username,
        fullName: globalUser.full_name || '',
        biography: globalUser.biography || '',
        profilePicUrl: globalUser.profile_pic_url_hd || '',
        postCount: globalUser.edge_owner_to_timeline_media?.count ?? null,
        followerCount: globalUser.edge_followed_by?.count ?? null,
        followingCount: globalUser.edge_follow?.count ?? null,
        isPrivate: globalUser.is_private || false,
        isVerified: globalUser.is_verified || false,
      };
    }
    console.log(`  Extracted ${posts.size} posts from page data`);
  }

  // Phase 1: Scroll to load a couple pages and capture the GraphQL patterns
  console.log('\nScrolling to load more posts...');
  let scrollAttempts = 0;
  let lastPostCount = posts.size;
  let noNewPostsStreak = 0;

  while (posts.size < limit && scrollAttempts < 100) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(scrollDelay);
    scrollAttempts++;

    if (posts.size === lastPostCount) {
      noNewPostsStreak++;
      if (noNewPostsStreak >= 4) break;
    } else {
      noNewPostsStreak = 0;
      lastPostCount = posts.size;
      console.log(`  Scroll ${scrollAttempts}: ${posts.size} posts`);
    }
  }

  // Phase 2: If we have a cursor and need more posts, use direct GraphQL requests
  // executed in the page context (inherits cookies and CSRF tokens)
  if (hasMore && endCursor && posts.size < limit) {
    console.log(`\nUsing direct GraphQL pagination (cursor available)...`);

    // First, extract the user ID from what we've already captured
    const userId = profileData?.id || await page.evaluate((uname) => {
      // Try to find the user ID from page source or existing data
      const bodyText = document.body.innerHTML;
      const idMatch = bodyText.match(/"profilePage_(\d+)"/);
      return idMatch ? idMatch[1] : null;
    }, username);

    if (!userId) {
      // Get user ID via the profile page's metadata
      const userIdFromMeta = await page.evaluate(() => {
        // Instagram embeds the user ID in various places
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const match = s.textContent.match(/"user_id":"(\d+)"/);
          if (match) return match[1];
        }
        // Also check meta tags
        const instagramUrl = document.querySelector('meta[property="al:android:url"]')?.content;
        if (instagramUrl) {
          const m = instagramUrl.match(/(\d+)/);
          if (m) return m[1];
        }
        return null;
      });

      if (userIdFromMeta) {
        if (!profileData) profileData = {};
        profileData.id = userIdFromMeta;
      }
    }

    const resolvedUserId = profileData?.id || userId;

    if (resolvedUserId) {
      console.log(`  User ID: ${resolvedUserId}`);
      let cursor = endCursor;
      let apiPage = 0;
      let apiErrors = 0;

      while (hasMore && cursor && posts.size < limit && apiErrors < 3) {
        apiPage++;
        try {
          // Execute the GraphQL query from within the page context
          // This inherits all cookies, CSRF tokens, and headers
          const result = await page.evaluate(async ({ userId, after }) => {
            // Instagram uses a specific query hash for user media pagination
            // We'll try the documented endpoint first
            const variables = JSON.stringify({
              id: userId,
              first: 12,
              after: after,
            });

            // Try the newer API endpoint first
            const url = `https://www.instagram.com/graphql/query/?query_hash=472f257a40c653c64c666ce877d59d2b&variables=${encodeURIComponent(variables)}`;

            const res = await fetch(url, {
              headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
              },
              credentials: 'include',
            });

            if (!res.ok) return { error: `HTTP ${res.status}` };
            const text = await res.text();
            try {
              return JSON.parse(text);
            } catch {
              return { error: `Not JSON (starts with: ${text.slice(0, 50)})` };
            }
          }, { userId: resolvedUserId, after: cursor });

          if (result.error) {
            console.log(`  API error: ${result.error}`);
            // Rate limited or challenged — wait and retry once
            apiErrors++;
            console.log(`  Waiting 10s and retrying (${apiErrors}/3)...`);
            await sleep(10000);
            continue;
          }

          const media = result?.data?.user?.edge_owner_to_timeline_media;
          if (media?.edges) {
            for (const edge of media.edges) {
              const node = edge.node;
              if (node?.shortcode && !posts.has(node.shortcode)) {
                posts.set(node.shortcode, extractPostMeta(node));
              }
            }
            hasMore = media.page_info?.has_next_page ?? false;
            cursor = media.page_info?.end_cursor ?? null;
            console.log(`  API page ${apiPage}: ${posts.size} total posts`);
          } else {
            // Response format might have changed — try to find data elsewhere
            console.log(`  Unexpected response format on page ${apiPage}`);
            break;
          }

          // Rate limit: be polite — API calls need more delay than scrolling
          await sleep(Math.max(scrollDelay, 3000));
        } catch (e) {
          console.log(`  API pagination error: ${e.message}`);
          break;
        }
      }
    } else {
      console.log('  Could not determine user ID — falling back to scroll only');
      // Continue scrolling as fallback
      while (posts.size < limit && scrollAttempts < 200) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await sleep(scrollDelay);
        scrollAttempts++;
        if (posts.size > lastPostCount) {
          lastPostCount = posts.size;
          noNewPostsStreak = 0;
          if (scrollAttempts % 5 === 0) console.log(`  Scroll ${scrollAttempts}: ${posts.size} posts`);
        } else {
          noNewPostsStreak++;
          if (noNewPostsStreak >= 8) break;
        }
      }
    }
  }

  await page.close();

  // Build inventory
  const allPosts = [...posts.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const counts = { photo: 0, video: 0, carousel: 0 };
  for (const post of allPosts) {
    counts[post.type] = (counts[post.type] || 0) + 1;
  }

  const inventory = {
    platform: 'instagram',
    username,
    profile: profileData,
    discoveredAt: new Date().toISOString(),
    counts,
    urls: allPosts.map(p => ({
      url: p.url,
      type: p.type,
      id: p.id,
      shortcode: p.shortcode,
    })),
    posts: allPosts,
  };

  writeFileSync('output/inventory.json', JSON.stringify(inventory, null, 2));

  console.log('\nInventory summary:');
  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`\nTotal: ${allPosts.length} posts discovered`);
  if (profileData?.postCount) {
    const pct = Math.round((allPosts.length / profileData.postCount) * 100);
    console.log(`Coverage: ${allPosts.length}/${profileData.postCount} (${pct}%)`);
  }
  console.log('Written to output/inventory.json');
  console.log('\nReview this inventory before running extract.js');
}

main().catch(e => { console.error(e); process.exit(1); });
