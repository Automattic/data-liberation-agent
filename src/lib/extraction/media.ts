import { createWriteStream, mkdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { basename, extname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';

export interface DownloadResult {
  url: string;
  localPath: string | null;
  filename: string | null;
  error: string | null;
  bytes: number;
}

export function safeFilename(filename: string, seenNames: Map<string, number>): string {
  if (!filename) {
    filename = `image-${Date.now()}`;
  }

  if (!seenNames.has(filename)) {
    seenNames.set(filename, 1);
    return filename;
  }

  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;

  let count = (seenNames.get(filename) as number) + 1;
  let candidate = ext ? `${base}-${count}${ext}` : `${base}-${count}`;

  // Ensure generated name doesn't collide with an existing original filename
  while (seenNames.has(candidate)) {
    count++;
    candidate = ext ? `${base}-${count}${ext}` : `${base}-${count}`;
  }

  seenNames.set(filename, count);
  seenNames.set(candidate, 1);
  return candidate;
}

export function resolveMediaPath(filename: string, outputDir: string): string {
  const resolvedDir = resolve(outputDir) + '/';
  const resolved = resolve(outputDir, filename);
  if (!resolved.startsWith(resolvedDir) && resolved !== resolve(outputDir)) {
    throw new Error(`Path traversal detected: ${filename}`);
  }
  return resolved;
}

// Some CDNs encode image transforms directly in the URL path after a `/:/`
// segment marker (e.g. GoDaddy W+M's img1.wsimg.com: `/isteam/ip/<uuid>/
// <filename>.jpg/:/rs=w:4000,cg:true`). The real filename lives in the segment
// *before* `/:/`, not after. basename(pathname) returns the transform spec
// which is useless as a filename. Detect the marker and use the preceding
// segment instead.
// Make a derived filename safe for the download→WP-upload→serve→rewrite chain.
// Spaces and %-encoding (common in Wix CDN paths like `logo%20white.png`) break
// the served path and the source→local rewrite match, so slugify the base
// (decode first, then spaces/unsafe chars → '-') while preserving the extension.
export function sanitizeMediaFilename(name: string): string {
  if (!name) return name;
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* malformed escape — keep raw */ }
  const ext = extname(decoded);
  const base = ext ? decoded.slice(0, -ext.length) : decoded;
  const safeBase = base
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'image';
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
  return `${safeBase}${safeExt}`;
}

export function deriveFilenameFromUrl(urlObj: URL): string {
  const path = urlObj.pathname;
  const marker = path.indexOf('/:/');
  const effectivePath = marker >= 0 ? path.slice(0, marker) : path;
  return sanitizeMediaFilename(basename(effectivePath));
}

// Map common image content-types to file extensions. Used when the URL
// provides no extension (e.g. `/isteam/getty/<numeric-id>`).
export function extensionFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  switch (ct) {
    case 'image/jpeg': case 'image/jpg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/avif': return '.avif';
    case 'image/svg+xml': return '.svg';
    case 'image/bmp': return '.bmp';
    case 'image/tiff': return '.tiff';
    case 'image/x-icon': case 'image/vnd.microsoft.icon': return '.ico';
    default: return '';
  }
}

export async function downloadMedia(
  url: string,
  outputDir: string,
  seenNames: Map<string, number>,
  seenHashes?: Map<string, string>,
): Promise<DownloadResult> {
  try {
    const urlObj = new URL(url);
    let rawFilename = deriveFilenameFromUrl(urlObj) || `image-${Date.now()}.jpg`;

    mkdirSync(outputDir, { recursive: true });

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // If the derived filename has no extension, add one from the response
    // content-type. Skipped entirely for URLs that already carried a real
    // filename like `follow_guidelines.jpg`.
    if (!extname(rawFilename)) {
      const ct = response.headers.get('content-type') || '';
      const ext = extensionFromContentType(ct);
      if (ext) rawFilename = `${rawFilename}${ext}`;
    }

    const filename = safeFilename(rawFilename, seenNames);
    const destPath = resolveMediaPath(filename, outputDir);

    const fileStream = createWriteStream(destPath);
    await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

    // Deduplicate byte-identical files by content hash
    if (seenHashes) {
      const hash = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      const existing = seenHashes.get(hash);
      if (existing) {
        // Duplicate — remove the new file and return the existing path
        try { unlinkSync(destPath); } catch { /* ignore */ }
        return { url, localPath: existing, filename: basename(existing), error: null, bytes: 0 };
      }
      seenHashes.set(hash, destPath);
    }

    const bytes = statSync(destPath).size;
    return { url, localPath: destPath, filename, error: null, bytes };
  } catch (err) {
    return { url, localPath: null, filename: null, error: (err as Error).message, bytes: 0 };
  }
}
