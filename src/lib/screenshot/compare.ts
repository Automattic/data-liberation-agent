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
import { join, dirname } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { type ViewportId } from './output-layout.js';
import { DEFAULT_VIEWPORTS } from './types.js';
import { padToMatchDecoded } from './png-pad.js';

// Cheap gate before paid agent calls (Neptune analog: PIXEL_DIFF_THRESHOLD).
// A page passes the parity gate ONLY when score >= PARITY_GATE_SCORE AND
// heightMismatchRatio <= HEIGHT_MISMATCH_THRESHOLD on every scored viewport —
// a high crop score with a height mismatch is exactly the artifact case
// (lazy-load short capture) and must NOT pass.
export const PARITY_GATE_SCORE = 0.995;
export const HEIGHT_MISMATCH_THRESHOLD = 0.02;

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
  /** Full decoded image heights (px) — crop-independent. v2 fields. */
  originHeight?: number;
  replicaHeight?: number;
  /** |originHeight − replicaHeight| / originHeight (0 when originHeight is 0). */
  heightMismatchRatio?: number;
  /** Written only when heightMismatchRatio > HEIGHT_MISMATCH_THRESHOLD. */
  paddedDiffPath?: string;
  /**
   * Full-canvas score: 1 − diffPixels/totalPixels over BOTH FULL images,
   * padded to a common canvas (padToMatchDecoded) — sees below the fold that
   * the crop `score` is blind to. Magenta-padded regions count as diff by
   * construction, so a shorter replica is penalized — intended. The crop
   * `score` stays the comparable historical metric; do not mix the two.
   * Present on every status:'ok' pair. Additive optional field — does not
   * bump the comparison.json version.
   */
  fullPageScore?: number;
}

export interface ComparisonResult {
  pathname: string;
  originUrl: string;
  replicaUrl: string;
  desktop: ViewportScore;
  mobile: ViewportScore;
}

export interface ComparisonFile {
  /** Stays 2: `fullPageScore` is an additive optional ViewportScore field, not a format break. */
  version: 2;
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

/**
 * Score a single viewport pair: decode two PNGs, crop both to the common
 * top-viewport region, run pixelmatch, and return a ViewportScore.
 *
 * @param originPngPath  - Absolute (or resolvable) path to the origin PNG.
 * @param replicaPngPath - Absolute (or resolvable) path to the replica PNG.
 * @param viewport       - Which viewport dimensions to use as the crop ceiling.
 * @param diffPath       - Optional path to write a diff PNG. Parent dir is
 *   created with mkdirSync({recursive:true}) when the file is written.
 */
export function scoreViewportPair(
  originPngPath: string,
  replicaPngPath: string,
  viewport: ViewportId,
  diffPath?: string,
): ViewportScore {
  if (!existsSync(originPngPath)) return { status: 'missing-origin', score: null };
  if (!existsSync(replicaPngPath)) return { status: 'missing-replica', score: null };

  const dim = VIEWPORT_DIMS[viewport];
  let oImg: PNG, rImg: PNG;
  try {
    oImg = PNG.sync.read(readFileSync(originPngPath));
    rImg = PNG.sync.read(readFileSync(replicaPngPath));
  } catch {
    return { status: 'decode-error', score: null };
  }

  const originHeight = oImg.height;
  const replicaHeight = rImg.height;
  const heightMismatchRatio = originHeight === 0 ? 0 : Math.abs(originHeight - replicaHeight) / originHeight;

  const w = Math.min(oImg.width, rImg.width, dim.w);
  const h = Math.min(oImg.height, rImg.height, dim.h);
  if (w <= 0 || h <= 0) return { status: 'dim-mismatch', score: null };

  const oCrop = new PNG({ width: w, height: h });
  const rCrop = new PNG({ width: w, height: h });
  PNG.bitblt(oImg, oCrop, 0, 0, w, h, 0, 0);
  PNG.bitblt(rImg, rCrop, 0, 0, w, h, 0, 0);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(oCrop.data, rCrop.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
  const total = w * h;
  const score = 1 - diffPixels / total;

  if (diffPath !== undefined) {
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
  }

  // Full-canvas score (fullPageScore): pad both FULL images to a common
  // canvas and pixelmatch the whole thing. When heights match, padToMatchDecoded
  // returns the originals unchanged (no padding, direct full-height match).
  // ONE pixelmatch pass serves both the score and the padded-diff artifact:
  // when the artifact is due (mismatch > threshold AND a diffPath was given)
  // we allocate its PNG as the pixelmatch output; otherwise output is null
  // (pixelmatch accepts null and skips diff rendering).
  const padded = padToMatchDecoded(oImg, rImg);
  const fullW = padded.canvas.width;
  const fullH = padded.canvas.height;
  const writePaddedArtifact = heightMismatchRatio > HEIGHT_MISMATCH_THRESHOLD && diffPath !== undefined;
  const padDiff = writePaddedArtifact ? new PNG({ width: fullW, height: fullH }) : null;
  const fullDiffPixels = pixelmatch(padded.aImg.data, padded.bImg.data, padDiff ? padDiff.data : null, fullW, fullH, { threshold: 0.1, includeAA: false });
  const fullPageScore = 1 - fullDiffPixels / (fullW * fullH);

  let paddedDiffPath: string | undefined;
  if (padDiff && diffPath !== undefined) {
    // Suffix-swap only when diffPath follows the *.diff.png convention;
    // append otherwise so a no-match replace can never silently overwrite
    // the crop diff at the same path.
    paddedDiffPath = diffPath.endsWith('.diff.png')
      ? diffPath.slice(0, -'.diff.png'.length) + '.padded.png'
      : diffPath + '.padded.png';
    // No mkdirSync needed: the crop diff write above already created
    // diffPath's dir, and paddedDiffPath shares that dirname by construction.
    writeFileSync(paddedDiffPath, PNG.sync.write(padDiff));
  }

  return { status: 'ok', score, diffPath, width: w, height: h, diffPixels, totalPixels: total, originHeight, replicaHeight, heightMismatchRatio, paddedDiffPath, fullPageScore };
}

export async function compareScreenshotDirs(opts: CompareOpts): Promise<ComparisonFile> {
  const viewports = opts.viewports ?? (['desktop', 'mobile'] as ViewportId[]);
  const origin = byPathname(loadManifest(opts.originDir));
  const replica = byPathname(loadManifest(opts.replicaDir));

  const diffDir = opts.diffOutputDir ?? join(opts.replicaDir, 'diff');

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
      const oPath = join(opts.originDir, vp, `${o.slug}.png`);
      const rPath = join(opts.replicaDir, vp, `${r.slug}.png`);
      const diffPath = join(diffDir, `${r.slug}.${vp}.diff.png`);
      result[vp] = scoreViewportPair(oPath, rPath, vp, diffPath);
    }
    results.push(result);
  }
  const out: ComparisonFile = { version: 2, comparedAt: new Date().toISOString(), results };
  const comparisonPath = join(opts.replicaDir, 'comparison.json');
  const comparisonTmp = comparisonPath + '.tmp';
  writeFileSync(comparisonTmp, JSON.stringify(out, null, 2));
  renameSync(comparisonTmp, comparisonPath);
  return out;
}
