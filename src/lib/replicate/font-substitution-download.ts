//
// Free-replacement font downloader
// =================================
// Fetches the woff2 files for a `FreeFontReplacement` (see font-substitution.ts)
// into a theme's `assets/fonts/` directory and returns `LocalFontFace[]` — the
// same shape the captured-font path produces, so the scaffold can emit
// @font-face CSS + theme.json fontFamilies uniformly for substituted fonts.
//
// Kept separate from the pure table (`font-substitution.ts`) so the mapping
// logic stays trivially unit-testable without network or filesystem.
//

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalFontFace } from './font-capture.js';
import type { FreeFontReplacement } from './font-substitution.js';

export interface DownloadReplacementOpts {
  /** Absolute path to the theme root (e.g. output/<site>/theme). */
  themeDir: string;
  /** Theme-relative directory for fonts. Defaults to "assets/fonts". */
  fontsSubdir?: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Injected fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DownloadReplacementResult {
  /** Successfully downloaded faces with their theme-relative local paths. */
  faces: LocalFontFace[];
  /** Faces that failed to download, with the error message. */
  errors: Array<{ weight: string; url: string; error: string }>;
}

/**
 * Slugify a free family name into a filesystem-safe filename stem
 * ("Hanken Grotesk" → "HankenGrotesk").
 */
function familyStem(family: string): string {
  return family.replace(/[^A-Za-z0-9]+/g, '');
}

/**
 * Download each woff2 of a free replacement into `<themeDir>/<fontsSubdir>/`.
 * Files are named `<FamilyStem>-<weight>[-italic].woff2`. Existing files are
 * reused (idempotent across runs). Returns LocalFontFace[] for emit + failures.
 */
export async function downloadReplacementFont(
  replacement: FreeFontReplacement,
  opts: DownloadReplacementOpts,
): Promise<DownloadReplacementResult> {
  const fontsSubdir = opts.fontsSubdir ?? 'assets/fonts';
  const timeoutMs = opts.timeoutMs ?? 30000;
  const doFetch = opts.fetchImpl ?? fetch;
  const destDir = join(opts.themeDir, fontsSubdir);
  const stem = familyStem(replacement.family);

  const faces: LocalFontFace[] = [];
  const errors: DownloadReplacementResult['errors'] = [];

  for (const f of replacement.faces) {
    const italic = f.style === 'italic' ? '-italic' : '';
    // Weight may be a range ("400 700") for a variable font — flatten the space.
    const weightSlug = f.weight.replace(/\s+/g, '-');
    const filename = `${stem}-${weightSlug}${italic}.woff2`;
    const relPath = `${fontsSubdir}/${filename}`;
    const destPath = join(destDir, filename);

    const localFace: LocalFontFace = {
      family: replacement.family,
      src: f.url,
      format: 'woff2',
      weight: f.weight,
      style: f.style,
      localPath: relPath,
    };

    if (existsSync(destPath)) {
      faces.push(localFace);
      continue;
    }

    try {
      const res = await doFetch(f.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty response body');
      mkdirSync(destDir, { recursive: true });
      writeFileSync(destPath, buf);
      faces.push(localFace);
    } catch (err) {
      errors.push({ weight: f.weight, url: f.url, error: (err as Error).message });
    }
  }

  return { faces, errors };
}
