import * as cheerio from 'cheerio';
import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { parseSitemapXml, classifyUrl } from '../lib/extraction/sitemap.js';
import {
  slugify,
  runExtractionLoop,
  extractMeta,
  extractTitle,
  extractNavLinks,
  IMAGE_EXTENSIONS,
} from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoDaddyWmAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
}

export interface GoDaddyWmInventory {
  siteUrl: string;
  discoveredAt: string;
  siteMeta: {
    title: string;
    tagline: string;
    language: string;
  };
  navigation: NavLink[];
  counts: Record<string, number>;
  urls: InventoryUrl[];
}

// ---------------------------------------------------------------------------
// W+M isteam CDN URL upgrade
// ---------------------------------------------------------------------------
//
// W+M serves images via `img1.wsimg.com/isteam/<type>/<id>[/<filename>]` with
// an optional `/:/<transforms>` suffix (`rs=w:370,cg:true,m`, `cr=w:600,h:300`,
// etc.). URLs harvested from the live DOM almost always include a small
// transform (370/740/1110 wide), and URLs with no transform at all default to
// a ~600px thumbnail. To preserve max-fidelity media, rewrite every isteam URL
// to request the CDN's largest served variant — `/:/rs=w:4000,cg:true`
// preserves aspect ratio on user-uploaded images (`/ip/<uuid>/...`) and caps
// stock images (`/getty/<id>`, `/stock/<id>`) at their square 3840×3840 max.
//
// This must be applied consistently everywhere a URL is either (a) added to
// the media download list or (b) embedded in body HTML, because the WP
// importer rewrites media URLs via exact string match.
// ---------------------------------------------------------------------------

function upgradeIsteamUrl(raw: string): string {
  if (!raw) return raw;
  let url = raw.trim();
  // Protocol-relative URLs show up in Draft.js and some HTML attrs
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\/img1\.wsimg\.com\/isteam\//i.test(url)) return raw;
  // Strip any existing /:/... transform suffix
  const [base] = url.split('/:/');
  // Request max CDN-served width with aspect preserved
  return `${base}/:/rs=w:4000,cg:true`;
}

// ---------------------------------------------------------------------------
// Draft.js → HTML converter
// ---------------------------------------------------------------------------
//
// W+M blog posts hydrate client-side from a `window._BLOG_DATA` JSON blob.
// The real post body lives at `_BLOG_DATA.post.fullContent` as a Draft.js
// ContentState: { blocks: [...], entityMap: {...} }. Each block has a type
// (unstyled, header-N, list, blockquote, etc.), a text string, inline style
// ranges, and entity ranges that reference entityMap by key.
//
// This converter handles the common subset actually used by W+M blogs.
// ---------------------------------------------------------------------------

interface DraftEntity {
  type: string;
  mutability?: string;
  data?: { src?: string; alt?: string; href?: string; target?: string; [k: string]: unknown };
}

interface DraftStyleRange {
  offset: number;
  length: number;
  style: string;
}

interface DraftEntityRange {
  offset: number;
  length: number;
  key: number;
}

interface DraftBlock {
  key: string;
  text: string;
  type: string;
  depth?: number;
  inlineStyleRanges?: DraftStyleRange[];
  entityRanges?: DraftEntityRange[];
  data?: Record<string, unknown>;
}

interface DraftContentState {
  blocks: DraftBlock[];
  entityMap: Record<string, DraftEntity>;
}

