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
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
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
import { startStaticServer } from '../../lib/replicate/local-site/static-server.js';
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
import { compareScreenshotDirs } from '../../lib/screenshot/compare.js';
import { buildLocalFoundation, extractCssColors, type PaletteAgg, type TypographyAgg, type BreakpointsAgg } from '../../lib/replicate/local-theme/foundation.js';
import { extractGoogleFontCssUrls, selfHostGoogleFonts } from '../../lib/replicate/local-theme/google-fonts.js';
import { collectSourceAssets } from '../../lib/replicate/local-theme/source-assets.js';

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
  // Stage 1d: carry the source site's own CSS/JS into the theme so the class-
  // preserving block DOM renders under the designer's stylesheet. Default ON
  // (identical replication goal); pass carryCss:false / carryJs:false to opt out.
  const carryCss = args.carryCss !== false;
  const carryJs = args.carryJs !== false;
  // Replica base URL: explicit arg wins; otherwise auto-resolved AFTER theme
  // activation via `wp option get siteurl` (see below) — Studio assigns random
  // ports per site, so a hardcoded default would capture the WRONG site and
  // report silently bogus parity.
  let wpUrl = (args.wpUrl as string | undefined)?.replace(/\/$/, '');

  const warnings: string[] = [];

  // Stage 1a: ingest + compose sidecars + normalize-report (reuse the handler verbatim).
  const ingestRes = await ingestLocalSiteHandler({ dir, outputDir }, ctx);
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
  let designCaptured = false;
  const sourceCaptureDir = join(outputDir, 'source');

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
        for (const e of hosted.errors) warnings.push(`font self-host failed: ${e.url}: ${e.error}`);
      }

      designCaptured = true;
    } catch (err) {
      warnings.push(`design capture failed (default styling used): ${(err as Error).message}`);
    } finally {
      await server?.close();
    }
  }

  // Chrome: nav from the graph; footer from the home page's captured footer section.
  const nav = buildNavGraph(site);
  const home = site.pages.find((p) => p.slug === 'home') ?? site.pages[0];
  const footerSection = segmentPage(home.html).find((s) => s.role === 'footer') ?? null;
  const headerPart = buildHeaderPart(siteTitle, nav, site.pages.map((p) => p.slug));
  // Footer tokens (bgToken/textToken) come from the foundation — they style the
  // wrapper group in the footer part we build here. The assembleLocalTheme
  // passthrough was proven inert (we swap parts/footer.html unconditionally),
  // so tokens live exclusively on the part built by buildFooterPart.
  const footerPart = buildFooterPart(footerSection, siteTitle, {
    pageSlugs: site.pages.map((p) => p.slug),
    bgToken: footerBgToken,
    textToken: footerTextToken,
  });

  // Stage 1d: collect source CSS/JS from disk (link-driven, document order).
  // Runs regardless of skipDesign — assets live on disk, no Playwright needed.
  // When both flags are off, carrySourceAssets stays undefined (tokens-only theme).
  let carrySourceAssets: { css: string; js: string } | undefined;
  if (carryCss || carryJs) {
    const assets = collectSourceAssets(dir, site.pages.map((p) => ({ relPath: p.relPath, html: p.html })));
    carrySourceAssets = {
      css: carryCss ? assets.css : '',
      js: carryJs ? assets.js : '',
    };
  }

  // Theme assembly + write + activate.
  const themeFiles = assembleLocalTheme({ siteTitle, themeSlug, headerPart, footerPart, foundation, capturedFonts, carrySourceAssets });
  let themeWritten = 0;
  try {
    // assetSourceDir carries downloaded fonts (woff2) into the live theme so the
    // install is self-contained without a separate binary-copy step.
    themeWritten = writeReplicaFilesToHost({
      wpRoot,
      themeSlug,
      themeFiles,
      assetSourceDir: join(outputDir, 'theme'),
    }).themeWritten;
  } catch (err) {
    return ctx.errorResult(`theme write failed: ${(err as Error).message}`);
  }
  try {
    await studioWp(studioSitePath, ['theme', 'activate', themeSlug]);
  } catch (err) {
    warnings.push(`theme activate failed: ${(err as Error).message}`);
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
  // The header's core/site-title renders the blogname option — without this
  // the converted site shows the Studio default name, not the ingested title.
  // wpOptionUpdatesForSiteMeta normalizes + skips empty titles (no tagline
  // source in the local-site path, so this emits exactly the blogname update).
  for (const [option, value] of wpOptionUpdatesForSiteMeta({ title: siteTitle })) {
    try {
      await studioWp(studioSitePath, ['option', 'update', option, value]);
    } catch (err) {
      warnings.push(`${option} set failed: ${(err as Error).message}`);
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

  // Front page + per-page template assignment (after theme activation so the
  // page-local customTemplate is registered).
  let frontPageSet = false;
  for (const p of installed) {
    if (p.postId == null) continue;
    try {
      await studioWp(studioSitePath, ['post', 'meta', 'update', String(p.postId), '_wp_page_template', 'page-local']);
    } catch (err) {
      warnings.push(`template assign failed for ${p.slug}: ${(err as Error).message}`);
    }
  }
  const homeInstall = installed.find((p) => p.slug === plan.homeSlug);
  if (homeInstall?.postId != null) {
    try {
      await studioWp(studioSitePath, ['option', 'update', 'show_on_front', 'page']);
      await studioWp(studioSitePath, ['option', 'update', 'page_on_front', String(homeInstall.postId)]);
      frontPageSet = true;
    } catch (err) {
      warnings.push(`front page set failed: ${(err as Error).message}`);
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
  let parity:
    | {
        floor: number;
        allPass: boolean;
        avgDesktop: number;
        avgMobile: number;
        pages: Array<{ pathname: string; desktop: number | null; mobile: number | null; passes: boolean }>;
      }
    | undefined;
  if (!skipDesign && !skipCompare && designCaptured) {
    try {
      const replicaCaptureDir = join(outputDir, 'replica');
      const replicaUrls = installed
        .filter((p) => p.postId != null)
        .map((p) => (p.slug === plan.homeSlug ? `${wpUrl}/` : `${wpUrl}/${p.slug}/`));
      await captureScreenshots({ urls: replicaUrls, outputDir: replicaCaptureDir, primaryUrl: wpUrl, concurrency: 2 });
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

  // Truthful carry summary: css=true only when the CSS file was actually written;
  // js=true only when the JS file was actually written. WP_COMPAT_CSS is always
  // non-empty so carryCss:true always yields css:true when the flag is on.
  const carriedCss = carryCss && (carrySourceAssets?.css ?? '').trim().length > 0;
  const carriedJs = carryJs && (carrySourceAssets?.js ?? '').trim().length > 0;

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
    ...(parity !== undefined ? { parity } : {}),
    warnings,
  });
};
