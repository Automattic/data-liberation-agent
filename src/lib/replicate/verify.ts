//
// Replica Verify
// ==============
// Captures screenshots of a running replica WP install and pairs each with the
// corresponding source screenshot from the original liberation extraction.
// The result is a structured manifest the calling agent (vision-capable) uses
// to compare side-by-side and produce qualitative observations.
//
// Why pairing-only instead of numeric scoring?
// ============================================
// The skill's verification.md spec defines structuralScore / paletteScore /
// typographyScore as ideal outputs, but iteration-1 visual verification ran
// fine without them — vision comparison surfaced the load-bearing issues
// (slug mismatch, patterns not reaching post_content) that no numeric metric
// would catch. So this tool does the deterministic part (capture + pair) and
// hands the perceptual judgement to the agent. Numeric scoring can be a
// follow-up when we have evidence vision is insufficient.
//
// Replica screenshots land at <outputDir>/replica-screenshots/<slug>.png so
// the side-by-side pairs sit alongside the source set.
//
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { connectBrowser } from '../../adapters/shared.js';

export type Viewport = 'desktop' | 'mobile';

/** One viewport's worth of capture + pairing for a single URL. */
export interface ViewportCapture {
  viewport: Viewport;
  /** Path relative to outputDir for the replica screenshot just captured. */
  replicaScreenshot: string;
  /** Path relative to outputDir for the matching source screenshot — null when no manifest entry was found. */
  sourceScreenshot: string | null;
  /** HTTP status returned by the replica navigation. */
  httpStatus: number | null;
  /** Errors encountered for this viewport (capture failed, navigation timed out, etc.). */
  errors: string[];
}

export interface VerifyPair {
  /** URL path that was navigated against the replica (e.g. "/blog/post-1"). */
  urlPath: string;
  /** Slug used to write the replica screenshot files. */
  slug: string;
  /** One ViewportCapture per requested viewport (default: desktop + mobile). */
  captures: ViewportCapture[];
}

export interface VerifyResult {
  ok: boolean;
  outputDir: string;
  replicaBaseUrl: string;
  capturedAt: string;
  pairs: VerifyPair[];
  /** URLs in `urls` that had no corresponding source manifest entry — surfaced for the agent to know coverage is incomplete. */
  unmatchedUrls: string[];
  errors: string[];
}

export interface VerifyOpts {
  /** Directory containing the original liberation output (palette.json, screenshots/manifest.json, etc.). */
  outputDir: string;
  /** Base URL of the running replica (e.g. "http://localhost:8881"). No trailing slash. */
  replicaBaseUrl: string;
  /** Path-only URLs to verify (e.g. ["/", "/blog/post-1"]). */
  urls: string[];
  /** Subdirectory under outputDir to write replica screenshots. Default: "replica-screenshots". */
  outputSubdir?: string;
  /** Viewports to capture. Default: ['desktop', 'mobile'] — matches the source screenshotter. */
  viewports?: Viewport[];
  /** Per-page navigation timeout in ms. Default: 30_000. */
  timeoutMs?: number;
  /** Optional CDP port — if provided, connect to an existing Chrome instead of launching a new one. */
  cdpPort?: number;
}

/** Viewport dimensions matched to the source screenshotter's defaults. */
const VIEWPORT_DIMENSIONS: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

interface ManifestEntry {
  slug?: string;
  desktop?: string;
  desktopScrolled?: string;
  mobile?: string;
  mobileScrolled?: string;
  html?: string;
}

interface Manifest {
  version?: number;
  entries?: Record<string, ManifestEntry>;
}

const DEFAULT_VIEWPORTS: Viewport[] = ['desktop', 'mobile'];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_SUBDIR = 'replica-screenshots';