const INLINE_STYLE_TAGS: Record<string, string> = {
  BOLD: 'strong',
  ITALIC: 'em',
  UNDERLINE: 'u',
  STRIKETHROUGH: 's',
  CODE: 'code',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Render a single Draft.js block's text with its inline styles and entity ranges
 * applied. Walks the string one character at a time, emitting open/close tags
 * when the set of active styles or the active entity changes.
 */
function renderBlockText(block: DraftBlock, entityMap: Record<string, DraftEntity>): string {
  const text = block.text || '';
  if (!text) return '';

  const styleRanges = block.inlineStyleRanges || [];
  const entityRanges = block.entityRanges || [];

  type Segment = { char: string; styles: Set<string>; entityKey: number | null };
  const segments: Segment[] = [];

  for (let i = 0; i < text.length; i++) {
    const styles = new Set<string>();
    for (const r of styleRanges) {
      if (i >= r.offset && i < r.offset + r.length) styles.add(r.style);
    }
    let entityKey: number | null = null;
    for (const r of entityRanges) {
      if (i >= r.offset && i < r.offset + r.length) {
        entityKey = r.key;
        break;
      }
    }
    segments.push({ char: text[i], styles, entityKey });
  }

  // Walk segments, tracking open tags as a stack. When the active set changes,
  // close tags that are no longer active and open any newly active ones.
  let out = '';
  const openStyles: string[] = []; // stack of style names currently open
  let openEntity: number | null = null;

  const closeAll = () => {
    while (openStyles.length) {
      const s = openStyles.pop()!;
      const tag = INLINE_STYLE_TAGS[s];
      if (tag) out += `</${tag}>`;
    }
    if (openEntity != null) {
      const ent = entityMap[String(openEntity)];
      if (ent && ent.type === 'LINK') out += '</a>';
      openEntity = null;
    }
  };

  const prevActive = { styles: new Set<string>(), entity: null as number | null };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // If active set differs from prev, close everything then reopen
    const stylesEqual =
      seg.styles.size === prevActive.styles.size &&
      [...seg.styles].every((s) => prevActive.styles.has(s));
    const entityEqual = seg.entityKey === prevActive.entity;
    if (!stylesEqual || !entityEqual) {
      closeAll();
      // Open entity first (so style tags nest inside link)
      if (seg.entityKey != null) {
        const ent = entityMap[String(seg.entityKey)];
        if (ent && ent.type === 'LINK') {
          const href = escapeAttr(String(ent.data?.href || '#'));
          const target = ent.data?.target ? ` target="${escapeAttr(String(ent.data.target))}"` : '';
          out += `<a href="${href}"${target}>`;
          openEntity = seg.entityKey;
        }
      }
      for (const s of seg.styles) {
        const tag = INLINE_STYLE_TAGS[s];
        if (tag) {
          out += `<${tag}>`;
          openStyles.push(s);
        }
      }
      prevActive.styles = new Set(seg.styles);
      prevActive.entity = seg.entityKey;
    }
    out += escapeHtml(seg.char);
  }

  closeAll();
  return out;
}

/**
 * Render an `atomic` block — W+M uses these for images. Looks up the entity
 * referenced by the block's single entityRange and emits <figure><img/></figure>.
 */
function renderAtomicBlock(block: DraftBlock, entityMap: Record<string, DraftEntity>): string {
  const ranges = block.entityRanges || [];
  if (ranges.length === 0) return '';
  const ent = entityMap[String(ranges[0].key)];
  if (!ent || ent.type !== 'IMAGE') return '';
  const src = upgradeIsteamUrl(String(ent.data?.src || ''));
  const alt = escapeAttr(String(ent.data?.alt || ''));
  return `<figure><img src="${escapeAttr(src)}" alt="${alt}" /></figure>`;
}

/**
 * Convert a Draft.js ContentState to HTML. Groups consecutive list items
 * into <ul>/<ol> wrappers.
 */
