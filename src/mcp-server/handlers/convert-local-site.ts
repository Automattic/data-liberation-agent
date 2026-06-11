// src/mcp-server/handlers/convert-local-site.ts
//
// liberate_convert_local_site
// ===========================
// Stage 1b+1c of the owned-source path: take a local static site through to a
// LIVE Studio site — reuse stage 1a (ingest → composed sidecars), optionally
// capture the source site's design tokens + screenshots, assemble the local
// block theme (nav-graph header, captured footer, foundation-styled, no-title
// page templates), write + activate it, create WP Pages from the sidecars
// (idempotent via _source_url), set the front page, assign the page-local
// template, optionally capture the WP replica and score parity.
//
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Handler } from '../handler-types.js';
import { ingestLocalSiteHandler } from './ingest-local-site.js';
import { themeCacheFlushCommands } from './install-theme.js';
import { ingestLocalSite } from '../../lib/replicate/local-site/ingest.js';
import { buildNavGraph } from '../../lib/replicate/local-site/nav-graph.js';
import { segmentPage } from '../../lib/replicate/normalize/segment.js';
import { buildHeaderPart, buildFooterPart } from '../../lib/replicate/local-theme/chrome-parts.js';
import { assembleLocalTheme } from '../../lib/replicate/local-theme/theme-files.js';
import { buildPagePlan } from '../../lib/replicate/local-theme/page-plan.js';
import { writeReplicaFilesToHost } from '../../lib/preview/replica-install.js';
import { wpOptionUpdatesForSiteMeta } from '../../lib/preview/site-options.js';
import { installPost } from '../../lib/streaming/post-install.js';
import { finalizeSite } from '../../lib/streaming/site-finalize.js';
import { startStaticServer } from '../../lib/replicate/local-site/static-server.js';
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
import { SCREENSHOT_DEVICE_SCALE_FACTOR } from '../../lib/screenshot/types.js';
import { compareScreenshotDirs } from '../../lib/screenshot/compare.js';
import { buildLocalFoundation, extractCssColors, type PaletteAgg, type TypographyAgg, type BreakpointsAgg } from '../../lib/replicate/local-theme/foundation.js';
import { extractGoogleFontCssUrls, selfHostGoogleFonts } from '../../lib/replicate/local-theme/google-fonts.js';
import { collectSourceAssets, WP_COMPAT_CSS } from '../../lib/replicate/local-theme/source-assets.js';
import { detectBehaviors } from '../../lib/replicate/normalize/detect-behaviors.js';
import { buildInteractivityPlugin, PLUGIN_SLUG } from '../../blocks/interactivity-plugin.js';
import type { DetectedBehaviors } from '../../lib/replicate/local-site/types.js';
import { FREEZE_MOTION_CSS, probePair, type Divergence } from '../../lib/replicate/parity/parity-probe.js';
import { extractDiffRegions } from '../../lib/replicate/parity/diff-regions.js';
import { classifyDivergences, renderPatchCss, divergenceFingerprint, type UnresolvedDivergence, type PatchOverride, type RepairPlan } from '../../lib/replicate/parity/parity-classify.js';

const execFileAsync = promisify(execFile);

/** Studio layouts: wp-content at the site root or under wordpress/. */
function resolveWpRoot(studioSitePath: string): string | null {
  if (existsSync(join(studioSitePath, 'wp-content'))) return studioSitePath;
  if (existsSync(join(studioSitePath, 'wordpress', 'wp-content'))) return join(studioSitePath, 'wordpress');
  return null;
}

