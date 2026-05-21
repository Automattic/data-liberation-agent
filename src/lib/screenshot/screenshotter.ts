import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { connectBrowser, slugify } from '../../adapters/shared.js';
import { classifyUrl } from '../extraction/sitemap.js';
import {
  DEFAULT_VIEWPORTS,
  SCREENSHOT_DEVICE_SCALE_FACTOR,
  type ScreenshotOpts,
  type ScreenshotResult,
  type Viewport,
} from './types.js';
import { validateOutputDir, planArtifacts, type ArtifactPlan } from './output-layout.js';
import { enforceSameOrigin } from './same-origin.js';
import { ManifestQueue, type ManifestEntry, type FailureEntry } from './manifest-queue.js';
import { waitForStable, triggerLazyLoad } from './page-helpers.js';
import { analyzePage } from './site-analysis.js';
import { SiteAnalysisAggregator } from './aggregator.js';
import { CssAggregator } from './css-aggregator.js';
import { JsAggregator } from './js-aggregator.js';
import { captureDesignForUrl } from './design-capture-runner.js';
import { collectMobileChromeLayout } from './dom-capture.js';
import { generateChromeCss, type BakedLayoutMap } from './fixups.js';

/**
 * Scroll offset multiplier for the scrolled-state screenshot: we scroll to
 * `viewport.height * SCROLL_OFFSET_RATIO` and clip a viewport-sized region
 * starting at that same Y. Both sites (the scroll and the clip origin) must
 * stay in lockstep; changing one changes the other.
 */
const SCROLL_OFFSET_RATIO = 1.5;
const ANALYSIS_SAMPLE_LIMIT = 1;

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

interface DesignCaptureContext {
  cssAgg: CssAggregator;
  jsAgg?: JsAggregator;
  headLinks: Set<string>;
  cssMediaUrls: Set<string>;
  baseUrl: string;
  includeScripts: boolean;
  /** Run-level accumulator: first non-null sanitized header/footer wins. */
  chromeAccum: {
    headerHtml: string | null;
    footerHtml: string | null;
    /** Desktop baked layout map (marker → props). Set on first successful chrome capture. */
    desktopLayoutMap: BakedLayoutMap | null;
    /** Mobile baked layout map (marker → props). Collected during the mobile viewport pass. */
    mobileLayoutMap: BakedLayoutMap | null;
  };
}

interface CapturePerViewportArgs {
  page: Page;
  viewport: Viewport;
  plan: ArtifactPlan;
  url: string;
  slug: string;
  archetype: string;
  settleMs: number;
  screenshotTimeoutMs: number;
  evaluateTimeoutMs: number;
  failures: FailureEntry[];
  entry: ManifestEntry;
  aggregator: SiteAnalysisAggregator;
  shouldAnalyze: boolean;
  designCtx?: DesignCaptureContext;  // present when design capture is enabled
  outputDir: string;
}