function draftToHtml(content: DraftContentState): string {
  const blocks = content.blocks || [];
  const entityMap = content.entityMap || {};
  const out: string[] = [];

  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const block of blocks) {
    const type = block.type || 'unstyled';
    const isUl = type === 'unordered-list-item';
    const isOl = type === 'ordered-list-item';

    if (isUl || isOl) {
      const want = isUl ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${renderBlockText(block, entityMap)}</li>`);
      continue;
    }

    closeList();

    if (type === 'atomic') {
      const atomic = renderAtomicBlock(block, entityMap);
      if (atomic) out.push(atomic);
      continue;
    }

    const inner = renderBlockText(block, entityMap);
    if (type === 'unstyled') {
      if (inner.trim()) out.push(`<p>${inner}</p>`);
    } else if (/^header-(one|two|three|four|five|six)$/.test(type)) {
      const levels: Record<string, number> = {
        'header-one': 1,
        'header-two': 2,
        'header-three': 3,
        'header-four': 4,
        'header-five': 5,
        'header-six': 6,
      };
      const n = levels[type];
      out.push(`<h${n}>${inner}</h${n}>`);
    } else if (type === 'blockquote') {
      out.push(`<blockquote>${inner}</blockquote>`);
    } else if (type === 'code-block') {
      out.push(`<pre><code>${inner}</code></pre>`);
    } else {
      // Unknown block type — emit as paragraph as a safe fallback
      if (inner.trim()) out.push(`<p>${inner}</p>`);
    }
  }

  closeList();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// _BLOG_DATA extraction
// ---------------------------------------------------------------------------

interface BlogDataPost {
  title?: string;
  date?: string;
  publishedDate?: string;
  content?: string;
  fullContent?: string;
  slug?: string;
  featuredImage?: string;
  categories?: string[];
}

interface BlogData {
  post?: BlogDataPost;
}

/**
 * Parse `window._BLOG_DATA = {...}` from a W+M blog post's HTML. Returns null
 * if the page isn't a blog post or the JSON can't be parsed.
 */
function parseBlogData(html: string): BlogData | null {
  const marker = 'window._BLOG_DATA=';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const scriptEnd = html.indexOf('</script>', start);
  if (scriptEnd < 0) return null;
  const raw = html.slice(start + marker.length, scriptEnd).trim().replace(/;$/, '');
  try {
    return JSON.parse(raw) as BlogData;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// W+M-specific HTML extraction
// ---------------------------------------------------------------------------

function extractContent(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, link, meta').remove();
  $('section[data-aid="HEADER_SECTION"]').remove();
  $('header[data-aid="HEADER_WIDGET"]').remove();
  $('[data-aid^="FOOTER_"]').remove();
  $('footer').remove();
  $('[data-aid*="COOKIE"], [data-aid*="HAMBURGER"], [data-aid="NAV_MORE"]').remove();

  // Strip the page title widget — it's duplicated with <wp:post_title>. W+M
  // tags the first section's title as `<SECTION>_SECTION_TITLE_RENDERED`
  // (e.g. ABOUT_SECTION_TITLE_RENDERED, CONTENT_SECTION_TITLE_RENDERED).
  // Only strip the first one so secondary section headings survive.
  $('[data-aid$="_SECTION_TITLE_RENDERED"]').first().remove();

  // Strip the hero image widget — it's duplicated with the media attachment
  // the extraction loop creates. W+M tags the lead image of a section as
  // `<SECTION>_IMAGE_RENDERED0`. Only strip the first one.
  $('[data-aid$="_IMAGE_RENDERED0"]').first().remove();

  // Upgrade any surviving isteam <img src> to request the CDN's max-resolution
  // variant. Must happen here so the body HTML and the mediaUrls both contain
  // the same string — otherwise the WP importer's exact-match URL rewriting
  // leaves the body pointing at the original img1.wsimg.com URL.
  //
  // W+M also uses a lazy-loading pattern where the real URL is hidden in
  // `data-srclazy` / `data-srcsetlazy` (and standard `srcset`) with a base64
  // gif placeholder in `src`. Rewrite those attrs too — otherwise WP sees
  // a data-uri `src` and an un-upgraded lazy attr, neither of which gets
  // rewritten to the local media attachment.
  // Rewrite <img src>, upgrade the lazy URL, and strip all srcset variants.
  // W+M ships responsive images as <picture><source srcset=1x,2x,3x><img src>
  // with srcset values containing URLs that themselves contain commas (inside
  // crop/resize transforms like `cr=t:12.53%25,l:0%25,...`). Trying to parse
  // that safely is fragile, and WordPress regenerates its own srcset from the
  // uploaded media on import — so we can just drop srcset and data-srcsetlazy
  // entirely and let the canonical <img src> handle everything.
  $('img, source').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    if (src && !src.startsWith('data:')) $el.attr('src', upgradeIsteamUrl(src));
    const lazy = $el.attr('data-srclazy');
    if (lazy) {
      const upgraded = upgradeIsteamUrl(lazy);
      $el.attr('data-srclazy', upgraded);
      // Promote the lazy URL into the real src so WordPress's URL rewriting
      // picks it up. Without this the body keeps a data:image/gif placeholder.
      if (!src || src.startsWith('data:')) $el.attr('src', upgraded);
    }
    $el.removeAttr('srcset');
    $el.removeAttr('data-srcsetlazy');
  });
  // <source> elements inside a <picture> whose own srcset we just stripped
  // are now empty and useless — drop them entirely so they don't clutter the
  // imported HTML.
  $('source').remove();

  const main = $('main').first();
  if (main.length && main.text().trim().length > 50) {
    return main.html()?.trim() || '';
  }
  return $('body').html()?.trim() || '';
}

function extractHeading(html: string): string {
  const $ = cheerio.load(html);
  const header = $('section[data-aid="HEADER_SECTION"]');
  const headerNodes = new Set(header.find('h1, h2').toArray());
  const h1 = $('h1').toArray().find((el) => !headerNodes.has(el));
  if (h1) {
    const t = $(h1).text().trim();
    if (t) return t;
  }
  const h2 = $('h2').toArray().find((el) => !headerNodes.has(el));
  if (h2) {
    const t = $(h2).text().trim();
    if (t) return t;
  }
  return extractMeta(html, 'og:title') || extractTitle(html);
}

function extractWmMediaUrls(html: string): string[] {
  const urls = new Set<string>();

  // Scoop up every img1.wsimg.com/isteam URL found in the page source —
  // catches lazy-load attrs (data-srclazy, data-srcsetlazy), srcset, inline
  // styles, and raw references we might otherwise miss.
  const cdnPattern = /https?:\/\/img1\.wsimg\.com\/isteam\/[^\s"'<>)]+/g;
  const protocolRelativeCdn = /\/\/img1\.wsimg\.com\/isteam\/[^\s"'<>)]+/g;
  for (const m of html.match(cdnPattern) || []) urls.add(m);
  for (const m of html.match(protocolRelativeCdn) || []) urls.add(`https:${m}`);

  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const match of imgSrcMatches) {
    const src = match.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && !src[1].startsWith('data:')) {
      const resolved = src[1].startsWith('//') ? `https:${src[1]}` : src[1];
      if (resolved.startsWith('http')) urls.add(resolved);
    }
  }

  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls]
    .map(upgradeIsteamUrl)
    .filter((u) => {
      try {
        const parsed = new URL(u);
        if (/\/favicon\//i.test(parsed.pathname)) return false;
        // For isteam URLs the path may have no extension (e.g. /getty/<id>) —
        // accept anyway since we know it's an image.
        if (/^img1\.wsimg\.com$/i.test(parsed.hostname)) return true;
        if (nonImageExtensions.test(parsed.pathname)) return false;
        return IMAGE_EXTENSIONS.test(parsed.pathname);
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// W+M sitemap discovery
// ---------------------------------------------------------------------------

async function fetchXml(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return '';
    }
    return await resp.text();
  } catch {
    return '';
  }
}

// Fetch each W+M sub-sitemap individually so blog posts can be tagged `post`
// precisely — classifyUrl does not match W+M's /news,-updates-and-reviews/f/<slug> shape.
// sitemap.ols.xml is intentionally skipped in v1 (no test fixture for OLS yet).
async function discoverWmUrls(baseUrl: string): Promise<InventoryUrl[]> {
  const normalized = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
  const origin = new URL(normalized).origin;

  const out: InventoryUrl[] = [];
  const seen = new Set<string>();

  const tagged: Array<{ path: string; type: 'page' | 'post' }> = [
    { path: '/sitemap.website.xml', type: 'page' },
    { path: '/sitemap.blog.xml', type: 'post' },
  ];

  for (const { path, type } of tagged) {
    const xml = await fetchXml(`${origin}${path}`);
    if (!xml) continue;
    const urls = parseSitemapXml(xml);
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      const finalType = classifyUrl(u) === 'homepage' ? 'homepage' : type;
      out.push({ url: u, type: finalType });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const godaddyWmAdapter: PlatformAdapter = {
  id: 'godaddy-wm',

  // W+M sites run on custom domains — detection happens via HTTP source
  // signals in detect-platform.ts, not URL pattern matching.
  detect(_url: string): boolean {
    return false;
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<GoDaddyWmInventory> {
    const normalized = url.includes('://') ? url : `https://${url}`;

    let homepageHtml = '';
    try {
      const resp = await fetch(normalized, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
      });
      if (resp.ok) {
        homepageHtml = await resp.text();
      } else {
        await resp.body?.cancel();
      }
    } catch {
      // Network error — continue with empty HTML
    }

    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const ogSiteName = extractMeta(homepageHtml, 'og:site_name');
    const siteTitle = ogSiteName || ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';

    const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
    const siteLanguage = langMatch?.[1] || 'en-US';

    const navigation = extractNavLinks(homepageHtml, normalized);

    const inventoryUrls = await discoverWmUrls(normalized);

    if (inventoryUrls.length === 0) {
      inventoryUrls.push({ url: normalized, type: 'homepage' });
    }

    const counts: Record<string, number> = {};
    for (const u of inventoryUrls) {
      counts[u.type] = (counts[u.type] || 0) + 1;
    }

    return {
      siteUrl: url,
      discoveredAt: new Date().toISOString(),
      siteMeta: {
        title: siteTitle,
        tagline: siteTagline,
        language: siteLanguage,
      },
      navigation,
      counts,
      urls: inventoryUrls,
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
    productsExtracted: number;
    failed: number;
    mediaCollected: number;
  }> {
    const inv = inventory as GoDaddyWmInventory;
    const wmOpts = opts as GoDaddyWmAdapterOpts;
    const delayMs = wmOpts.delay != null ? wmOpts.delay : 300;
    const outputDir = wmOpts.outputDir || '';

    return runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!wmOpts.dryRun,
      resume: !!wmOpts.resume,
      verbose: wmOpts.verbose,
      server: context.server,
      extractPage: async (url: string) => {
        let html = '';
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
          });
          if (resp.ok) {
            html = await resp.text();
          } else {
            await resp.body?.cancel();
          }
        } catch {
          // Network error
        }

        // W+M blog posts hydrate from window._BLOG_DATA — prefer JSON-sourced
        // title/date/content/categories/media over DOM-scraped values. Pages
        // and other URL types fall through to DOM extraction.
        const blogData = parseBlogData(html);
        const blogPost = blogData?.post;

        let content: string;
        let title: string;
        let date: string;
        let categories: string[] = [];
        let detectedType: 'post' | undefined;

        if (blogPost && typeof blogPost.fullContent === 'string') {
          try {
            const draft = JSON.parse(blogPost.fullContent) as DraftContentState;
            // Drop the first block if it's an atomic image matching the
            // post's featuredImage — otherwise the post body leads with the
            // same image that's already attached via mediaUrls.
            const featured = blogPost.featuredImage || '';
            if (featured && draft.blocks?.length) {
              const first = draft.blocks[0];
              if (first.type === 'atomic' && (first.entityRanges?.length ?? 0) > 0) {
                const ent = draft.entityMap?.[String(first.entityRanges![0].key)];
                if (ent?.type === 'IMAGE') {
                  let src = String(ent.data?.src || '');
                  if (src.startsWith('//')) src = `https:${src}`;
                  // Normalize: strip protocol + trailing query
                  const norm = (u: string) => u.replace(/^https?:/, '').split('?')[0];
                  if (norm(src) === norm(featured)) {
                    draft.blocks = draft.blocks.slice(1);
                  }
                }
              }
            }
            content = draftToHtml(draft);
          } catch {
            // Malformed Draft.js payload — fall back to the plain-text excerpt
            content = blogPost.content ? `<p>${escapeHtml(blogPost.content)}</p>` : '';
          }
          title = blogPost.title || extractHeading(html) || slugify(url);
          date = blogPost.publishedDate || blogPost.date || '';
          categories = Array.isArray(blogPost.categories) ? blogPost.categories : [];
          detectedType = 'post';
        } else {
          content = extractContent(html);
          title = extractHeading(html) || slugify(url);
          const articleDate = extractMeta(html, 'article:published_time');
          const timeElement = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
          date = articleDate || timeElement || '';
        }

        const excerpt =
          (blogPost?.content && blogPost.content.replace(/\.{3}$/, '').trim()) ||
          extractMeta(html, 'og:description') ||
          extractMeta(html, 'description') ||
          '';
        const seoTitle = extractMeta(html, 'og:title') || extractTitle(html) || title;
        const seoDescription = excerpt;

        const author = extractMeta(html, 'author') || undefined;

        const mediaUrls = extractWmMediaUrls(html);
        // Also harvest media referenced from inside the Draft.js content we just built.
        // The Draft.js renderer already upgraded URLs via upgradeIsteamUrl, so these
        // match what was embedded in the body HTML.
        if (content) {
          const contentImgs = content.match(/https?:\/\/img1\.wsimg\.com\/isteam\/[^\s"'<>)]+/g) || [];
          for (const u of contentImgs) if (!mediaUrls.includes(u)) mediaUrls.push(u);
        }
        // And the W+M featuredImage field (upgrade to match body references)
        if (blogPost?.featuredImage) {
          const upgraded = upgradeIsteamUrl(blogPost.featuredImage);
          if (!mediaUrls.includes(upgraded)) mediaUrls.push(upgraded);
        }

        const ogImage = extractMeta(html, 'og:image');
        if (ogImage && ogImage.startsWith('http')) {
          const upgraded = upgradeIsteamUrl(ogImage);
          if (!mediaUrls.includes(upgraded)) {
            try {
              const p = new URL(upgraded);
              // Accept isteam URLs even without an extension
              if (/^img1\.wsimg\.com$/i.test(p.hostname) || IMAGE_EXTENSIONS.test(p.pathname)) {
                mediaUrls.push(upgraded);
              }
            } catch { /* invalid URL */ }
          }
        }

        let qualityScore: 'high' | 'medium' | 'low' = 'low';
        if (content.length > 500) qualityScore = 'high';
        else if (content.length > 100) qualityScore = 'medium';

        return {
          title,
          slug: slugify(url),
          content,
          excerpt,
          date,
          seoTitle,
          seoDescription,
          mediaUrls,
          qualityScore,
          categories,
          tags: [],
          author,
          detectedType,
        };
      },
    });
  },
};
