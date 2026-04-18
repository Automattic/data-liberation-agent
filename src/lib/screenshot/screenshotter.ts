import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { connectBrowser, slugify } from '../../adapters/shared.js';
import { classifyUrl } from '../extraction/sitemap.js';
import {
  DEFAULT_VIEWPORTS,
  type ScreenshotOpts,
  type ScreenshotResult,
  type Viewport,
} from './types.js';
import { validateOutputDir, planArtifacts, type ArtifactPlan } from './output-layout.js';
import { enforceSameOrigin } from './same-origin.js';
import { ManifestQueue, type ManifestEntry, type FailureEntry } from './manifest-queue.js';
import { waitForStable, triggerLazyLoad } from './page-helpers.js';
import { analyzePage } from './site-analysis.js';

/**
 * Scroll offset multiplier for the scrolled-state screenshot: we scroll to
 * `viewport.height * SCROLL_OFFSET_RATIO` and clip a viewport-sized region
 * starting at that same Y. Both sites (the scroll and the clip origin) must
 * stay in lockstep; changing one changes the other.
 */
const SCROLL_OFFSET_RATIO = 1.5;

/**
 * Per-URL capture pipeline:
 *
 *   URL
 *    │
 *    ▼
 *   classifyUrl/slugify  ──▶  manifest.claimSlug  ──▶  planArtifacts
 *    │                                                 │
 *    │                         ┌───────── needsLoad? ──┤
 *    │                         ▼ no                    ▼ yes
 *    │                   skipped++                   for each viewport:
 *    │                                                 newContext(viewport)
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 newPage
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 goto ─── 4xx/throw ──▶ failures[goto]
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 waitForStable
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 triggerLazyLoad
 *    │                                                   │
 *    │                            desktop only          ▼
 *    │                         ┌────────── plan.captureHtml ──▶ page.content → html/<slug>.html
 *    │                         │                        │
 *    │                         │                        ▼
 *    │                         │                      screenshot(fullPage)     ──▶ screenshots/<vp>/<slug>.png
 *    │                         │                        │
 *    │                         │                        ▼
 *    │                         │                      scrollTo(vh*1.5) + clip  ──▶ screenshots/<vp>/<slug>.scrolled.png
 *    │                         │                        │
 *    │                         │         desktop only   ▼
 *    │                         └──────────── analyzePage ──▶ entry.metadata
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 context.close() (finally)
 *    │                                                   │
 *    ▼                                                   ▼
 *   manifest.updateEntry + recordFailure (batched)
 *
 * Browser restart runs at BATCH BOUNDARIES only — never mid-batch.
 */