/** Strip query/hash and trailing slash for matching. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}`;
  } catch {
    return url.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
  }
}

/** Convert a URL path into a filesystem-safe slug ("/blog/post-1" → "blog--post-1"). */
function slugFromPath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'homepage';
  return trimmed.replace(/[?#].*$/, '').replace(/\//g, '--').replace(/[^a-zA-Z0-9._-]/g, '-');
}

function loadManifest(outputDir: string): Manifest {
  const path = join(outputDir, 'screenshots', 'manifest.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

/**
 * Find the source manifest entry whose URL canonically matches `urlPath`.
 * Strategy:
 *  1. Build a canonical-path → entry index from the manifest
 *  2. Compare path-only — manifest URLs are full origins, but the agent passes
 *     replica-relative paths. The match is on the path component.
 */
function findSourceEntry(
  manifest: Manifest,
  urlPath: string,
): { url: string; entry: ManifestEntry } | null {
  const entries = manifest.entries ?? {};
  const targetPath = canonical(`http://placeholder${urlPath.startsWith('/') ? urlPath : '/' + urlPath}`).replace('http://placeholder', '');
  for (const [fullUrl, entry] of Object.entries(entries)) {
    let path: string;
    try {
      path = canonical(fullUrl).replace(new URL(fullUrl).origin, '');
    } catch {
      continue;
    }
    if (path === targetPath || (path === '' && targetPath === '/')) {
      return { url: fullUrl, entry };
    }
  }
  return null;
}

/**
 * Capture replica screenshots (one per viewport) and produce a side-by-side
 * pairing for each. Throws only on infra failures (browser launch). Per-URL
 * or per-viewport failures populate captures[].errors and the function
 * returns a result with ok=false.
 *
 * Replica screenshots land at:
 *   <outputDir>/<outputSubdir>/<viewport>/<slug>.png
 *
 * Source screenshots are looked up via screenshots/manifest.json — `desktop`
 * for desktop viewport, `mobile` for mobile viewport. URLs without a manifest
 * entry are surfaced in unmatchedUrls so the agent knows coverage is partial.
 */
export async function verifyReplica(opts: VerifyOpts): Promise<VerifyResult> {
  const outputDir = resolve(opts.outputDir);
  if (!existsSync(outputDir)) {
    throw new Error(`outputDir not found: ${outputDir}`);
  }
  const replicaBaseUrl = opts.replicaBaseUrl.replace(/\/+$/, '');
  const subdir = opts.outputSubdir ?? DEFAULT_OUTPUT_SUBDIR;
  const viewports = opts.viewports ?? DEFAULT_VIEWPORTS;
  // Pre-create the per-viewport output dirs.
  for (const vp of viewports) {
    mkdirSync(join(outputDir, subdir, vp), { recursive: true });
  }

  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const manifest = loadManifest(outputDir);

  const pairs: VerifyPair[] = [];
  const errors: string[] = [];
  const unmatchedUrls: string[] = [];

  let browser: Browser | null = null;
  try {
    browser = await connectBrowser({ cdpPort: opts.cdpPort });
  } catch (err) {
    return {
      ok: false,
      outputDir,
      replicaBaseUrl,
      capturedAt: new Date().toISOString(),
      pairs: [],
      unmatchedUrls: opts.urls.slice(),
      errors: [`Browser launch failed: ${(err as Error).message}`],
    };
  }

  try {
    for (const urlPath of opts.urls) {
      const slug = slugFromPath(urlPath);
      const fullUrl = `${replicaBaseUrl}${urlPath.startsWith('/') ? urlPath : '/' + urlPath}`;
      const sourceMatch = findSourceEntry(manifest, urlPath);
      if (!sourceMatch) {
        unmatchedUrls.push(urlPath);
      }

      const captures: ViewportCapture[] = [];
      for (const vp of viewports) {
        const dimensions = VIEWPORT_DIMENSIONS[vp];
        const replicaPath = join(outputDir, subdir, vp, `${slug}.png`);
        const replicaRel = join(subdir, vp, `${slug}.png`);
        const sourceFromManifest = sourceMatch
          ? (vp === 'desktop' ? sourceMatch.entry.desktop : sourceMatch.entry.mobile)
          : undefined;
        const capture: ViewportCapture = {
          viewport: vp,
          replicaScreenshot: replicaRel,
          sourceScreenshot: sourceFromManifest ?? null,
          httpStatus: null,
          errors: [],
        };

        // Each viewport gets its own context — Playwright doesn't let us
        // resize a context's viewport mid-flight, and reusing pages across
        // viewports leaks state in some cases (CSS hover, scroll position).
        let context: BrowserContext | null = null;
        let page: Page | null = null;
        try {
          context = await browser.newContext({ viewport: dimensions });
          context.on('page', (p: Page) => {
            p.on('dialog', (d) => {
              d.dismiss().catch(() => undefined);
            });
          });
          page = await context.newPage();
          const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout });
          capture.httpStatus = resp ? resp.status() : null;
          await page
            .waitForLoadState('networkidle', { timeout: Math.min(timeout, 15_000) })
            .catch(() => undefined);
          await page.screenshot({ path: replicaPath, fullPage: true });
        } catch (err) {
          capture.errors.push((err as Error).message);
        } finally {
          if (page) await page.close().catch(() => undefined);
          if (context) await context.close().catch(() => undefined);
        }
        captures.push(capture);
      }

      pairs.push({ urlPath, slug, captures });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const ok =
    errors.length === 0 &&
    pairs.every((p) => p.captures.every((c) => c.errors.length === 0));

  return {
    ok,
    outputDir,
    replicaBaseUrl,
    capturedAt: new Date().toISOString(),
    pairs,
    unmatchedUrls,
    errors,
  };
}
