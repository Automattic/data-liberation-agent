import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { downloadMedia } from '../lib/extraction/media.js';
import { getPlaywright, sleep } from './shared.js';
import { mkdirSync } from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstagramAdapterOpts extends Record<string, unknown> {
  cdpPort?: number;
  delay?: number;
  limit?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
}

export type InstagramPostType = 'photo' | 'video' | 'carousel';

export interface InstagramProfile {
  id?: string;
  username: string;
  fullName: string;
  biography: string;
  profilePicUrl: string;
  postCount: number | null;
  followerCount: number | null;
  followingCount: number | null;
  isPrivate: boolean;
  isVerified: boolean;
}

export interface InstagramPost {
  id?: string;
  shortcode: string;
  type: InstagramPostType;
  /** Unix seconds */
  timestamp: number | null;
  /** ISO date string */
  date: string | null;
  caption: string;
  displayUrl: string | null;
  thumbnailUrl?: string | null;
  dimensions?: { width: number; height: number } | null;
  isVideo?: boolean;
  videoUrl?: string | null;
  accessibilityCaption?: string | null;
  locationName?: string | null;
  locationId?: string | null;
  likes?: number | null;
  comments?: number | null;
  carouselCount?: number | null;
  url: string;
}

export interface InstagramInventoryUrl {
  url: string;
  type: InstagramPostType;
  id?: string;
  shortcode: string;
}

export interface InstagramInventory {
  platform: 'instagram';
  username: string;
  profile: InstagramProfile | null;
  discoveredAt: string;
  counts: Record<string, number>;
  urls: InstagramInventoryUrl[];
  posts: InstagramPost[];
}

// ---------------------------------------------------------------------------
// Helpers — URL and caption parsing
// ---------------------------------------------------------------------------