/** Race a screenshot promise against a hard timeout. Mirrors withEvaluateTimeout. */
async function withScreenshotTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`screenshot timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best-effort log forwarder — never throws into the capture loop. */
function sendLog(server: Server | undefined, message: string): void {
  if (!server) return;
  try {
    server.sendLoggingMessage({ level: 'info', data: message });
  } catch {
    /* logging transport not available */
  }
}

interface CapturePerViewportArgs {
  page: Page;
  viewport: Viewport;
  plan: ArtifactPlan;
  url: string;
  slug: string;
  settleMs: number;
  screenshotTimeoutMs: number;
  evaluateTimeoutMs: number;
  failures: FailureEntry[];
  entry: ManifestEntry;
}

async function capturePerViewport(args: CapturePerViewportArgs): Promise<void> {
  const {
    page, viewport, plan, url, slug,
    settleMs, screenshotTimeoutMs, evaluateTimeoutMs,
    failures, entry,
  } = args;
  const now = () => new Date().toISOString();
  const isDesktop = viewport.id === 'desktop';

  // --- navigation -----------------------------------------------------------
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    if (response && response.status() >= 400) {
      failures.push({
        url,
        viewport: viewport.id,
        stage: 'goto',
        error: `HTTP ${response.status()}`,
        timestamp: now(),
        attempt: 1,
      });
      return;
    }
  } catch (err) {
    failures.push({
      url,
      viewport: viewport.id,
      stage: 'goto',
      error: err instanceof Error ? err.message : String(err),
      timestamp: now(),
      attempt: 1,
    });
    return;
  }

  // --- settle + lazy load ---------------------------------------------------
  await waitForStable(page, settleMs);
  await triggerLazyLoad(page);

  // --- html (desktop only) --------------------------------------------------
  if (isDesktop && plan.captureHtml) {
    try {
      const html = await page.content();
      mkdirSync(dirname(plan.paths.html), { recursive: true });
      writeFileSync(plan.paths.html, html);
      entry.html = `html/${slug}.html`;
    } catch (err) {
      failures.push({
        url,
        viewport: viewport.id,
        stage: 'content',
        error: err instanceof Error ? err.message : String(err),
        timestamp: now(),
        attempt: 1,
      });
    }
  }

  // --- fullpage screenshot --------------------------------------------------
  if (plan.captureFullpage) {
    try {
      const buf = await withScreenshotTimeout(
        page.screenshot({ fullPage: true, type: 'png' }),
        screenshotTimeoutMs,
      );
      mkdirSync(dirname(plan.paths.fullpage), { recursive: true });
      writeFileSync(plan.paths.fullpage, buf);
      const rel = `screenshots/${viewport.id}/${slug}.png`;
      if (isDesktop) entry.desktop = rel;
      else entry.mobile = rel;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({
        url,
        viewport: viewport.id,
        stage: /screenshot timeout/.test(msg) ? 'screenshot-timeout' : 'screenshot-fullpage',
        error: msg,
        timestamp: now(),
        attempt: 1,
      });
    }
  }

  // --- scrolled screenshot --------------------------------------------------
  if (plan.captureScrolled) {
    try {
      const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const scrollY = viewport.height * SCROLL_OFFSET_RATIO;
      if (docHeight < scrollY + viewport.height) {
        // Page is shorter than scroll-offset + viewport. No distinct scrolled
        // state to capture. Skip silently (not a failure).
      } else {
        await page.evaluate((y: number) => window.scrollTo(0, y), scrollY);
        const buf = await withScreenshotTimeout(
          page.screenshot({
            fullPage: false,
            type: 'png',
            clip: {
              x: 0,
              y: scrollY,
              width: viewport.width,
              height: viewport.height,
            },
          }),
          screenshotTimeoutMs,
        );
        mkdirSync(dirname(plan.paths.scrolled), { recursive: true });
        writeFileSync(plan.paths.scrolled, buf);
        const rel = `screenshots/${viewport.id}/${slug}.scrolled.png`;
        if (isDesktop) entry.desktopScrolled = rel;
        else entry.mobileScrolled = rel;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({
        url,
        viewport: viewport.id,
        stage: /screenshot timeout/.test(msg) ? 'screenshot-timeout' : 'screenshot-scrolled',
        error: msg,
        timestamp: now(),
        attempt: 1,
      });
    }
  }

  // --- desktop-only site analysis -------------------------------------------
  if (isDesktop) {
    try {
      const analysis = await analyzePage(page, evaluateTimeoutMs);
      entry.metadata = analysis.metadata;
    } catch (err) {
      failures.push({
        url,
        viewport: viewport.id,
        stage: 'evaluate',
        error: err instanceof Error ? err.message : String(err),
        timestamp: now(),
        attempt: 1,
      });
    }
  }
}

/**
 * Capture per-viewport screenshots + html + site metadata for a list of URLs.
 * Resumable via manifest.json / failures.json; same-origin enforced; output
 * directory validated against path traversal.
 */
export async function captureScreenshots(opts: ScreenshotOpts): Promise<ScreenshotResult> {
  const startTime = Date.now();

  // --- validate + filter ----------------------------------------------------
  validateOutputDir(opts.outputDir);

  const viewports = opts.viewports ?? DEFAULT_VIEWPORTS;
  const rawConcurrency = opts.concurrency ?? 3;
  const concurrency = Math.max(1, Math.min(10, rawConcurrency));
  const browserRestartEvery = opts.browserRestartEvery ?? 100;
  const screenshotTimeoutMs = opts.screenshotTimeoutMs ?? 30_000;
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? 5_000;
  const settleMs = opts.settleMs ?? 1_000;
  const force = opts.force ?? false;
  const server = opts.server;

  let urls = opts.urls.slice();
  if (opts.types && opts.types.length > 0) {
    const allowed = new Set(opts.types);
    urls = urls.filter((u) => allowed.has(classifyUrl(u)));
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    urls = urls.slice(0, opts.limit);
  }

  // --- same-origin ---------------------------------------------------------
  enforceSameOrigin(opts.primaryUrl ?? null, urls);

  // --- output layout -------------------------------------------------------
  mkdirSync(join(opts.outputDir, 'screenshots', 'desktop'), { recursive: true });
  mkdirSync(join(opts.outputDir, 'screenshots', 'mobile'), { recursive: true });
  mkdirSync(join(opts.outputDir, 'html'), { recursive: true });

  // --- manifest -----------------------------------------------------------
  const manifestPath = join(opts.outputDir, 'screenshots', 'manifest.json');
  const manifest = new ManifestQueue(manifestPath);
  await manifest.init();
  if (force) await manifest.resetFailures();

  // --- browser -----------------------------------------------------------
  let browser: Browser = await connectBrowser({ cdpPort: opts.cdpPort }) as unknown as Browser;
  let browserRestarts = 0;
  let urlsSinceRestart = 0;

  let captured = 0;
  let skipped = 0;
  const allFailures: FailureEntry[] = [];

  const capturedAt = () => new Date().toISOString();

  const processUrl = async (url: string): Promise<void> => {
    const base = slugify(url);
    // On resume the URL may already have an entry — reuse its slug so the
    // existing-artifact check hits the same files we wrote last run. Only
    // claim a new slug for first-time URLs.
    const existing = manifest.getEntry(url);
    const slug = existing ? existing.slug : await manifest.claimSlug(base);
    const plan = planArtifacts({ slug, outputDir: opts.outputDir, force });

    if (!plan.desktop.needsLoad && !plan.mobile.needsLoad) {
      skipped++;
      sendLog(server, `[skip] ${url} (artifacts exist)`);
      return;
    }

    const entry: ManifestEntry = { slug, capturedAt: capturedAt() };
    const urlFailures: FailureEntry[] = [];

    for (const viewport of viewports) {
      const vpPlan = viewport.id === 'desktop' ? plan.desktop : plan.mobile;
      if (!vpPlan.needsLoad) continue;

      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        await capturePerViewport({
          page,
          viewport,
          plan: vpPlan,
          url,
          slug,
          settleMs,
          screenshotTimeoutMs,
          evaluateTimeoutMs,
          failures: urlFailures,
          entry,
        });
      } catch (err) {
        urlFailures.push({
          url,
          viewport: viewport.id,
          stage: 'goto',
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
          attempt: 1,
        });
      } finally {
        if (context) {
          try { await context.close(); } catch { /* best-effort */ }
        }
      }
    }

    for (const f of urlFailures) {
      await manifest.recordFailure(f);
      allFailures.push(f);
    }
    await manifest.updateEntry(url, entry);

    if (urlFailures.length === 0) {
      captured++;
      sendLog(server, `[ok] ${url}`);
    } else {
      sendLog(server, `[fail] ${url} (${urlFailures.length} failures)`);
    }
  };

  try {
    // --- batch loop with browser restart at batch boundaries -------------
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      await Promise.all(batch.map((u) => processUrl(u)));
      urlsSinceRestart += batch.length;

      const moreWork = i + concurrency < urls.length;
      if (moreWork && urlsSinceRestart >= browserRestartEvery) {
        sendLog(server, `[restart] closing browser after ${urlsSinceRestart} URLs`);
        try { await browser.close(); } catch { /* best-effort */ }
        browser = await connectBrowser({ cdpPort: opts.cdpPort }) as unknown as Browser;
        browserRestarts++;
        urlsSinceRestart = 0;
      }
    }
  } finally {
    await manifest.flush();
    try { await browser.close(); } catch { /* best-effort */ }
  }

  return {
    captured,
    skipped,
    failed: allFailures.length,
    browserRestarts,
    durationMs: Date.now() - startTime,
    manifestPath,
  };
}
