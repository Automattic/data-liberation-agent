import { createWriteStream, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { basename, extname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';

export interface DownloadResult {
  url: string;
  localPath: string | null;
  filename: string | null;
  error: string | null;
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

export async function downloadMedia(
  url: string,
  outputDir: string,
  seenNames: Map<string, number>,
  seenHashes?: Map<string, string>,
): Promise<DownloadResult> {
  try {
    const urlObj = new URL(url);
    const rawFilename = basename(urlObj.pathname) || `image-${Date.now()}.jpg`;
    const filename = safeFilename(rawFilename, seenNames);
    const destPath = resolveMediaPath(filename, outputDir);

    mkdirSync(outputDir, { recursive: true });

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fileStream = createWriteStream(destPath);
    await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

    // Deduplicate byte-identical files by content hash
    if (seenHashes) {
      const hash = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      const existing = seenHashes.get(hash);
      if (existing) {
        // Duplicate — remove the new file and return the existing path
        try { unlinkSync(destPath); } catch { /* ignore */ }
        return { url, localPath: existing, filename: basename(existing), error: null };
      }
      seenHashes.set(hash, destPath);
    }

    return { url, localPath: destPath, filename, error: null };
  } catch (err) {
    return { url, localPath: null, filename: null, error: (err as Error).message };
  }
}