/** Extract the username from an Instagram profile URL or a bare `@username` / `username`. */
export function parseInstagramUsername(input: string): string {
  const trimmed = input.trim().replace(/^@/, '');
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (/instagram\.com$/i.test(u.hostname) || /\.instagram\.com$/i.test(u.hostname)) {
      const first = u.pathname.replace(/^\//, '').split('/')[0];
      return first || '';
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function classifyInstagramPost(node: Record<string, unknown>): InstagramPostType {
  if (node.__typename === 'GraphSidecar' || node.edge_sidecar_to_children) return 'carousel';
  if (node.__typename === 'GraphVideo' || node.is_video) return 'video';
  return 'photo';
}

interface GraphqlEdgeNode {
  id?: string;
  shortcode?: string;
  __typename?: string;
  edge_sidecar_to_children?: { edges?: unknown[] };
  is_video?: boolean;
  video_url?: string;
  taken_at_timestamp?: number;
  display_url?: string;
  thumbnail_src?: string;
  thumbnail_resources?: Array<{ src: string }>;
  dimensions?: { width: number; height: number };
  accessibility_caption?: string;
  location?: { name?: string; id?: string; pk?: string };
  edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
  edge_media_preview_like?: { count?: number };
  edge_liked_by?: { count?: number };
  edge_media_to_comment?: { count?: number };
  edge_media_preview_comment?: { count?: number };
}

export function extractPostMeta(node: GraphqlEdgeNode): InstagramPost {
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  const ts = node.taken_at_timestamp ?? null;
  return {
    id: node.id,
    shortcode: node.shortcode || '',
    type: classifyInstagramPost(node as unknown as Record<string, unknown>),
    timestamp: ts,
    date: ts ? new Date(ts * 1000).toISOString() : null,
    caption,
    displayUrl: node.display_url || null,
    thumbnailUrl: node.thumbnail_src || node.thumbnail_resources?.[0]?.src || null,
    dimensions: node.dimensions || null,
    isVideo: !!node.is_video,
    videoUrl: node.video_url || null,
    accessibilityCaption: node.accessibility_caption || null,
    locationName: node.location?.name || null,
    locationId: node.location?.id || node.location?.pk || null,
    likes: node.edge_media_preview_like?.count ?? node.edge_liked_by?.count ?? null,
    comments: node.edge_media_to_comment?.count ?? node.edge_media_preview_comment?.count ?? null,
    carouselCount: node.edge_sidecar_to_children?.edges?.length || null,
    url: `https://www.instagram.com/p/${node.shortcode}/`,
  };
}

// ---------------------------------------------------------------------------
// Caption → Gutenberg content
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Linkify #hashtags and @mentions in a caption, preserving line breaks. */
export function captionToHtml(caption: string): string {
  if (!caption) return '';
  const lines = caption.split(/\r?\n/);
  const html = lines.map((line) => {
    const escaped = escapeHtml(line);
    const withLinks = escaped
      .replace(/#(\w+)/g, '<a href="https://www.instagram.com/explore/tags/$1/">#$1</a>')
      .replace(/@(\w+)/g, '<a href="https://www.instagram.com/$1/">@$1</a>');
    return withLinks;
  }).join('<br />');
  return html;
}

export function extractHashtags(caption: string): string[] {
  if (!caption) return [];
  return [...caption.matchAll(/#(\w+)/g)].map((m) => m[1]);
}

export interface RenderedMedia {
  /** URL used as the `src` in the block — typically the local media URL placeholder or original URL. */
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  id?: number;
}

/**
 * Build Gutenberg block markup for an Instagram post.
 * - Photo: `wp:image` block
 * - Video: `wp:video` block
 * - Carousel: `wp:gallery` block wrapping `wp:image` children
 */
export function buildInstagramPostContent(post: {
  type: InstagramPostType;
  caption: string;
  sourceUrl: string;
  media: RenderedMedia[];
  locationName?: string | null;
}): string {
  const parts: string[] = [];

  const renderImageBlock = (m: RenderedMedia): string => {
    const altAttr = m.alt ? ` alt="${escapeHtml(m.alt)}"` : ' alt=""';
    const idComment = m.id ? `{"id":${m.id}}` : '{}';
    return (
      `<!-- wp:image ${idComment} -->\n` +
      `<figure class="wp-block-image"><img src="${m.url}"${altAttr} /></figure>\n` +
      `<!-- /wp:image -->`
    );
  };

  const renderVideoBlock = (m: RenderedMedia): string => {
    return (
      `<!-- wp:video -->\n` +
      `<figure class="wp-block-video"><video controls src="${m.url}"></video></figure>\n` +
      `<!-- /wp:video -->`
    );
  };

  if (post.type === 'carousel' && post.media.length > 1) {
    const ids = post.media.filter((m) => m.id).map((m) => m.id);
    const galleryAttrs = ids.length ? `{"linkTo":"none","ids":[${ids.join(',')}]}` : `{"linkTo":"none"}`;
    const inner = post.media
      .map((m) => (m.url && /\.(mp4|mov|webm)$/i.test(m.url) ? renderVideoBlock(m) : renderImageBlock(m)))
      .join('\n');
    parts.push(
      `<!-- wp:gallery ${galleryAttrs} -->\n` +
      `<figure class="wp-block-gallery has-nested-images columns-default is-cropped">\n${inner}\n</figure>\n` +
      `<!-- /wp:gallery -->`
    );
  } else if (post.media.length > 0) {
    const first = post.media[0];
    if (post.type === 'video' || /\.(mp4|mov|webm)$/i.test(first.url)) {
      parts.push(renderVideoBlock(first));
    } else {
      parts.push(renderImageBlock(first));
    }
  }

  if (post.caption) {
    parts.push(`<!-- wp:paragraph -->\n<p>${captionToHtml(post.caption)}</p>\n<!-- /wp:paragraph -->`);
  }

  if (post.locationName) {
    parts.push(
      `<!-- wp:paragraph {"className":"instagram-location"} -->\n` +
      `<p class="instagram-location"><em>${escapeHtml(post.locationName)}</em></p>\n` +
      `<!-- /wp:paragraph -->`
    );
  }

  parts.push(
    `<!-- wp:paragraph {"className":"instagram-source"} -->\n` +
    `<p class="instagram-source"><a href="${post.sourceUrl}">View on Instagram</a></p>\n` +
    `<!-- /wp:paragraph -->`
  );

  return parts.join('\n\n');
}

/** Derive a post title from the first line / first N chars of a caption. */
export function titleFromCaption(caption: string, shortcode: string): string {
  if (!caption) return `Instagram post ${shortcode}`;
  const firstLine = caption.split(/\r?\n/)[0].trim();
  if (!firstLine) return `Instagram post ${shortcode}`;
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Playwright discovery — scrolls profile, intercepts GraphQL
// ---------------------------------------------------------------------------

interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
  evaluate<T = unknown>(fn: (...a: unknown[]) => T, arg?: unknown): Promise<T>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  on(ev: string, handler: (resp: unknown) => void): void;
  off(ev: string, handler: (resp: unknown) => void): void;
  close(): Promise<void>;
  $(sel: string): Promise<unknown>;
  url(): string;
}

async function openPage(cdpPort: number): Promise<{ browser: { close(): Promise<void>; disconnect?(): Promise<void>; contexts(): Array<{ newPage(): Promise<PwPage>; pages?(): PwPage[] }> }; page: PwPage }> {
  const pw = await getPlaywright();
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] || (await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<PwPage> }> }).newContext());
  const page = (await context.newPage()) as unknown as PwPage;
  return { browser: browser as unknown as { close(): Promise<void>; disconnect?(): Promise<void>; contexts(): Array<{ newPage(): Promise<PwPage> }> }, page };
}

async function discoverProfile(
  username: string,
  cdpPort: number,
  limit: number,
  scrollDelay: number,
  sendLog: (msg: string) => void
): Promise<{ profile: InstagramProfile | null; posts: InstagramPost[] }> {
  const { browser, page } = await openPage(cdpPort);

  const posts = new Map<string, InstagramPost>();
  let profile: InstagramProfile | null = null;
  let hasMore = true;
  let endCursor: string | null = null;

  const responseHandler = async (response: unknown) => {
    const resp = response as { url(): string; headers(): Record<string, string>; json(): Promise<unknown> };
    const respUrl = resp.url();
    if (!respUrl.includes('/graphql/query') && !respUrl.includes('/api/v1/')) return;
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('text/javascript')) return;
    try {
      const body = (await resp.json()) as Record<string, unknown>;
      const userData =
        (body?.data as Record<string, unknown> | undefined)?.user ||
        (body?.graphql as Record<string, unknown> | undefined)?.user ||
        (body?.data as Record<string, unknown> | undefined)?.xdt_api__v1__feed__user_timeline_graphql_connection;
      if (!userData) return;
      const u = userData as Record<string, unknown>;

      if (!profile && (u.username || u.full_name)) {
        profile = {
          id: (u.id as string) || (u.pk as string) || undefined,
          username: (u.username as string) || username,
          fullName: (u.full_name as string) || '',
          biography: (u.biography as string) || (u.bio_text as string) || '',
          profilePicUrl: (u.profile_pic_url_hd as string) || (u.profile_pic_url as string) || '',
          postCount: (u.edge_owner_to_timeline_media as { count?: number } | undefined)?.count ?? (u.media_count as number) ?? null,
          followerCount: (u.edge_followed_by as { count?: number } | undefined)?.count ?? (u.follower_count as number) ?? null,
          followingCount: (u.edge_follow as { count?: number } | undefined)?.count ?? (u.following_count as number) ?? null,
          isPrivate: !!u.is_private,
          isVerified: !!u.is_verified,
        };
      }

      const timeline = (u.edge_owner_to_timeline_media as { edges?: Array<{ node?: GraphqlEdgeNode }>; page_info?: { has_next_page?: boolean; end_cursor?: string } } | undefined)
        || (u.edge_web_feed_timeline as { edges?: Array<{ node?: GraphqlEdgeNode }>; page_info?: { has_next_page?: boolean; end_cursor?: string } } | undefined);

      if (timeline?.edges) {
        for (const edge of timeline.edges) {
          const node = edge.node;
          if (node?.shortcode && !posts.has(node.shortcode)) {
            posts.set(node.shortcode, extractPostMeta(node));
          }
        }
        if (timeline.page_info) {
          hasMore = !!timeline.page_info.has_next_page;
          endCursor = timeline.page_info.end_cursor || null;
        }
      }
    } catch {
      // Ignore non-JSON responses
    }
  };

  page.on('response', responseHandler);

  try {
    const profileUrl = `https://www.instagram.com/${username}/`;
    sendLog(`Navigating to ${profileUrl}`);
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
    } catch (e) {
      if (posts.size === 0) throw e;
    }

    const loginPrompt = await page.$('input[name="username"]');
    if (loginPrompt) {
      throw new Error(
        'Not logged into Instagram in this browser session. ' +
          'Log in to Instagram in the Chrome window connected via CDP and re-run.'
      );
    }

    sendLog('Scrolling to load posts…');
    let scrollAttempts = 0;
    let lastCount = posts.size;
    let noNewStreak = 0;
    let currentDelay = scrollDelay;

    while (posts.size < limit && scrollAttempts < 100) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await sleep(currentDelay);
      scrollAttempts++;
      if (posts.size === lastCount) {
        noNewStreak++;
        currentDelay = Math.min(currentDelay * 1.5, scrollDelay * 4);
        if (noNewStreak >= 4) break;
      } else {
        noNewStreak = 0;
        currentDelay = Math.max(scrollDelay, currentDelay * 0.8);
        lastCount = posts.size;
        sendLog(`  scroll ${scrollAttempts}: ${posts.size} posts`);
      }
      if (!hasMore) break;
    }

    // Suppress "declared but unused" — endCursor is kept as state for future direct GraphQL pagination.
    void endCursor;
  } finally {
    page.off('response', responseHandler);
    try { await page.close(); } catch { /* ignore */ }
    try { await (browser.disconnect ? browser.disconnect() : browser.close()); } catch { /* ignore */ }
  }

  const allPosts = [...posts.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { profile, posts: allPosts };
}