async function studioWp(sitePath: string, wpArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync('studio', ['wp', '--path', sitePath, ...wpArgs], {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export const convertLocalSiteHandler: Handler = async (args, ctx) => {
  const dir = args.dir as string | undefined;
  const studioSitePath = args.studioSitePath as string | undefined;
  const outputDir = (args.outputDir as string | undefined) ?? dir;
  if (!dir) return ctx.errorResult('dir is required');
  if (!studioSitePath) return ctx.errorResult('studioSitePath is required');
  if (!outputDir) return ctx.errorResult('outputDir is required');

  const wpRoot = resolveWpRoot(studioSitePath);
  if (!wpRoot) return ctx.errorResult(`no wp-content found under ${studioSitePath} (or its wordpress/ subdir)`);

  const skipDesign = args.skipDesign === true;
  const skipCompare = args.skipCompare === true;
  const repair = args.repair !== false;
  const maxRepairRounds = Math.min(Math.max(Number(args.maxRepairRounds ?? 2), 0), 5);
  // Stage 1d: carry the source site's own CSS/JS into the theme so the class-
  // preserving block DOM renders under the designer's stylesheet. Default ON
  // (identical replication goal); pass carryCss:false / carryJs:false to opt out.
  const carryCss = args.carryCss !== false;
  // Replica base URL: explicit arg wins; otherwise auto-resolved AFTER theme
  // activation via `wp option get siteurl` (see below) — Studio assigns random
  // ports per site, so a hardcoded default would capture the WRONG site and
  // report silently bogus parity.
  let wpUrl = (args.wpUrl as string | undefined)?.replace(/\/$/, '');

  const warnings: string[] = [];

  // nativeBehaviors replaces carried source JS with Interactivity blocks —
  // both at once would double-drive every behavior (double-init sliders,
  // re-animating reveals). Explicit carryJs:true is overridden, loudly.
  const nativeBehaviors = args.nativeBehaviors === true;
  if (nativeBehaviors && args.carryJs === true) {
    warnings.push('nativeBehaviors forces carryJs off (carried source JS would double-drive block behaviors)');
  }
  const carryJs = nativeBehaviors ? false : args.carryJs !== false;

  // Stage 1a: ingest + compose sidecars + normalize-report (reuse the handler
  // verbatim; nativeBehaviors makes it tag sidecar sections with dla/reveal).
  const ingestRes = await ingestLocalSiteHandler({ dir, outputDir, nativeBehaviors }, ctx);
  if (ingestRes.isError) return ingestRes;
  // Forward stage-1a quality signals into the final summary, nested under one
  // `ingest` key so the two summaries' field shapes can't collide.
  const ingestSummary = JSON.parse(ingestRes.content[0].text) as {
    lowConfidence: number;
    failedPageCount: number;
    failedPagesList: Array<{ slug: string; error: string }>;
  };
  const ingest = {
    lowConfidence: ingestSummary.lowConfidence,
    failedPageCount: ingestSummary.failedPageCount,
    failedPagesList: ingestSummary.failedPagesList,
  };

  // Second ingest is deterministic + cheap (same dir, no writes between); the
  // handler call above already surfaced any slug-collision error.
  const site = ingestLocalSite(dir);
  const siteTitle = (args.siteTitle as string | undefined) ?? site.pages.find((p) => p.slug === 'home')?.title ?? 'Local Site';
  const themeSlug = (args.themeSlug as string | undefined) ?? 'local-site-theme';

  // Stage 1c — Design capture (unless skipDesign): serve the local site over
  // HTTP, run the screenshot pipeline to collect palette/typography/breakpoints
  // aggregates, build a deterministic design foundation, and self-host any
  // Google Fonts found in the source HTML/CSS. Failures here degrade to a
  // warning and fall back to the default foundation — never abort.
  let foundation: Parameters<typeof assembleLocalTheme>[0]['foundation'];
  let capturedFonts: Parameters<typeof assembleLocalTheme>[0]['capturedFonts'];
  let footerBgToken: string | undefined;
  let footerTextToken: string | undefined;
  let localizedFontCss = '';
  let designCaptured = false;
  const sourceCaptureDir = join(outputDir, 'source');

  // Deterministic parity captures: the source's reveal animations (html.js
  // opacity/translate transitions) race the screenshot on BOTH sides, jittering
  // pixelmatch scores run-to-run. Freeze all animation and force the revealed
  // end-state symmetrically — the comparison measures design, not motion timing.
  // Shared with the parity probe so probe-state == capture-state.
  const freezeMotion = async (page: import('playwright').Page): Promise<void> => {
    await page.addStyleTag({ content: FREEZE_MOTION_CSS });
  };

  if (!skipDesign) {
    let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
    try {
      server = await startStaticServer(dir);
      // Use relPath-based URLs so nested pages resolve: slug-based pageUrl('blog-post')
      // would 404 on a source that has blog/post.html (Task-1 review C1).
      const sourceUrls = site.pages.map((p) => server!.urlForPage(p.relPath));
      await captureScreenshots({
        urls: sourceUrls,
        outputDir: sourceCaptureDir,
        primaryUrl: server.url,
        captureDesign: true,
        concurrency: 2,
        prepareCapture: freezeMotion,
      });
      const readJson = <T>(name: string): T =>
        JSON.parse(readFileSync(join(sourceCaptureDir, name), 'utf8')) as T;
      // Source CSS/HTML text serves two consumers: hex-literal accent
      // candidates for the foundation (the aggregator samples CONTAINER
      // backgrounds only, so an accent living on a.button never reaches
      // palette.json — but we own the authored CSS) and Google-Fonts css2
      // link discovery below.
      const cssSources = site.pages.map((p) => p.html);
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.css')) cssSources.push(readFileSync(join(dir, f), 'utf8'));
      }
      const local = buildLocalFoundation(
        {
          palette: readJson<PaletteAgg>('palette.json'),
          typography: readJson<TypographyAgg>('typography.json'),
          breakpoints: readJson<BreakpointsAgg>('breakpoints.json'),
        },
        { cssColors: extractCssColors(cssSources) },
      );
      foundation = local.foundation;
      footerBgToken = local.footerBgToken;
      footerTextToken = local.footerTextToken;

      const fontCssUrls = extractGoogleFontCssUrls(cssSources);
      if (fontCssUrls.length > 0) {
        const hosted = await selfHostGoogleFonts(fontCssUrls, { themeDir: join(outputDir, 'theme') });
        capturedFonts = hosted.faces;
        // Verbatim Google css (all unicode-range subsets, URLs localized) —
        // spliced into the carried stylesheet so glyph metrics match the
        // source exactly (the old one-file-per-weight collapse measurably
        // narrowed Fraunces/Work Sans and shifted every wrap point).
        localizedFontCss = hosted.localizedCss;
        for (const e of hosted.errors) warnings.push(`font self-host failed: ${e.url}: ${e.error}`);
      }

      designCaptured = true;
    } catch (err) {
      warnings.push(`design capture failed (default styling used): ${(err as Error).message}`);
    } finally {
      await server?.close();
    }
  }

  // Stage 1d: collect source CSS/JS from disk (link-driven, document order).
  // Runs regardless of skipDesign — assets live on disk, no Playwright needed.
  // When both flags are off, carrySourceAssets stays undefined (tokens-only theme).
  // nativeBehaviors also needs the collected assets (detection input) even when
  // nothing is carried, without turning carrySourceAssets into a defined-but-
  // empty object (that would change theme assembly).
  let carrySourceAssets: { css: string; js: string } | undefined;
  let behaviors: DetectedBehaviors | undefined;
  if (carryCss || carryJs || nativeBehaviors) {
    const assets = collectSourceAssets(dir, site.pages.map((p) => ({ relPath: p.relPath, html: p.html })));
    if (carryCss || carryJs) {
      // Splice the localized Google-font css (verbatim subsets, local URLs)
      // right after the compat layer — same cascade position the stripped
      // @import occupied, so font resolution matches the source byte-for-byte.
      const cssWithFonts = localizedFontCss
        ? assets.css.replace(WP_COMPAT_CSS, WP_COMPAT_CSS + localizedFontCss + '\n\n')
        : assets.css;
      carrySourceAssets = {
        css: carryCss ? cssWithFonts : '',
        js: carryJs ? assets.js : '',
      };
    }
    // Detection runs on the RAW collected strings — assets.css includes the
    // prepended WP_COMPAT_CSS, which is detection-immune (no html.js section
    // gate, no scroll-listener patterns; reviewer-verified). Mirrors the
    // ingest handler's detection exactly (same pure fn, same inputs).
    behaviors = nativeBehaviors ? detectBehaviors({ css: assets.css, js: assets.js }) : undefined;
  }

  // Behavior gaps artifact: every uncatalogued source-JS pattern, reported
  // (never guessed). Atomic tmp+rename like the sibling reports.
  if (behaviors) {
    const gapsPath = join(outputDir, 'behavior-gaps.json');
    const gapsTmp = `${gapsPath}.tmp.${process.pid}`;
    try {
      writeFileSync(gapsTmp, JSON.stringify({ schema: 1, site: dir, gaps: behaviors.gaps }, null, 2) + '\n');
      renameSync(gapsTmp, gapsPath);
    } catch (err) {
      try { unlinkSync(gapsTmp); } catch { /* ignore */ }
      warnings.push(`behavior-gaps write failed: ${(err as Error).message}`);
    }
  }
  // The carried stylesheet is the design authority for chrome too: plain parts
  // (bare blocks, no styled wrappers/tokens) so the source `header{}`/`footer{}`
  // rules — which match the template parts' real <header>/<footer> elements —
  // drive layout instead of fighting our decoration.
  const chromeCarried = !!carrySourceAssets?.css.trim() && carryCss;

  // Chrome: nav from the graph; footer from the home page's captured footer section.
  const nav = buildNavGraph(site);
  const home = site.pages.find((p) => p.slug === 'home') ?? site.pages[0];
  const footerSection = segmentPage(home.html).find((s) => s.role === 'footer') ?? null;
  // Sticky rides the header part in plain (carry) mode only — buildHeaderPart
  // ignores it otherwise (tokens path has no carried chrome to toggle).
  // Honesty: when detection found sticky but chrome is not carried, the state
  // block never lands — warn, and the summary reports what LANDED (sticky:
  // stickyEmitted), not what detection found.
  const stickyEmitted = !!behaviors?.sticky && chromeCarried;
  if (behaviors?.sticky && !chromeCarried) {
    warnings.push('sticky behavior detected but not emitted (requires carried chrome header)');
  }
  const headerPart = buildHeaderPart(siteTitle, nav, site.pages.map((p) => p.slug), {
    plain: chromeCarried,
    ...(behaviors?.sticky ? { sticky: behaviors.sticky } : {}),
  });
  // Footer tokens (bgToken/textToken) come from the foundation — they style the
  // wrapper group in the footer part we build here. The assembleLocalTheme
  // passthrough was proven inert (we swap parts/footer.html unconditionally),
  // so tokens live exclusively on the part built by buildFooterPart. In carry
  // mode the tokens are omitted — source footer{} rules style the part.
  const footerPart = buildFooterPart(footerSection, siteTitle, {
    pageSlugs: site.pages.map((p) => p.slug),
    bgToken: chromeCarried ? undefined : footerBgToken,
    textToken: chromeCarried ? undefined : footerTextToken,
  });

  // Theme assembly + write + activate.
  // In carry mode the localized Google css inside source.css is the SOLE font
  // authority — passing capturedFonts too makes the scaffold's style.css emit
  // range-less duplicate faces pointing at single subset files; Chromium then
  // resolves ch against a face whose '0' glyph is absent (spec fallback 0.5em),
  // shrinking every ch-based max-width (walrus: 62ch = 527px vs 655px) while
  // text still shapes correctly via the next face. One authority, no overlap.
  const themeFiles = assembleLocalTheme({
    siteTitle,
    themeSlug,
    headerPart,
    footerPart,
    foundation,
    capturedFonts: chromeCarried ? undefined : capturedFonts,
    carrySourceAssets,
  });
  let themeWritten = 0;
  try {
    // assetSourceDir carries downloaded fonts (woff2) into the live theme so the
    // install is self-contained without a separate binary-copy step.
    // nativeBehaviors ships the static dla-interactivity block plugin alongside
    // the theme. Accepted v1 trade-off (user decision 2026-06-11): the editor
    // shows a missing-block placeholder for dla/* sections (no editor script);
    // the frontend renders + behaves fully.
    themeWritten = writeReplicaFilesToHost({
      wpRoot,
      themeSlug,
      themeFiles,
      assetSourceDir: join(outputDir, 'theme'),
      ...(nativeBehaviors ? { blockPlugins: [buildInteractivityPlugin()] } : {}),
    }).themeWritten;
  } catch (err) {
    return ctx.errorResult(`theme write failed: ${(err as Error).message}`);
  }
  try {
    await studioWp(studioSitePath, ['theme', 'activate', themeSlug]);
  } catch (err) {
    warnings.push(`theme activate failed: ${(err as Error).message}`);
  }
  // The dla/* blocks must be registered server-side before any page renders
  // them (SSR directive processing rides supports.interactivity). Mirrors the
  // theme-activate degrade-to-warning contract.
  if (nativeBehaviors) {
    try {
      await studioWp(studioSitePath, ['plugin', 'activate', PLUGIN_SLUG]);
    } catch (err) {
      warnings.push(`plugin activate failed for ${PLUGIN_SLUG}: ${(err as Error).message}`);
    }
  }
  // Resolve the replica base URL now that the site is known reachable
  // (activation just ran against it). Failure degrades to the conventional
  // wp-env default with a warning — never aborts.
  if (!wpUrl) {
    try {
      wpUrl = (await studioWp(studioSitePath, ['option', 'get', 'siteurl'])).trim().replace(/\/$/, '');
    } catch (err) {
      wpUrl = 'http://localhost:8889';
      warnings.push(`siteurl resolve failed, using ${wpUrl}: ${(err as Error).message}`);
    }
  }
  // Flush caches so the freshly-written templates + customTemplates register
  // immediately (install-theme.ts precedent: block themes cache template
  // resolution and the patterns file list; without a flush the just-activated
  // theme can serve stale/empty versions). Best-effort — warn, never fatal.
  for (const wpArgs of themeCacheFlushCommands()) {
    try {
      await studioWp(studioSitePath, wpArgs);
    } catch (err) {
      warnings.push(`cache flush failed (${wpArgs.slice(0, 2).join(' ')}): ${(err as Error).message}`);
    }
  }
  // Pages from sidecars (installPost is idempotent via _source_url meta).
  const plan = buildPagePlan(site, outputDir);
  const emptySidecars = plan.items.filter((i) => !i.content.trim()).map((i) => i.slug);
  const installed: Array<{ slug: string; postId: number | null }> = [];
  const failedInstalls: Array<{ slug: string; error: string }> = [];
  for (const item of plan.items) {
    try {
      const res = await installPost({ item, outputDir, studioSitePath });
      if (!res || res.action === 'error') {
        failedInstalls.push({ slug: item.slug, error: res?.error ?? 'unsupported item' });
      } else {
        installed.push({ slug: item.slug, postId: res.postId });
      }
    } catch (err) {
      failedInstalls.push({ slug: item.slug, error: (err as Error).message });
    }
  }

  // Site finalize — blogname option, per-page _wp_page_template assigns, and
  // the front-page pair — consolidated into ONE `wp eval-file` round-trip
  // (site-finalize.ts). Studio's IPC layer flakes on bursts of individual
  // argv `studio wp` commands ("No activity for 120s") while eval-file calls
  // (the installPost shape: one IPC slot, values via JSON file) succeed
  // reliably. On a fresh site a dropped blogname (site-title block renders
  // the wrong brand) or template assign (wrong template) is a STRUCTURAL
  // parity failure the repair loop cannot fix — these writes ride the
  // reliable channel. studioWp stays for activate + cache-flush (constant-arg
  // calls that never flaked).
  // Runs AFTER theme activation (the page-local customTemplate must be
  // registered before _wp_page_template assignment resolves) and AFTER the
  // installPost loop (it needs the postIds).
  let frontPageSet = false;
  {
    // The header's core/site-title renders the blogname option — without this
    // the converted site shows the Studio default name, not the ingested title.
    // wpOptionUpdatesForSiteMeta normalizes + skips empty titles (no tagline
    // source in the local-site path, so this emits exactly the blogname update).
    const finalizeOptions: Record<string, string> = {};
    for (const [option, value] of wpOptionUpdatesForSiteMeta({ title: siteTitle })) {
      finalizeOptions[option] = value;
    }
    const templateAssigns = installed
      .filter((p) => p.postId != null)
      .map((p) => ({ postId: p.postId as number, slug: p.slug, template: 'page-local' }));
    const homeInstall = installed.find((p) => p.slug === plan.homeSlug);
    const frontPageId = homeInstall?.postId != null ? homeInstall.postId : undefined;
    try {
      const finalize = await finalizeSite({
        payload: {
          options: finalizeOptions,
          templateAssigns,
          ...(frontPageId !== undefined ? { frontPageId } : {}),
        },
        studioSitePath,
      });
      frontPageSet = finalize.applied.frontPage;
      // Per-item failures map to the SAME warning prefixes the old per-command
      // path emitted, so existing log greps and tests keep working.
      for (const e of finalize.errors) {
        if (e.item.startsWith('option:')) {
          warnings.push(`${e.item.slice('option:'.length)} set failed: ${e.error}`);
        } else if (e.item.startsWith('template:')) {
          warnings.push(`template assign failed for ${e.item.slice('template:'.length)}: ${e.error}`);
        } else if (e.item === 'frontPage') {
          warnings.push(`front page set failed: ${e.error}`);
        } else {
          warnings.push(`site finalize ${e.item} failed: ${e.error}`);
        }
      }
    } catch (err) {
      // Whole-call failure (exec/timeout/garbage stdout): one warning listing
      // everything that was attempted; frontPageSet stays false.
      const attempted = [
        ...Object.keys(finalizeOptions).map((o) => `option ${o}`),
        ...templateAssigns.map((t) => `template ${t.slug}`),
        ...(frontPageId !== undefined ? ['front page'] : []),
      ];
      warnings.push(`site finalize failed (attempted: ${attempted.join(', ')}): ${(err as Error).message}`);
    }
  }

  // Stage 1c — Compare: capture the WP replica and score parity against the
  // source screenshots. Skipped when skipDesign or skipCompare, or when design
  // capture failed (no source screenshots to compare against).
  // KNOWN LIMITATION (flat sites unaffected): nested pages compare-join by
  // pathname will miss — source serves /blog/post/ (relPath) while the WP
  // permalink is /blog-post/ (joined slug). Real fix = create WP pages with
  // parent hierarchy mirroring relPath (later stage). Nested pages appear in
  // source capture but produce missing-replica rows in the comparison output —
  // visible, not silent.
  const PARITY_FLOOR = 0.99;
  // Hoisted so the repair loop can re-capture and re-compare without recomputing.
  const replicaCaptureDir = join(outputDir, 'replica');
  const replicaUrls = installed
    .filter((p) => p.postId != null)
    .map((p) => (p.slug === plan.homeSlug ? `${wpUrl}/` : `${wpUrl}/${p.slug}/`));
  let parity:
    | {
        floor: number;
        allPass: boolean;
        avgDesktop: number;
        avgMobile: number;
        pages: Array<{ pathname: string; desktop: number | null; mobile: number | null; passes: boolean }>;
        repair?: { rounds: number; overrides: number; unresolved: UnresolvedDivergence[]; converged: boolean };
      }
    | undefined;
  if (!skipDesign && !skipCompare && designCaptured) {
    try {
      await captureScreenshots({
        urls: replicaUrls,
        outputDir: replicaCaptureDir,
        primaryUrl: wpUrl,
        concurrency: 2,
        prepareCapture: freezeMotion,
      });
      const comparison = await compareScreenshotDirs({
        originDir: join(sourceCaptureDir, 'screenshots'),
        replicaDir: join(replicaCaptureDir, 'screenshots'),
      });
      const scores = (v: 'desktop' | 'mobile'): number[] =>
        comparison.results.map((r) => r[v]?.score).filter((s): s is number => typeof s === 'number');
      const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const parityPages = comparison.results.map((r) => {
        const d = r.desktop?.score ?? null;
        const m = r.mobile?.score ?? null;
        return {
          pathname: r.pathname,
          desktop: d,
          mobile: m,
          passes: d !== null && m !== null && d >= PARITY_FLOOR && m >= PARITY_FLOOR,
        };
      });
      parity = {
        floor: PARITY_FLOOR,
        // Guard the vacuous case: zero compared pages must not report success.
        allPass: parityPages.length > 0 && parityPages.every((p) => p.passes),
        avgDesktop: avg(scores('desktop')),
        avgMobile: avg(scores('mobile')),
        pages: parityPages,
      };
      // Atomic write (tmp + rename) mirrors normalize-report convention.
      const reportPath = join(outputDir, 'parity-report.json');
      const tmp = `${reportPath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ schema: 1, comparison, parity }, null, 2) + '\n');
      renameSync(tmp, reportPath);
    } catch (err) {
      warnings.push(`compare failed: ${(err as Error).message}`);
    }
  }

  // Truthful carry summary (also gates the repair loop below): css=true only when
  // the CSS file was actually written; js=true only when the JS file was actually
  // written. WP_COMPAT_CSS is always non-empty so carryCss:true always yields
  // css:true when the flag is on.
  const carriedCss = carryCss && (carrySourceAssets?.css ?? '').trim().length > 0;
  const carriedJs = carryJs && (carrySourceAssets?.js ?? '').trim().length > 0;

  // Stage 1e — Deterministic parity repair loop (bounded, no AI).
  // Measure → classify → patch → re-capture → re-compare; stop on allPass,
  // maxRepairRounds, or unchanged divergence fingerprint (stuck). Every failure
  // degrades to a warning — the loop never aborts the conversion.
  // REQUIRES carried source css: the parity-patch enqueue rides the carry block
  // in functions.php, so without it the patch file would be written but never
  // loaded — the loop would burn every round with zero on-page effect.
  if (repair && parity && !parity.allPass && maxRepairRounds > 0 && !carriedCss) {
    warnings.push('repair skipped: requires carried source css (carryCss)');
  }
  if (repair && parity && !parity.allPass && maxRepairRounds > 0 && carriedCss) {
    let rounds = 0;
    let lastFingerprint: string | undefined;
    let converged = false;
    const allOverrides = new Map<string, PatchOverride>();
    let allUnresolved: UnresolvedDivergence[] = [];

    // TypeScript needs a local non-nullable reference for the loop (parity is
    // let and may be reassigned inside, preventing narrowing in the while cond).
    let currentParity = parity;

    while (!currentParity.allPass && rounds < maxRepairRounds) {
      const failingPages = currentParity.pages.filter((fp) => !fp.passes);

      // 1. Read replica manifest to resolve pathname → slug for diff-PNG paths.
      const manifestByPathname = new Map<string, string>();
      try {
        const manifestPath = join(replicaCaptureDir, 'screenshots', 'manifest.json');
        if (existsSync(manifestPath)) {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            version: 1;
            entries: Record<string, { slug: string }>;
          };
          for (const [url, entry] of Object.entries(m.entries)) {
            try { manifestByPathname.set(new URL(url).pathname, entry.slug); } catch { /* skip */ }
          }
        }
      } catch (err) {
        warnings.push(`repair round ${rounds}: manifest read failed: ${(err as Error).message}`);
        break;
      }

      // 2. Probe both sides for each failing page × viewport.
      const roundDivergences: Divergence[] = [];
      let repairServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
      let repairBrowser: import('playwright').Browser | undefined;
      let probeOk = true;
      try {
        repairServer = await startStaticServer(dir);
        const { chromium } = await import('playwright');
        repairBrowser = await chromium.launch();

        for (const failPage of failingPages) {
          const slug = manifestByPathname.get(failPage.pathname);
          if (!slug) continue;

          const sitePg = site.pages.find((sp) => {
            const rUrl = sp.slug === plan.homeSlug ? `${wpUrl}/` : `${wpUrl}/${sp.slug}/`;
            return new URL(rUrl).pathname === failPage.pathname;
          });
          if (!sitePg) continue;

          for (const vp of ['desktop', 'mobile'] as const) {
            const score = failPage[vp];
            if (score !== null && score >= PARITY_FLOOR) continue; // this viewport passes

            const diffPath = join(replicaCaptureDir, 'screenshots', 'diff', `${slug}.${vp}.diff.png`);
            if (!existsSync(diffPath)) continue;

            let regions: ReturnType<typeof extractDiffRegions>;
            try {
              // Same per-viewport scale the screenshotter applied when writing the
              // pngs (screenshotter.ts deviceScaleFactor) — png px → logical px.
              regions = extractDiffRegions(readFileSync(diffPath), {
                scale: vp === 'desktop' ? SCREENSHOT_DEVICE_SCALE_FACTOR : 1,
              });
            } catch { continue; }

            if (regions.length === 0) continue;

            const sourceUrl = repairServer.urlForPage(sitePg.relPath);
            const replicaUrl = sitePg.slug === plan.homeSlug ? `${wpUrl}/` : `${wpUrl}/${sitePg.slug}/`;
            try {
              const divs = await probePair({ browser: repairBrowser, sourceUrl, replicaUrl, viewport: vp, regions });
              roundDivergences.push(...divs);
            } catch (err) {
              warnings.push(`repair round ${rounds}: probe ${failPage.pathname} ${vp}: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        warnings.push(`repair round ${rounds}: probe setup failed: ${(err as Error).message}`);
        probeOk = false;
      } finally {
        await repairBrowser?.close();
        await repairServer?.close();
      }

      if (!probeOk) break;

      // 3. Classify + fingerprint (order-insensitive; same input → same bytes).
      const classifyResult = classifyDivergences(roundDivergences);
      const fp = divergenceFingerprint(roundDivergences);
      if (fp === lastFingerprint) {
        // Patching is not helping — stop and report. The previous round's patch
        // WAS generated and applied but left the divergence set unchanged, so
        // downstream reads this as converged:false with overrides > 0 — the
        // patch-generated-but-ineffective signal.
        // Replacement (not union): currently-blocking only — pages that
        // converged in earlier rounds drop out, unlike the override union.
        allUnresolved = classifyResult.unresolved;
        break;
      }
      lastFingerprint = fp;

      // Accumulate overrides across rounds (union; later rounds can add viewports).
      // The key includes the VALUE (mirrors classify's keying): a prop diverging
      // to different source values per viewport (hero font-size 64px desktop /
      // 32px mobile) must stay TWO overrides so renderPatchCss emits per-viewport
      // media rules — a value-less key would collapse them into one bare rule
      // applying the desktop value to mobile. Source values are stable across
      // rounds (static source pages), so same-viewport key conflicts can't arise.
      for (const o of classifyResult.overrides) {
        const key = `${o.selector}|${o.occurrence}|${o.prop}|${o.value}`;
        const existing = allOverrides.get(key);
        if (existing) {
          for (const v of o.viewports) {
            if (!existing.viewports.includes(v)) existing.viewports.push(v);
          }
        } else {
          allOverrides.set(key, { ...o, viewports: [...o.viewports] });
        }
      }
      // REPLACEMENT (not union) is deliberate: currently-blocking only — pages
      // that converged in earlier rounds drop out, unlike the override union.
      allUnresolved = classifyResult.unresolved;

      // 4. Render byte-stable patch from the accumulated union of overrides.
      const mergedPlan: RepairPlan = {
        overrides: [...allOverrides.values()].sort(
          (a, b) => a.selector.localeCompare(b.selector) || a.prop.localeCompare(b.prop),
        ),
        unresolved: allUnresolved,
      };
      const patchCss = renderPatchCss(mergedPlan);

      // 5. Write patch into live theme + output dir (atomic).
      try {
        writeReplicaFilesToHost({
          wpRoot,
          themeSlug,
          themeFiles: [{ relativePath: 'assets/css/parity-patch.css', content: patchCss }],
        });
        const patchOut = join(outputDir, 'parity-patch.css');
        const patchTmp = `${patchOut}.tmp.${process.pid}`;
        writeFileSync(patchTmp, patchCss);
        renameSync(patchTmp, patchOut);
      } catch (err) {
        warnings.push(`repair round ${rounds}: patch write failed: ${(err as Error).message}`);
        break;
      }

      // 6. Re-capture replica (force regenerates pngs) → re-compare.
      try {
        await captureScreenshots({
          urls: replicaUrls,
          outputDir: replicaCaptureDir,
          primaryUrl: wpUrl,
          concurrency: 2,
          prepareCapture: freezeMotion,
          force: true,
        });
        const comparison2 = await compareScreenshotDirs({
          originDir: join(sourceCaptureDir, 'screenshots'),
          replicaDir: join(replicaCaptureDir, 'screenshots'),
        });
        const parityPages2 = comparison2.results.map((r) => {
          const d = r.desktop?.score ?? null;
          const m = r.mobile?.score ?? null;
          return {
            pathname: r.pathname,
            desktop: d,
            mobile: m,
            passes: d !== null && m !== null && d >= PARITY_FLOOR && m >= PARITY_FLOOR,
          };
        });
        // Recompute the averages from THIS round's scores — carrying the
        // round-0 averages forward would report stale numbers after the patch
        // improved (or changed) the comparison.
        const r2scores = (k: 'desktop' | 'mobile'): number[] =>
          parityPages2.map((p) => p[k]).filter((s): s is number => s !== null);
        const r2avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
        currentParity = {
          ...currentParity,
          allPass: parityPages2.length > 0 && parityPages2.every((p) => p.passes),
          avgDesktop: r2avg(r2scores('desktop')),
          avgMobile: r2avg(r2scores('mobile')),
          pages: parityPages2,
        };
      } catch (err) {
        warnings.push(`repair round ${rounds}: re-compare failed: ${(err as Error).message}`);
        break;
      }

      rounds++;

      if (currentParity.allPass) {
        converged = true;
        break;
      }
    }

    parity = {
      ...currentParity,
      repair: { rounds, overrides: allOverrides.size, unresolved: allUnresolved, converged },
    };
  }

  return ctx.textResult({
    pages: plan.items.length,
    installed: installed.length,
    failedInstalls,
    missingSidecars: plan.missingSidecars,
    emptySidecars,
    ingest,
    themeSlug,
    themeWritten,
    frontPageSet,
    designCaptured,
    carried: { css: carriedCss, js: carriedJs },
    // Key OMITTED entirely when the flag is off — default summary stays byte-stable.
    // sticky reports EMISSION (stickyEmitted), not detection — see the header-part site.
    ...(behaviors !== undefined
      ? { behaviors: { reveal: !!behaviors.reveal, sticky: stickyEmitted, gaps: behaviors.gaps.length } }
      : {}),
    ...(parity !== undefined ? { parity } : {}),
    warnings,
  });
};
