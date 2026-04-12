import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface VerificationReport {
  outputDir: string;
  wxrFound: boolean;
  contentItems: number;
  pages: number;
  posts: number;
  mediaAttachments: number;
  mediaOnDisk: number;
  staleCdnUrls: string[];
  failedUrls: Array<{ url: string; error: string }>;
  failedMedia: Array<{ url: string; error: string }>;
  redirectCount: number;
  qualityScores: { high: number; medium: number; low: number };
  manualAttentionItems: string[];
}

const STALE_CDN_PATTERNS = [
  /https?:\/\/[^\s"'<>]*wixstatic\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*wixmp\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*squarespace-cdn\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*static\.squarespace\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*assets\.squarespace\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*cdn\.shopify\.com[^\s"'<>]*/g,
  /https?:\/\/[^\s"'<>]*assets-global\.website-files\.com[^\s"'<>]*/g,
];

function scanForStaleCdnUrls(wxrContent: string): string[] {
  const found = new Set<string>();
  const contentBlocks = wxrContent.match(/<content:encoded>\s*<!\[CDATA\[([\s\S]*?)\]\]>/g) || [];
  const allContent = contentBlocks.join('\n');
  for (const pattern of STALE_CDN_PATTERNS) {
    const matches = allContent.match(pattern) || [];
    for (const m of matches) found.add(m);
  }
  return [...found];
}

function parseExtractionLog(logPath: string): {
  failedUrls: Array<{ url: string; error: string }>;
  failedMedia: Array<{ url: string; error: string }>;
  qualityScores: { high: number; medium: number; low: number };
} {
  const failedUrls: Array<{ url: string; error: string }> = [];
  const failedMedia: Array<{ url: string; error: string }> = [];
  const qualityScores = { high: 0, medium: 0, low: 0 };
  if (!existsSync(logPath)) return { failedUrls, failedMedia, qualityScores };
  const content = readFileSync(logPath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type: string; url?: string; error?: string; qualityScore?: string; };
      if (entry.type === 'failed' && entry.url) failedUrls.push({ url: entry.url, error: entry.error || 'unknown' });
      if (entry.type === 'media_failed' && entry.url) failedMedia.push({ url: entry.url, error: entry.error || 'unknown' });
      if (entry.type === 'processed' && entry.qualityScore) {
        const score = entry.qualityScore as keyof typeof qualityScores;
        if (score in qualityScores) qualityScores[score]++;
      }
    } catch { /* skip malformed lines */ }
  }
  return { failedUrls, failedMedia, qualityScores };
}

function countWxrItems(wxrContent: string): { pages: number; posts: number; media: number } {
  const pages = (wxrContent.match(/<wp:post_type>\s*<!\[CDATA\[page\]\]>/g) || []).length;
  const posts = (wxrContent.match(/<wp:post_type>\s*<!\[CDATA\[post\]\]>/g) || []).length;
  const media = (wxrContent.match(/<wp:post_type>\s*<!\[CDATA\[attachment\]\]>/g) || []).length;
  return { pages, posts, media };
}

export async function verifyExtraction(outputDir: string): Promise<VerificationReport> {
  const wxrPath = join(outputDir, 'output.wxr');
  const logPath = join(outputDir, 'extraction-log.jsonl');
  const redirectPath = join(outputDir, 'redirect-map.json');
  const mediaDir = join(outputDir, 'media');

  const wxrFound = existsSync(wxrPath);
  let wxrContent = '';
  let pages = 0, posts = 0, mediaAttachments = 0;
  let staleCdnUrls: string[] = [];
  if (wxrFound) {
    wxrContent = readFileSync(wxrPath, 'utf8');
    const counts = countWxrItems(wxrContent);
    pages = counts.pages; posts = counts.posts; mediaAttachments = counts.media;
    staleCdnUrls = scanForStaleCdnUrls(wxrContent);
  }

  const { failedUrls, failedMedia, qualityScores } = parseExtractionLog(logPath);

  let redirectCount = 0;
  if (existsSync(redirectPath)) {
    try {
      const redirects = JSON.parse(readFileSync(redirectPath, 'utf8'));
      redirectCount = Array.isArray(redirects) ? redirects.length : 0;
    } catch { /* malformed */ }
  }

  let mediaOnDisk = 0;
  if (existsSync(mediaDir)) {
    try { mediaOnDisk = readdirSync(mediaDir).filter((f) => !f.startsWith('.')).length; } catch { /* ignore */ }
  }

  const manualAttentionItems: string[] = [];
  if (staleCdnUrls.length > 0) manualAttentionItems.push(`${staleCdnUrls.length} stale CDN URL(s) still in content — images may break after source site changes`);
  if (failedUrls.length > 0) manualAttentionItems.push(`${failedUrls.length} page(s) failed extraction — re-run with --resume or extract manually`);
  if (failedMedia.length > 0) manualAttentionItems.push(`${failedMedia.length} media file(s) failed to download — check URLs and retry`);
  if (qualityScores.low > 0) manualAttentionItems.push(`${qualityScores.low} page(s) with low quality scores — review content manually`);

  return {
    outputDir, wxrFound, contentItems: pages + posts, pages, posts,
    mediaAttachments, mediaOnDisk, staleCdnUrls, failedUrls, failedMedia,
    redirectCount, qualityScores, manualAttentionItems,
  };
}