// ---------------------------------------------------------------------------
// Per-post extraction via CDP — visits each post, collects media URLs
// ---------------------------------------------------------------------------

interface ExtractedInstagramPost {
  post: InstagramPost;
  media: Array<{
    type: 'photo' | 'video';
    sourceUrl: string;
    accessibilityCaption?: string | null;
    width?: number;
    height?: number;
  }>;
}

async function extractSinglePost(page: PwPage, inventoryPost: InstagramPost): Promise<ExtractedInstagramPost> {
  const shortcode = inventoryPost.shortcode;
  const postUrl = inventoryPost.url || `https://www.instagram.com/p/${shortcode}/`;

  const apiCalls: Record<string, unknown>[] = [];
  const responseHandler = async (response: unknown) => {
    const resp = response as { url(): string; headers(): Record<string, string>; json(): Promise<unknown> };
    const respUrl = resp.url();
    if (!respUrl.includes('/graphql/query') && !respUrl.includes('/api/v1/media/')) return;
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('text/javascript')) return;
    try { apiCalls.push((await resp.json()) as Record<string, unknown>); } catch { /* ignore */ }
  };

  page.on('response', responseHandler);
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('article img[src*="cdninstagram.com"]', { timeout: 10000 }).catch(() => {});
  } finally {
    page.off('response', responseHandler);
  }

  // Find post detail in the intercepted API calls
  let detail: Record<string, unknown> | null = null;
  for (const data of apiCalls) {
    const d = data as Record<string, unknown>;
    const media =
      (d?.data as Record<string, unknown> | undefined)?.xdt_shortcode_media ||
      (d?.graphql as Record<string, unknown> | undefined)?.shortcode_media ||
      ((d?.items as Array<Record<string, unknown>> | undefined)?.[0]);
    if (media && ((media as Record<string, unknown>).shortcode === shortcode || (media as Record<string, unknown>).code === shortcode)) {
      detail = media as Record<string, unknown>;
      break;
    }
  }

  const media: ExtractedInstagramPost['media'] = [];

  if (detail) {
    const d = detail as Record<string, unknown>;
    const sidecar = (d.edge_sidecar_to_children as { edges?: Array<{ node?: Record<string, unknown> }> } | undefined)?.edges;
    if (sidecar) {
      for (const edge of sidecar) {
        const child = edge.node as Record<string, unknown>;
        media.push({
          type: child.is_video ? 'video' : 'photo',
          sourceUrl: (child.video_url as string) || (child.display_url as string) || '',
          accessibilityCaption: (child.accessibility_caption as string) || null,
          width: (child.dimensions as { width?: number } | undefined)?.width,
          height: (child.dimensions as { height?: number } | undefined)?.height,
        });
      }
    } else {
      media.push({
        type: d.is_video ? 'video' : 'photo',
        sourceUrl: (d.video_url as string) || (d.display_url as string) || '',
        accessibilityCaption: (d.accessibility_caption as string) || null,
        width: (d.dimensions as { width?: number } | undefined)?.width,
        height: (d.dimensions as { height?: number } | undefined)?.height,
      });
    }
  }

  // Carousel slide sweep via ?img_index=N — fallback when API detail didn't expose children
  if (inventoryPost.type === 'carousel' && media.length <= 1) {
    const expected = inventoryPost.carouselCount || 10;
    const seenIds = new Set<string>();
    for (let slide = 1; slide <= expected; slide++) {
      try {
        const slideUrl = `${postUrl}?img_index=${slide}`;
        await page.goto(slideUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('li img[src*="cdninstagram.com"]', { timeout: 8000 }).catch(() => {});
        await sleep(600);
        const imgs = (await page.evaluate(() => {
          const results: Array<{ src: string; alt: string; mediaId: string | null }> = [];
          for (const img of Array.from(document.querySelectorAll('li img'))) {
            const src = (img as HTMLImageElement).src || '';
            if (!src.includes('cdninstagram.com/v/t51.')) continue;
            const alt = (img as HTMLImageElement).alt || '';
            if (alt.includes('User avatar')) continue;
            const rect = (img as HTMLImageElement).getBoundingClientRect();
            if (rect.width < 300) continue;
            const idMatch = src.match(/\/(\d{5,})_/);
            results.push({ src, alt, mediaId: idMatch?.[1] || null });
          }
          return results;
        })) as Array<{ src: string; alt: string; mediaId: string | null }>;

        for (const img of imgs) {
          if (!img.mediaId || seenIds.has(img.mediaId)) continue;
          seenIds.add(img.mediaId);
          media.push({ type: 'photo', sourceUrl: img.src, accessibilityCaption: img.alt });
        }
      } catch {
        break;
      }
    }
  }

  // Last-resort fallback: use display URL from inventory
  if (media.length === 0 && inventoryPost.displayUrl) {
    media.push({
      type: inventoryPost.isVideo ? 'video' : 'photo',
      sourceUrl: inventoryPost.videoUrl || inventoryPost.displayUrl,
      accessibilityCaption: inventoryPost.accessibilityCaption || null,
    });
  }

  return { post: inventoryPost, media };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const instagramAdapter: PlatformAdapter = {
  id: 'instagram',

  detect(url: string): boolean {
    return /(^|[/.])instagram\.com/i.test(url);
  },

  async discover(url: string, opts: Record<string, unknown>): Promise<InstagramInventory> {
    const igOpts = opts as InstagramAdapterOpts;
    const username = parseInstagramUsername(url);
    if (!username) throw new Error(`Could not parse Instagram username from: ${url}`);
    if (!igOpts.cdpPort) {
      throw new Error(
        'Instagram discovery requires --cdp-port. ' +
          'Launch Chrome with --remote-debugging-port=<port> and log in to Instagram first.'
      );
    }

    const scrollDelay = igOpts.delay ?? 2000;
    const limit = igOpts.limit ?? Infinity;
    const sendLog = (msg: string) => { if (igOpts.verbose) console.log(msg); };

    const { profile, posts } = await discoverProfile(username, igOpts.cdpPort, limit, scrollDelay, sendLog);

    const counts: Record<string, number> = { photo: 0, video: 0, carousel: 0 };
    for (const p of posts) counts[p.type] = (counts[p.type] || 0) + 1;

    return {
      platform: 'instagram',
      username,
      profile,
      discoveredAt: new Date().toISOString(),
      counts,
      urls: posts.map((p) => ({ url: p.url, type: p.type, id: p.id, shortcode: p.shortcode })),
      posts,
    };
  },

  async extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<{
    pagesExtracted: number;
    postsExtracted: number;
    failed: number;
    mediaCollected: number;
  }> {
    const inv = inventory as InstagramInventory;
    const igOpts = opts as InstagramAdapterOpts;
    const delayMs = igOpts.delay ?? 1500;
    const outputDir = igOpts.outputDir || '';
    const mediaDir = outputDir ? `${outputDir}/media` : null;
    if (mediaDir) mkdirSync(mediaDir, { recursive: true });

    if (!igOpts.cdpPort && !igOpts.dryRun) {
      throw new Error('Instagram extraction requires --cdp-port (authenticated browser session).');
    }

    const sendLog = (message: string) => {
      try { context.server?.sendLoggingMessage?.({ level: 'info', data: message }); } catch { /* ignore */ }
    };

    // Register a single author based on the profile
    const authorLogin = (inv.profile?.username || inv.username).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'instagram';
    wxr.addAuthor({
      login: authorLogin,
      displayName: inv.profile?.fullName || inv.profile?.username || inv.username,
    });

    const processed = igOpts.resume ? context.log.getProcessedUrls() : new Set<string>();
    let postsToProcess = inv.posts.filter((p) => !processed.has(p.url));
    if (igOpts.dryRun) postsToProcess = postsToProcess.slice(0, 3);

    let postsExtracted = 0;
    let failed = 0;
    const seenMediaNames = new Map<string, number>();
    const seenMediaHashes = new Map<string, string>();
    const downloadedUrls = new Set<string>();
    const seenTagSlugs = new Set<string>();

    // Browser session — only opened if we actually have posts to fetch
    let browserSession: { page: PwPage; close: () => Promise<void> } | null = null;
    const getPage = async (): Promise<PwPage> => {
      if (!browserSession) {
        const { browser, page } = await openPage(igOpts.cdpPort as number);
        browserSession = {
          page,
          close: async () => {
            try { await page.close(); } catch { /* ignore */ }
            try { await (browser.disconnect ? browser.disconnect() : browser.close()); } catch { /* ignore */ }
          },
        };
      }
      return browserSession.page;
    };

    try {
      for (let i = 0; i < postsToProcess.length; i++) {
        const inventoryPost = postsToProcess[i];
        const startMs = Date.now();
        sendLog(`[${i + 1}/${postsToProcess.length}] ${inventoryPost.url}`);

        try {
          let extracted: ExtractedInstagramPost;
          if (igOpts.dryRun) {
            // Dry run: don't hit the browser, build content from inventory-only data
            extracted = {
              post: inventoryPost,
              media: inventoryPost.displayUrl
                ? [{ type: inventoryPost.isVideo ? 'video' : 'photo', sourceUrl: inventoryPost.videoUrl || inventoryPost.displayUrl }]
                : [],
            };
          } else {
            extracted = await extractSinglePost(await getPage(), inventoryPost);
          }

          // Download media for the post and build RenderedMedia list
          const rendered: RenderedMedia[] = [];
          let featuredMediaId: number | undefined;

          for (const m of extracted.media) {
            if (!m.sourceUrl) continue;
            let url = m.sourceUrl;
            let mediaId: number | undefined;

            if (!igOpts.dryRun && mediaDir && !downloadedUrls.has(m.sourceUrl)) {
              downloadedUrls.add(m.sourceUrl);
              const result = await downloadMedia(m.sourceUrl, mediaDir, seenMediaNames, seenMediaHashes);
              context.log.logMedia({
                url: m.sourceUrl,
                localPath: result.localPath,
                error: result.error,
              });
              if (!result.error && result.localPath) {
                mediaId = wxr.addMedia({
                  url: m.sourceUrl,
                  localPath: result.localPath,
                  title: result.filename || '',
                  altText: m.accessibilityCaption || '',
                });
                if (wxr.isStreaming) {
                  wxr.flushItem(wxr.items[wxr.items.length - 1]);
                }
                url = m.sourceUrl; // keep original URL in content; WP importer rewrites via media map
                if (!featuredMediaId) featuredMediaId = mediaId;
              }
            }

            rendered.push({
              url,
              alt: m.accessibilityCaption || '',
              width: m.width,
              height: m.height,
              id: mediaId,
            });
          }

          // Hashtags → tags
          const hashtags = extractHashtags(inventoryPost.caption);
          for (const tag of hashtags) {
            const slug = tag.toLowerCase();
            if (seenTagSlugs.has(slug)) continue;
            seenTagSlugs.add(slug);
            wxr.addTag({ slug, name: tag });
          }

          const content = buildInstagramPostContent({
            type: inventoryPost.type,
            caption: inventoryPost.caption,
            sourceUrl: inventoryPost.url,
            media: rendered,
            locationName: inventoryPost.locationName,
          });

          const title = titleFromCaption(inventoryPost.caption, inventoryPost.shortcode);
          const excerpt = inventoryPost.caption
            ? inventoryPost.caption.split(/\r?\n/)[0].slice(0, 200)
            : '';

          wxr.addPost({
            title,
            slug: inventoryPost.shortcode.toLowerCase(),
            content,
            excerpt,
            date: inventoryPost.date || new Date().toISOString(),
            sourceUrl: inventoryPost.url,
            featuredMediaId,
            tags: hashtags,
            author: authorLogin,
          });
          if (wxr.isStreaming) {
            wxr.flushItem(wxr.items[wxr.items.length - 1]);
          }

          // Redirect from Instagram path to new slug
          try {
            const originalPath = new URL(inventoryPost.url).pathname;
            wxr.addRedirect({ from: originalPath, to: `/${inventoryPost.shortcode.toLowerCase()}` });
          } catch { /* ignore */ }

          postsExtracted++;
          context.log.logProcessed({
            url: inventoryPost.url,
            slug: inventoryPost.shortcode,
            durationMs: Date.now() - startMs,
            qualityScore: extracted.media.length > 0 ? 'high' : 'low',
          });
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          context.log.logFailed({ url: inventoryPost.url, error: msg });
          sendLog(`  FAILED: ${msg}`);
        }

        if (i < postsToProcess.length - 1 && delayMs > 0) await sleep(delayMs);
      }
    } finally {
      if (browserSession) await browserSession.close();
    }

    return {
      pagesExtracted: 0,
      postsExtracted,
      failed,
      mediaCollected: downloadedUrls.size,
    };
  },
};
