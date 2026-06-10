// src/mcp-server/handlers/convert-local-site.ts
//
// liberate_convert_local_site
// ===========================
// Stage 1b of the owned-source path: take a local static site through to a
// LIVE Studio site — reuse stage 1a (ingest → composed sidecars), assemble
// the local block theme (nav-graph header, captured footer, no-title page
// templates), write + activate it, create WP Pages from the sidecars
// (idempotent via _source_url), set the front page, and assign the
// page-local template. Compare/parity wiring is stage 1c.
//
import { existsSync } from 'node:fs';
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

  // Chrome: nav from the graph; footer from the home page's captured footer section.
  const nav = buildNavGraph(site);
  const home = site.pages.find((p) => p.slug === 'home') ?? site.pages[0];
  const footerSection = segmentPage(home.html).find((s) => s.role === 'footer') ?? null;
  const headerPart = buildHeaderPart(siteTitle, nav, site.pages.map((p) => p.slug));
  const footerPart = buildFooterPart(footerSection, siteTitle, { pageSlugs: site.pages.map((p) => p.slug) });

  // Theme assembly + write + activate.
  const themeFiles = assembleLocalTheme({ siteTitle, themeSlug, headerPart, footerPart });
  let themeWritten = 0;
  try {
    themeWritten = writeReplicaFilesToHost({ wpRoot, themeSlug, themeFiles }).themeWritten;
  } catch (err) {
    return ctx.errorResult(`theme write failed: ${(err as Error).message}`);
  }
  const warnings: string[] = [];
  try {
    await studioWp(studioSitePath, ['theme', 'activate', themeSlug]);
  } catch (err) {
    warnings.push(`theme activate failed: ${(err as Error).message}`);
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
    warnings,
  });
};
