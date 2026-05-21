// compareScreenshotDirs
// =====================
// Fixed-viewport pixel-parity scorer (eng-review decision 1A). Joins an
// origin screenshot dir to a replica screenshot dir BY URL PATHNAME (hosts
// differ: origin is the live site, replica is localhost), crops both
// full-page PNGs to a common top-viewport region so pixelmatch gets equal
// dimensions, and scores 1 − diffPixels/totalPixels per viewport.
//
//   manifest(origin)        manifest(replica)
//        │ entries[url]           │ entries[url]
//        └── pathname ───┐   ┌─── pathname
//                     join on pathname
//        desktop/<slug>.png   desktop/<slug>.png
//        └─ crop top WxH ─┐ ┌─ crop top WxH
//                      pixelmatch → diffPixels → score → diff PNG → comparison.json
//
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { type ViewportId } from './output-layout.js';
import { DEFAULT_VIEWPORTS } from './types.js';

export type { ViewportId };

// Derived from DEFAULT_VIEWPORTS in src/lib/screenshot/types.ts — no hardcoded numbers.
const VIEWPORT_DIMS: Record<ViewportId, { w: number; h: number }> = Object.fromEntries(
  DEFAULT_VIEWPORTS.map(vp => [vp.id, { w: vp.width, h: vp.height }])
) as Record<ViewportId, { w: number; h: number }>;

export type ViewportStatus = 'ok' | 'missing-origin' | 'missing-replica' | 'decode-error' | 'dim-mismatch';

export interface ViewportScore {
  status: ViewportStatus;
  score: number | null;          // 1 − diff/total; null unless status === 'ok'
  diffPath?: string;
  width?: number;
  height?: number;
  diffPixels?: number;
  totalPixels?: number;
}

export interface ComparisonResult {
  pathname: string;
  originUrl: string;
  replicaUrl: string;
  desktop: ViewportScore;
  mobile: ViewportScore;
}

export interface ComparisonFile {
  version: 1;
  comparedAt: string;
  results: ComparisonResult[];
}

export interface CompareOpts {
  originDir: string;             // screenshots dir: manifest.json + desktop/ mobile/
  replicaDir: string;
  viewports?: ViewportId[];       // default both
  diffOutputDir?: string;        // default <replicaDir>/diff
}

interface ManifestEntryLite { slug: string }
interface ManifestFileLite { version: 1; entries: Record<string, ManifestEntryLite> }

function loadManifest(dir: string): ManifestFileLite {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) throw new Error(`compare: manifest missing at ${p}`);
  let parsed: ManifestFileLite;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')) as ManifestFileLite; }
  catch (e) { throw new Error(`compare: malformed manifest at ${p}: ${(e as Error).message}`); }
  if (parsed.version !== 1 || !parsed.entries) throw new Error(`compare: unexpected manifest shape at ${p}`);
  return parsed;
}

/** Map pathname → { url, slug } for a manifest's entries. */
function byPathname(m: ManifestFileLite): Map<string, { url: string; slug: string }> {
  const out = new Map<string, { url: string; slug: string }>();
  for (const [url, entry] of Object.entries(m.entries)) {
    try { out.set(new URL(url).pathname, { url, slug: entry.slug }); } catch { /* skip non-URL keys */ }
  }
  return out;
}

export async function compareScreenshotDirs(opts: CompareOpts): Promise<ComparisonFile> {
  const viewports = opts.viewports ?? (['desktop', 'mobile'] as ViewportId[]);
  const origin = byPathname(loadManifest(opts.originDir));
  const replica = byPathname(loadManifest(opts.replicaDir));

  const diffDir = opts.diffOutputDir ?? join(opts.replicaDir, 'diff');
  let diffDirReady = false;

  const results: ComparisonResult[] = [];
  for (const [pathname, o] of origin) {
    const r = replica.get(pathname);
    const result: ComparisonResult = {
      pathname,
      originUrl: o.url,
      replicaUrl: r?.url ?? '',
      desktop: { status: 'missing-replica', score: null },
      mobile: { status: 'missing-replica', score: null },
    };
    for (const vp of viewports) {
      if (!r) { result[vp] = { status: 'missing-replica', score: null }; continue; }
      const dim = VIEWPORT_DIMS[vp];
      const oPath = join(opts.originDir, vp, `${o.slug}.png`);
      const rPath = join(opts.replicaDir, vp, `${r.slug}.png`);
      if (!existsSync(oPath)) { result[vp] = { status: 'missing-origin', score: null }; continue; }
      if (!existsSync(rPath)) { result[vp] = { status: 'missing-replica', score: null }; continue; }
      let oImg: PNG, rImg: PNG;
      try {
        oImg = PNG.sync.read(readFileSync(oPath));
        rImg = PNG.sync.read(readFileSync(rPath));
      } catch {
        result[vp] = { status: 'decode-error', score: null };
        continue;
      }
      const w = Math.min(oImg.width, rImg.width, dim.w);
      const h = Math.min(oImg.height, rImg.height, dim.h);
      if (w <= 0 || h <= 0) { result[vp] = { status: 'dim-mismatch', score: null }; continue; }
      const oCrop = new PNG({ width: w, height: h });
      const rCrop = new PNG({ width: w, height: h });
      PNG.bitblt(oImg, oCrop, 0, 0, w, h, 0, 0);
      PNG.bitblt(rImg, rCrop, 0, 0, w, h, 0, 0);
      const diff = new PNG({ width: w, height: h });
      const diffPixels = pixelmatch(oCrop.data, rCrop.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
      const total = w * h;
      if (!diffDirReady) { mkdirSync(diffDir, { recursive: true }); diffDirReady = true; }
      const diffPath = join(diffDir, `${r.slug}.${vp}.diff.png`);
      writeFileSync(diffPath, PNG.sync.write(diff));
      result[vp] = { status: 'ok', score: 1 - diffPixels / total, diffPath, width: w, height: h, diffPixels, totalPixels: total };
    }
    results.push(result);
  }
  const out: ComparisonFile = { version: 1, comparedAt: new Date().toISOString(), results };
  const comparisonPath = join(opts.replicaDir, 'comparison.json');
  const comparisonTmp = comparisonPath + '.tmp';
  writeFileSync(comparisonTmp, JSON.stringify(out, null, 2));
  renameSync(comparisonTmp, comparisonPath);
  return out;
}