async function capturePerViewport(args: CapturePerViewportArgs): Promise<void> {
  const {
    page, viewport, plan, url, slug, archetype,
    settleMs, screenshotTimeoutMs, evaluateTimeoutMs,
    failures, entry, aggregator, shouldAnalyze,
    designCtx, outputDir,
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
        // Plain viewport-sized screenshot of the now-scrolled page.
        // fullPage:false captures the current viewport — no clip needed.
        // (A clip would have to be inside the 0..viewport.height image, not at
        // the page's absolute scroll position.)
        const buf = await withScreenshotTimeout(
          page.screenshot({ fullPage: false, type: 'png' }),
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
  if (isDesktop && shouldAnalyze) {
    try {
      const analysis = await analyzePage(page, evaluateTimeoutMs);
      entry.metadata = analysis.metadata;
      aggregator.add(url, analysis);
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

  // --- desktop-only design capture (page/post archetypes only) ---------------
  if (isDesktop && designCtx) {
    try {
      // The design sidecar slug MUST match the WXR item slug used by adapters
      // (item.slug = slugify(url)) so flushPendingImports can find the sidecar
      // by entry.slug. The manifest `slug` may have a collision suffix (-2, -3)
      // when multiple URLs share the same base, so we derive the design sidecar
      // slug directly from the URL — same derivation the adapters use.
      const designSlug = slugify(url);
      const designResult = await captureDesignForUrl({
        page,
        url,
        slug: designSlug,
        archetype,
        outputDir,
        baseUrl: designCtx.baseUrl,
        includeScripts: designCtx.includeScripts,
        cssAgg: designCtx.cssAgg,
        jsAgg: designCtx.jsAgg,
        headLinks: designCtx.headLinks,
        chromeAccum: designCtx.chromeAccum,
      });
      if (designResult) {
        for (const u of designResult.cssMediaUrls) designCtx.cssMediaUrls.add(u);
      }
    } catch (err) {
      // Non-fatal — design capture failure does not fail the screenshot run
      // (captureDesignForUrl already catches + logs internally; this guard
      // catches any unexpected throw from the orchestration layer itself)
      console.error(`[design] unexpected error for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- mobile-only chrome layout collection (dual-viewport bake) ------------
  // Collect the mobile computed layout for the chrome using the marker classes
  // assigned during the desktop pass. Only runs once — after the desktop pass
  // has established the chromeAccum with a desktopLayoutMap AND the mobile
  // layout hasn't been collected yet.
  //
  // Limitation: if Wix (or similar) renders a different chrome DOM at mobile
  // (hamburger menu), collectMobileChromeLayout returns null (no markers found)
  // and mobileLayoutMap stays null. generateChromeCss then emits desktop-only
  // rules. The static hamburger is not interactive — known limitation.
  if (!isDesktop && designCtx && designCtx.chromeAccum.desktopLayoutMap !== null && designCtx.chromeAccum.mobileLayoutMap === null) {
    try {
      const mobileMap = await collectMobileChromeLayout(page);
      if (mobileMap && Object.keys(mobileMap).length > 0) {
        designCtx.chromeAccum.mobileLayoutMap = mobileMap;
      }
    } catch (err) {
      // Non-fatal — mobile chrome layout collection failure degrades to desktop-only CSS.
      console.error(`[design] mobile chrome layout collection failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function selectRepresentativeAnalysisUrl(urls: string[]): string | null {
  if (urls.length === 0 || ANALYSIS_SAMPLE_LIMIT <= 0) return null;
  return urls.find((url) => classifyUrl(url) === 'homepage') ?? urls[0];
}

function hasSingleUrlAggregate(outputDir: string): boolean {
  const files = ['palette.json', 'typography.json', 'breakpoints.json'];
  for (const file of files) {
    try {
      const path = join(outputDir, file);
      if (!existsSync(path)) return false;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sampledUrls?: unknown };
      if (parsed.sampledUrls !== ANALYSIS_SAMPLE_LIMIT) return false;
    } catch {
      return false;
    }
  }
  return true;
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
  const rawConcurrency = opts.concurrency ?? 6;
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
  const representativeAnalysisUrl = selectRepresentativeAnalysisUrl(urls);

  // --- same-origin ---------------------------------------------------------
  // Normalize `primaryUrl` to include a protocol — callers sometimes pass
  // the bare hostname the user typed (e.g. `maus.com`), matching the
  // forgiving convention in fetchSitemap.
  const primaryRef = opts.primaryUrl
    ? (opts.primaryUrl.includes('://') ? opts.primaryUrl : `https://${opts.primaryUrl}`)
    : null;
  enforceSameOrigin(primaryRef, urls);

  // --- output layout -------------------------------------------------------
  mkdirSync(join(opts.outputDir, 'screenshots', 'desktop'), { recursive: true });
  mkdirSync(join(opts.outputDir, 'screenshots', 'mobile'), { recursive: true });
  mkdirSync(join(opts.outputDir, 'html'), { recursive: true });

  // --- manifest -----------------------------------------------------------
  const manifestPath = join(opts.outputDir, 'screenshots', 'manifest.json');
  const manifest = new ManifestQueue(manifestPath);
  await manifest.init();
  if (force) await manifest.resetFailures();

  // --- site-analysis aggregator -------------------------------------------
  // Collects palette/typography/breakpoints for one representative URL
  // (homepage when present). The design-foundation fast path uses this as
  // directional evidence; full-page screenshots still get captured for
  // later per-page/template work.
  const aggregator = new SiteAnalysisAggregator();
  const aggregateAlreadyFresh = !force && hasSingleUrlAggregate(opts.outputDir);

  // --- design capture aggregators (run-level) --------------------------------
  // Constructed once per run; populated during the per-URL capture pass.
  // Only active when opts.captureDesign is true.
  const includeScripts = opts.includeScripts ?? false;
  // Derive a stable base URL from the URL list for first-party checks.
  // Fall back to a bare origin of the first URL if primaryUrl isn't provided.
  const baseUrl = opts.primaryUrl
    ? (opts.primaryUrl.includes('://') ? opts.primaryUrl : `https://${opts.primaryUrl}`)
    : (() => {
        try { const u = new URL(urls[0] ?? 'https://localhost'); return `${u.protocol}//${u.host}`; } catch { return 'https://localhost'; }
      })();
  const cssAgg = new CssAggregator();
  const jsAgg = includeScripts ? new JsAggregator(baseUrl) : undefined;
  const headLinks = new Set<string>();
  const cssMediaUrls = new Set<string>();
  if (opts.captureDesign) {
    cssAgg.init(opts.outputDir);
  }
  const chromeAccum = {
    headerHtml: null as string | null,
    footerHtml: null as string | null,
    desktopLayoutMap: null as BakedLayoutMap | null,
    mobileLayoutMap: null as BakedLayoutMap | null,
  };
  const designCtx: DesignCaptureContext | undefined = opts.captureDesign
    ? { cssAgg, jsAgg, headLinks, cssMediaUrls, baseUrl, includeScripts, chromeAccum }
    : undefined;

  // --- browser -----------------------------------------------------------
  let browser: Browser = await connectBrowser({ cdpPort: opts.cdpPort }) as unknown as Browser;
  let browserRestarts = 0;
  let urlsSinceRestart = 0;

  let captured = 0;
  let skipped = 0;
  let completed = 0;
  const totalUrls = urls.length;
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
    const shouldAnalyzeUrl = url === representativeAnalysisUrl && !aggregateAlreadyFresh;
    const desktopPlan = shouldAnalyzeUrl
      ? { ...plan.desktop, needsLoad: true }
      : plan.desktop;
    const effectivePlan = { ...plan, desktop: desktopPlan };

    if (!effectivePlan.desktop.needsLoad && !effectivePlan.mobile.needsLoad) {
      skipped++;
      sendLog(server, `[skip] ${url} (artifacts exist)`);
      completed++;
      opts.onProgress?.(completed, totalUrls, url);
      return;
    }

    const entry: ManifestEntry = { slug, capturedAt: capturedAt() };
    const urlFailures: FailureEntry[] = [];

    for (const viewport of viewports) {
      const vpPlan = viewport.id === 'desktop' ? effectivePlan.desktop : effectivePlan.mobile;
      if (!vpPlan.needsLoad) continue;

      let context: BrowserContext | undefined;
      try {
        // deviceScaleFactor < 1 reduces the OUTPUT pixel count of every
        // screenshot while keeping the rendered layout identical to a
        // standard desktop session — the browser still does its layout
        // pass at the logical viewport (so CSS media queries hit their
        // real desktop branch), but emits a smaller PNG. Mobile stays at
        // scale 1 because its viewport is already small enough that
        // further reduction loses layout detail. See types.ts for the
        // rationale.
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.id === 'desktop' ? SCREENSHOT_DEVICE_SCALE_FACTOR : 1,
          ignoreHTTPSErrors: true,
        });
        // tsx/esbuild's keepNames transform wraps named const arrows with
        // `__name(fn, 'name')` calls; that helper doesn't exist in the browser
        // context. Polyfill as a no-op so our evaluate() closures can run.
        // String-form init script bypasses tsx transformation entirely.
        await context.addInitScript(`
          if (typeof globalThis.__name === 'undefined') {
            globalThis.__name = function (fn) { return fn; };
          }
        `);
        const page = await context.newPage();
        await capturePerViewport({
          page,
          viewport,
          plan: vpPlan,
          url,
          slug,
          archetype: classifyUrl(url),
          settleMs,
          screenshotTimeoutMs,
          evaluateTimeoutMs,
          failures: urlFailures,
          entry,
          aggregator,
          shouldAnalyze: shouldAnalyzeUrl,
          designCtx,
          outputDir: opts.outputDir,
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
    completed++;
    opts.onProgress?.(completed, totalUrls, url);
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
    if (aggregator.hasSamples()) {
      try { aggregator.serialize(opts.outputDir); } catch (err) {
        sendLog(server, `[warn] aggregator serialize failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Serialize design CSS aggregate if any pages/posts were captured
    if (designCtx && designCtx.cssAgg.toString().trim()) {
      try { designCtx.cssAgg.serialize(opts.outputDir); } catch (err) {
        sendLog(server, `[warn] design cssAgg serialize failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Serialize design JS aggregate when includeScripts=true and content was collected
    if (designCtx && designCtx.jsAgg) {
      const jsText = designCtx.jsAgg.toString().trim();
      if (jsText) {
        try {
          writeFileSync(join(opts.outputDir, 'site.js'), jsText, 'utf8');
        } catch (err) {
          sendLog(server, `[warn] design jsAgg serialize failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    try { await browser.close(); } catch { /* best-effort */ }
  }

  const siteCssPath = designCtx && designCtx.cssAgg.toString().trim()
    ? join(opts.outputDir, 'site.css')
    : undefined;

  const siteJsTextRaw = designCtx?.jsAgg?.toString().trim();
  const siteJsText = siteJsTextRaw || undefined;

  // --- generate responsive chrome.css from dual-viewport layout maps ----------
  // Emit @media min-width:768px (desktop) + @media max-width:767px (mobile)
  // rules keyed on .dla-fx-N marker classes. Gracefully degrades to desktop-only
  // when mobile layout was not collected (different DOM, mobile capture failed,
  // or captureDesign=false).
  let chromeCssText: string | undefined;
  if (designCtx?.chromeAccum.desktopLayoutMap) {
    const css = generateChromeCss(
      designCtx.chromeAccum.desktopLayoutMap,
      designCtx.chromeAccum.mobileLayoutMap ?? undefined,
    );
    if (css.trim()) {
      chromeCssText = css;
      try {
        writeFileSync(join(opts.outputDir, 'chrome.css'), css, 'utf8');
      } catch (err) {
        sendLog(server, `[warn] chrome.css write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    captured,
    skipped,
    failed: allFailures.length,
    browserRestarts,
    durationMs: Date.now() - startTime,
    manifestPath,
    siteCssPath,
    cssMediaUrls: designCtx ? [...designCtx.cssMediaUrls] : undefined,
    headLinks: designCtx ? [...designCtx.headLinks] : undefined,
    siteJsText,
    headerHtml: designCtx?.chromeAccum.headerHtml ?? undefined,
    footerHtml: designCtx?.chromeAccum.footerHtml ?? undefined,
    chromeCssText,
  };
}
