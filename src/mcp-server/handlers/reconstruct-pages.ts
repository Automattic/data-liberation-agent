//
// liberate_reconstruct_pages
// ==========================
// Deterministic per-PAGE reconstruction, wired for the /liberate→replicate flow.
// For EACH content page: capture computed-style section specs, reconstruct them
// into block-pattern markup (verbatim copy, mediaMapped images, theme tokens),
// gate through validate_artifacts, and write the pattern + post_content + icon
// assets, then collapse page templates to a small set of variant-keyed templates
// (page-replica[-<key>]) assigned per page via _wp_page_template, and patch
// output.wxr to match. Replaces the old cluster-rep-only
// reconstruction that left every other page rendering carried source HTML.
//
// Single extraction pass per page (specs captured once); section image URLs are
// downloaded + installed into the WP media library, then rewritten on the specs
// via the resulting CDN→WP map before reconstruction. Cache is flushed once at
// the end so freshly-written patterns register immediately.
//

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PaletteToken } from '../../lib/replicate/footer-color.js';
import type { FontFamilyToken } from '../../lib/replicate/page-reconstruct.js';
import { extractFullFromUrl, rewriteThroughMediaMap } from '../../lib/replicate/section-extract.js';
import type { SectionSpec } from '../../lib/replicate/section-extract.js';
import { SectionSpecsStore } from '../../lib/replicate/section-specs-store.js';
import { buildPageReconstruction } from '../../lib/replicate/reconstruct-pages.js';
import { buildPageLinkMap } from '../../lib/replicate/page-link-map.js';
import { installRunMediaMap } from '../../lib/replicate/run-media-map.js';
import { BlockFixerClient } from '../../lib/streaming/block-fixer-client.js';
import { convertSemanticSections } from '../../lib/replicate/convert-semantic-sections.js';
import { downloadMedia } from '../../lib/media-fetch/index.js';
import { downloadSectionMedia } from '../../lib/replicate/download-section-media.js';
import { MediaStubStore } from '../../lib/resume-state/index.js';
import { deriveInstallThemeSlug } from './install-theme.js';
import { themeCacheFlushCommands } from './install-theme.js';
import type { Handler } from '../handler-types.js';
import { detect } from '../../lib/detect-platform/index.js';
import { ImportSession } from '../../lib/resume-state/index.js';
import type { FallbackDiagnostic } from '../../lib/replicate/fallback-diagnostic.js';
import { extractThemeChromeFromHtml } from '../../lib/replicate/source-chrome.js';
import { reconcileRegions, type PlacedRegion, type RegionSelectionReport } from '../../lib/replicate/region-audit.js';
import { slugify } from '../../lib/url/index.js';
import { planPageTemplates, reconcileReplicaTemplates, mergeCustomTemplates, variantTemplateSlug, type TemplateVariant } from '../../lib/replicate/page-template-plan.js';
import { patchWxrTemplatesFile, type WxrTemplatePatchInput } from '../../lib/replicate/wxr-template-patch.js';
import { buildPageTemplate } from '../../lib/replicate/reconstruct-pages.js';

const execFileAsync = promisify(execFile);

function writeJsonArtifact(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

interface PageArg {
  slug: string;
  sourceUrl: string;
  title: string;
  isHome?: boolean;
}

/**
 * Force WP to re-scan the theme's patterns/*.php list by switching to any other
 * installed theme and back. Re-activating the SAME theme is a no-op in wp-cli, so
 * we bounce through a fallback. Best-effort — a brief window renders the fallback.
 */
async function forcePatternRescan(studioSitePath: string, themeSlug: string): Promise<void> {
  const wp = (extra: string[]) =>
    execFileAsync('studio', ['wp', '--path', studioSitePath, ...extra], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  let bounced = false;
  try {
    const { stdout } = await wp(['theme', 'list', '--field=name']);
    const fallback = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .find((t) => t !== themeSlug);
    if (!fallback) return; // only one theme installed — nothing to bounce through
    await wp(['theme', 'activate', fallback]);
    bounced = true;
  } catch {
    return; // couldn't switch away — the replica theme is still active, no harm
  }
  // CRITICAL: once switched to the fallback we MUST switch back, or the site is
  // left stranded on the fallback theme (replica deactivated). Always re-activate
  // the replica, retrying once, regardless of any earlier failure.
  if (bounced) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await wp(['theme', 'activate', themeSlug]);
        return;
      } catch {
        /* retry */
      }
    }
  }
}

/**
 * Write the reconstructed block markup into the WP page's post_content, so it's a
 * real, editable block page (not a Classic block wrapping the carried HTML). The
 * page renders via the template's wp:post-content; the theme keeps the pattern as
 * a library entry. Resolves the post: the home page is page_on_front (its WP slug
 * may differ from the reconstruction's "home"); others match by slug. Best-effort
 * — a slug that resolves to no page is reported, not fatal.
 */
async function updatePagePostContent(
  studioSitePath: string,
  slug: string,
  isHome: boolean,
  content: string,
): Promise<{ contentOk: boolean; id: string }> {
  const wp = (extra: string[]) =>
    execFileAsync('studio', ['wp', '--path', studioSitePath, ...extra], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
  let id = '';
  try {
    if (isHome) {
      const { stdout } = await wp(['option', 'get', 'page_on_front']);
      id = stdout.trim();
    }
    if (!id || id === '0') {
      const { stdout } = await wp(['post', 'list', '--post_type=page', `--name=${slug}`, '--field=ID', '--format=ids']);
      id = stdout.trim().split(/\s+/)[0] || '';
    }
    if (!id) return { contentOk: false, id: '' };
    if (isHome) {
      // Make this page the static front page so `/` renders the homepage
      // reconstruction (front-page.html) instead of the blog index. Best-effort
      // + idempotent (no-op when already set); the content update is the primary
      // goal, so a front-page failure must not abort it.
      try {
        await wp(['option', 'update', 'show_on_front', 'page']);
        await wp(['option', 'update', 'page_on_front', id]);
      } catch {
        /* best-effort */
      }
    }
    // Pass content as a single argv value (execFile = no shell, so no escaping /
    // injection concern); page block markup is well under ARG_MAX. The wp-cli
    // field is `post_content` (the bare `--content` flag is silently ignored).
    // NOTE: `_wp_page_template` assignment happens in a SEPARATE post-loop pass
    // (after forcePatternRescan registers the variant customTemplates) — WP rejects
    // a page_template that isn't yet registered in theme.json.
    await wp(['post', 'update', id, `--post_content=${content}`]);
    return { contentOk: true, id };
  } catch (err) {
    console.error(`[reconstruct] post update failed for slug="${slug}": ${err instanceof Error ? err.message : String(err)}`);
    return { contentOk: false, id: '' };
  }
}

/** Read the theme.json color palette as {slug, hex} tokens for card-color mapping. */
function readThemePalette(themeJsonPath: string): PaletteToken[] {
  try {
    const j = JSON.parse(readFileSync(themeJsonPath, 'utf8')) as {
      settings?: { color?: { palette?: Array<{ slug?: string; color?: string }> } };
    };
    const palette = j.settings?.color?.palette ?? [];
    return palette
      .filter((p): p is { slug: string; color: string } => Boolean(p.slug && p.color && /^#?[0-9a-f]{3,8}$/i.test(p.color)))
      .map((p) => ({ slug: p.slug, hex: p.color }));
  } catch {
    return [];
  }
}

/** Read the theme's registered fontFamily tokens ({slug, family}) so the renderer
 *  can map each captured element's computed font-family to the nearest token. */
function readThemeFontFamilies(themeJsonPath: string): FontFamilyToken[] {
  try {
    const j = JSON.parse(readFileSync(themeJsonPath, 'utf8')) as {
      settings?: { typography?: { fontFamilies?: Array<{ slug?: string; fontFamily?: string }> } };
    };
    const fams = j.settings?.typography?.fontFamilies ?? [];
    return fams
      .filter((f): f is { slug: string; fontFamily: string } => Boolean(f.slug && f.fontFamily))
      .map((f) => ({ slug: f.slug, family: f.fontFamily }));
  } catch {
    return [];
  }
}

/** Resolve the WP root by probing for wp-content (flat vs nested Studio layout). */
function resolveWpRoot(studioSitePath: string): string | null {
  const sitePath = resolve(studioSitePath);
  if (existsSync(join(sitePath, 'wp-content'))) return sitePath;
  const nested = join(sitePath, 'wordpress');
  if (existsSync(join(nested, 'wp-content'))) return nested;
  return null;
}

/** Rewrite a spec's captured image URLs (foreground, background, and cell images)
 *  through the CDN→WP media map so reconstruction references the WP library. */
function applyMediaMap(specs: SectionSpec[], mediaMap: Record<string, string>): void {
  for (const s of specs) {
    for (const im of s.images ?? []) im.url = rewriteThroughMediaMap(im.sourceUrl, mediaMap);
    for (const c of s.cells ?? []) {
      if (c.image) c.image.url = rewriteThroughMediaMap(c.image.sourceUrl, mediaMap);
    }
  }
}

// buildPageLinkMap is shared with the alt path — see ../../lib/replicate/page-link-map.ts.

function collectSourceUrls(specs: SectionSpec[], into: Set<string>): void {
  for (const s of specs) {
    for (const im of s.images ?? []) if (im.sourceUrl) into.add(im.sourceUrl);
    for (const c of s.cells ?? []) if (c.image?.sourceUrl) into.add(c.image.sourceUrl);
  }
}

export const reconstructPagesHandler: Handler = async (args, ctx) => {
  const outputDir = args.outputDir as string | undefined;
  const studioSitePath = args.studioSitePath as string | undefined;
  const pages = args.pages as PageArg[] | undefined;
  if (!outputDir) return ctx.errorResult('liberate_reconstruct_pages requires `outputDir`.');
  if (!studioSitePath) return ctx.errorResult('liberate_reconstruct_pages requires `studioSitePath`.');
  if (!Array.isArray(pages) || pages.length === 0) {
    return ctx.errorResult('liberate_reconstruct_pages requires a non-empty `pages` array ({slug, sourceUrl, title, isHome?}).');
  }

  const wpRoot = resolveWpRoot(studioSitePath);
  if (!wpRoot) return ctx.errorResult(`studioSitePath has no wp-content: ${studioSitePath}`);
  const themeSlug = (args.themeSlug as string | undefined) ?? deriveInstallThemeSlug(outputDir);
  const themeRoot = join(wpRoot, 'wp-content', 'themes', themeSlug);
  if (!existsSync(themeRoot)) {
    return ctx.errorResult(`theme not installed at ${themeRoot} — run liberate_theme_scaffold/install first.`);
  }

  // Resolve the source platform's adapter so its block recipe (seam 2) applies
  // during reconstruction. Blocks path only — the carry handler never does this,
  // which is the path-gate. Prefer the platform RECORDED at extraction
  // (session.json) over a live network detect: it avoids a round-trip to the
  // (possibly down/changed) source and the single-pages[0] homogeneity guess.
  // Fall back to detect only when this outputDir has no prior session.
  const platform = ImportSession.readAdapter(outputDir) ?? (await detect(pages[0].sourceUrl)).platform;
  const adapter = ctx.findAdapter(platform);

  const mediaDir = join(resolve(outputDir), 'media');

  // 1. Get every page's section specs once (reused after the media map is built).
  //    Prefer the capture-once cache (`<outputDir>/sections/<slug>.json`, written
  //    during the screenshot pass) so we skip a redundant live Playwright pass.
  //    Fall back to a live extract when the cache is absent/stale/colliding, and
  //    persist the result so the next run is cache-hot. `refresh: true` forces live.
  const specsStore = SectionSpecsStore.load(outputDir);
  const refresh = args.refresh === true;
  const collapseTemplates = (args.collapseTemplates ?? true) === true;
  const specsByPage = new Map<string, SectionSpec[]>();
  const srcUrls = new Set<string>();
  const extractErrors: Array<{ slug: string; error: string }> = [];
  let specsFromCache = 0;
  let specsFromLive = 0;
  for (const p of pages) {
    try {
      let specs = refresh ? null : specsStore.get(p.sourceUrl);
      if (specs) {
        specsFromCache++;
      } else {
        const live = await extractFullFromUrl(p.sourceUrl, {});
        specs = live.specs;
        specsStore.set(p.sourceUrl, live.specs, live.landmarks); // cache specs + census for the next run
        specsFromLive++;
      }
      specsByPage.set(p.slug, specs);
      collectSourceUrls(specs, srcUrls);
    } catch (err) {
      extractErrors.push({ slug: p.slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Download any section media not already captured, then install all stubs
  //    into the WP library and build the CDN→WP rewrite map.
  const stubs = MediaStubStore.load(outputDir);
  const seenNames = new Map<string, number>();
  // Fetch the section-background imagery in a bounded-concurrency pool (these are
  // independent I/O-bound fetches; the old serial loop dominated wall-clock on media-heavy
  // sites). `safeFilename`/`seenNames` mutate synchronously, so the shared collision map is
  // race-free; the stub check keeps anything extraction already fetched from re-downloading.
  const { downloaded } = await downloadSectionMedia({
    srcUrls,
    isAlreadyDone: (u) => {
      const ex = stubs.get(u);
      return !!(ex && ex.status === 'success' && ex.localPath);
    },
    download: async (u) => (await downloadMedia(u, mediaDir, seenNames)).localPath ?? null,
    onSuccess: (u, localPath) => stubs.markSuccess(u, localPath),
  });
  stubs.flush();

  // Install the run's media into the site + build the CDN→local URL map. Shared
  // with the alt path via installRunMediaMap (same installMediaForUrl underneath).
  const { mediaUrlMap, result: mediaResult } = await installRunMediaMap({
    outputDir,
    url: pages[0].sourceUrl,
    wpRoot,
  });
  // Record form for applyMediaMap (spec background-image rewrite).
  const mediaMap: Record<string, string> = Object.fromEntries(mediaUrlMap);

  // Theme palette tokens (from the installed theme.json) — used to map captured
  // card/cell background colors to token slugs (the gate forbids inline hex).
  const paletteTokens = readThemePalette(join(themeRoot, 'theme.json'));
  // Theme fontFamily tokens — used to map each captured element's computed
  // font-family to the nearest registered token (per-element family fidelity).
  const fontFamilies = readThemeFontFamilies(join(themeRoot, 'theme.json'));
  // Source-path → local-permalink map, built once and reused per page so body
  // links (inline + CTA hrefs) resolve to imported pages, like the nav already does.
  const linkMap = buildPageLinkMap(outputDir, pages.map((p) => p.sourceUrl));

  // 3. Reconstruct + gate + write each page.
  const report: Array<Record<string, unknown>> = [];
  const outThemeDir = join(resolve(outputDir), 'theme');
  // Block fixer: canonicalize the reconstructed markup through @wordpress/blocks
  // (the actual block save() functions) before writing it to post_content, so the
  // blocks validate cleanly in the editor (no "unexpected content"/recovery). The
  // client passes the markup through unchanged if the server can't start.
  const blockFixer = new BlockFixerClient();
  await blockFixer.start().catch(() => {
    /* best-effort — fix() passes through if the server didn't start */
  });
  const plannedPages: { slug: string; isHome: boolean; variant: TemplateVariant }[] = [];
  const wxrInputs: WxrTemplatePatchInput[] = [];
  const pageIdBySlug = new Map<string, string>();
  let assignmentFailures = 0;
  for (const p of pages) {
    const specs = specsByPage.get(p.slug);
    if (!specs) {
      report.push({ slug: p.slug, ok: false, reason: 'extraction-failed' });
      continue;
    }
    applyMediaMap(specs, mediaMap);
    // Pre-resolve general HTML→blocks conversions for this page's semantic sections
    // via the block-fixer sidecar (rawHandler). Async work stays here; results flow
    // into the sync reconstructor as data. Sidecar down → empty map → structured render.
    // .catch guards the loop: a rejected conversion must not escape and skip
    // blockFixer.stop() (subprocess leak) — an empty map degrades to structured render.
    const convertedSections = await convertSemanticSections(specs, blockFixer).catch(
      () => new Map<number, { markup: string | null; wpHtmlResidue: number }>(),
    );
    let built;
    try {
      built = buildPageReconstruction(specs, { slug: p.slug, title: p.title, themeSlug, isHome: p.isHome, paletteTokens, fontFamilies, linkMap, mediaUrlMap, adapterBlocks: adapter?.blocks, sourceUrl: p.sourceUrl, convertedSections });
    } catch (err) {
      report.push({ slug: p.slug, ok: false, reason: `build: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!built.gate.ok) {
      // Never install a pattern that fails the escaping/injection/provenance gate.
      report.push({ slug: p.slug, ok: false, reason: 'gate-failed', gateErrors: built.gate.errors });
      continue;
    }
    // Write to the live theme AND the on-disk output/<site>/theme copy.
    for (const root of [themeRoot, outThemeDir]) {
      for (const f of built.files) {
        const full = join(root, f.path);
        const dir = dirname(full);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(full, f.content);
      }
      const perSlug = join(root, `templates/page-${p.slug}.html`);
      if (!collapseTemplates) {
        writeFileSync(perSlug, built.template); // legacy per-page template
      } else if (existsSync(perSlug)) {
        rmSync(perSlug); // Issue 5: drop any pre-existing per-slug template so existing replicas collapse
      }
    }
    // Canonicalize the block markup so it validates in the editor, then make the
    // WP page a real editable block page: write it into post_content (rendered via
    // the template's wp:post-content). The _wp_page_template assignment is deferred
    // to a post-loop pass (after the variant customTemplates register).
    const fixResult = (await blockFixer.fix([built.postContent]))[0];
    const finalContent = fixResult?.html ?? built.postContent;
    const upd = await updatePagePostContent(studioSitePath, p.slug, p.isHome ?? false, finalContent);
    const postUpdated = upd.contentOk;
    if (upd.id) pageIdBySlug.set(p.slug, upd.id);
    plannedPages.push({ slug: p.slug, isHome: p.isHome ?? false, variant: built.variant });
    wxrInputs.push({ slug: p.slug, content: finalContent, templateSlug: collapseTemplates && !(p.isHome ?? false) ? variantTemplateSlug(built.variant.key) : null });
    report.push({
      slug: p.slug,
      ok: true,
      patternSlug: built.patternSlug,
      sectionsRendered: built.sectionsRendered,
      iconAssets: built.iconAssetCount,
      assets: built.expectedAssets.length,
      provenanceFlags: built.provenanceFlags,
      fallbackSections: built.fallbackSections,
      fallbackDiagnostics: built.fallbackDiagnostics,
      postContentUpdated: postUpdated,
      blocksFixed: fixResult?.changed ?? false,
    });
  }

  // ---- Template collapse (post-loop) -----------------------------------------
  let pageTemplatesWritten = 0;
  let templatesDeleted = 0;
  let wxrUnmatched: string[] = [];
  let collapseError: string | undefined;
  const templateVariants: Record<string, number> = {};
  for (const pp of plannedPages) templateVariants[pp.variant.key] = (templateVariants[pp.variant.key] ?? 0) + 1;

  try {
    // Patch the WXR first so existingAssignments (prior _wp_page_template) feed the
    // reconcile guard. An ABSENT/unreadable output.wxr (e.g. a reconstruct-only run
    // that never produced a WXR) is non-fatal — skip the patch, treat prior
    // assignments as empty, and continue to the template/theme.json writes.
    let existingAssignments = new Map<string, string>();
    try {
      const patch = patchWxrTemplatesFile(
        resolve(outputDir),
        collapseTemplates ? wxrInputs : wxrInputs.map((w) => ({ ...w, templateSlug: null })),
      );
      wxrUnmatched = patch.unmatched;
      existingAssignments = patch.existingAssignments;
    } catch (err) {
      console.error(`[reconstruct] output.wxr absent or unreadable — skipping WXR patch: ${err instanceof Error ? err.message : String(err)}`);
      wxrUnmatched = [];
    }

    if (collapseTemplates) {
      const plan = planPageTemplates(plannedPages, (v) => buildPageTemplate(v.overlayHeader, v.fullWidth));
      if (plan.duplicateSlugs.length) {
        console.error(`[reconstruct] duplicate slugs (templates/assignments act on first match): ${plan.duplicateSlugs.join(', ')}`);
      }
      const stillReferenced = new Set<string>([...existingAssignments.values()]);
      for (const root of [themeRoot, outThemeDir]) {
        const tplDir = join(root, 'templates');
        const existing = existsSync(tplDir)
          ? readdirSync(tplDir).filter((f) => f.startsWith('page-replica') && f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length))
          : [];
        const rec = reconcileReplicaTemplates(existing, plan.desiredTemplateSlugs, stillReferenced);
        for (const t of plan.templates) writeFileSync(join(root, t.relativePath), t.content);
        for (const slug of rec.delete) { rmSync(join(tplDir, `${slug}.html`), { force: true }); templatesDeleted++; }
        const themeJsonPath = join(root, 'theme.json');
        const merged = mergeCustomTemplates(readFileSync(themeJsonPath, 'utf8'), plan.customTemplates);
        const tmp = `${themeJsonPath}.tmp`;
        writeFileSync(tmp, merged);
        renameSync(tmp, themeJsonPath);
      }
      pageTemplatesWritten = plan.templates.length;
    } else {
      for (const root of [themeRoot, outThemeDir]) {
        const tplDir = join(root, 'templates');
        if (existsSync(tplDir)) {
          for (const f of readdirSync(tplDir).filter((x) => x.startsWith('page-replica') && x.endsWith('.html'))) {
            rmSync(join(tplDir, f), { force: true }); templatesDeleted++;
          }
        }
        const themeJsonPath = join(root, 'theme.json');
        if (existsSync(themeJsonPath)) {
          const merged = mergeCustomTemplates(readFileSync(themeJsonPath, 'utf8'), []);
          const tmp = `${themeJsonPath}.tmp`;
          writeFileSync(tmp, merged); renameSync(tmp, themeJsonPath);
        }
      }
    }
  } catch (err) {
    // A genuine theme.json write failure is surfaced (collapseError → result) but
    // must NOT rethrow: rethrowing would skip blockFixer.stop()/flush/rescan/the
    // assignment pass/diagnostics — leaking the block-fixer subprocess and leaving
    // patterns unregistered. Report it; keep running teardown.
    collapseError = err instanceof Error ? err.message : String(err);
    console.error(`[reconstruct] template-collapse step failed: ${collapseError}`);
  }

  await blockFixer.stop().catch(() => {
    /* best-effort teardown */
  });

  // 4. Flush caches so the freshly-written patterns register immediately.
  for (const wpArgs of themeCacheFlushCommands()) {
    try {
      await execFileAsync('studio', ['wp', '--path', studioSitePath, ...wpArgs], { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
    } catch {
      /* best-effort */
    }
  }
  // Force a pattern-file RE-SCAN. WP caches the theme's patterns/*.php file LIST
  // at activation and keyed by theme version — ADDING new pattern files does NOT
  // invalidate it, and neither `cache flush` nor `transient delete` clears it on
  // a single-site/Studio install. Only re-running theme registration does. The
  // reliable, version-agnostic trigger is a theme switch away-and-back (clears
  // wp_clean_themes_cache + rebuilds the pattern registry). Without this, the
  // newly-written page patterns resolve to EMPTY until WP next re-registers.
  await forcePatternRescan(studioSitePath, themeSlug);

  // Studio _wp_page_template assignment — AFTER forcePatternRescan so the variant
  // customTemplates are registered (WP rejects an unregistered page_template).
  {
    const studioWp = (extra: string[]) =>
      execFileAsync('studio', ['wp', '--path', studioSitePath, ...extra], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
    for (const pp of plannedPages) {
      if (pp.isHome) continue;
      const id = pageIdBySlug.get(pp.slug);
      if (!id) continue;
      try {
        if (collapseTemplates) await studioWp(['post', 'update', id, `--page_template=${variantTemplateSlug(pp.variant.key)}`]);
        else await studioWp(['post', 'meta', 'delete', id, '_wp_page_template']).catch(() => {}); // clear on toggle-off
      } catch (err) {
        if (collapseTemplates) { assignmentFailures++; console.error(`[reconstruct] assign failed slug="${pp.slug}": ${err instanceof Error ? err.message : String(err)}`); }
      }
    }
  }

  const reconstructed = report.filter((r) => r.ok).length;
  // Site-level count of sections emitted as verbatim core/html islands — feeds the
  // run-report's warning-level htmlFallbackSections so QA can upgrade each to blocks.
  const htmlFallbackSections = report.reduce((n, r) => n + ((r.fallbackSections as number) ?? 0), 0);
  const allFallbackDiagnostics = report.flatMap((r) => (r.fallbackDiagnostics as FallbackDiagnostic[] | undefined) ?? []);
  const htmlFallbackByReason = allFallbackDiagnostics.reduce<Record<string, number>>((acc, d) => {
    acc[d.reasonCode] = (acc[d.reasonCode] ?? 0) + 1;
    return acc;
  }, {});
  writeJsonArtifact(join(resolve(outputDir), 'fallback-diagnostics.json'), {
    schema: 1,
    site: basename(resolve(outputDir)),
    diagnostics: allFallbackDiagnostics,
  });

  // Region audit (#2): reconcile each page's source landmark census against what
  // was placed (body section selectors + chrome presence). Chrome is site-level —
  // derived once from the homepage's served HTML (same extractor theme-scaffold uses).
  const homepage = pages.find((pg) => pg.isHome) ?? pages[0];
  const chromePlaced: PlacedRegion[] = [];
  try {
    const homeHtml = readFileSync(join(resolve(outputDir), 'html', `${slugify(homepage.sourceUrl)}.html`), 'utf8');
    const chrome = extractThemeChromeFromHtml(homeHtml, homepage.sourceUrl);
    if (chrome.header?.links?.length || chrome.header?.logoUrl) {
      chromePlaced.push({ kind: 'header_part', role: 'header', selector: chrome.header.sourceSelector });
    }
    if (chrome.footer?.links?.length || chrome.footer?.logoUrl) {
      chromePlaced.push({ kind: 'footer_part', role: 'footer', selector: chrome.footer.sourceSelector });
    }
  } catch {
    // Homepage HTML unreadable — assume chrome present (conservative: avoid false
    // "dropped nav/footer" flags when we simply can't inspect the source).
    chromePlaced.push({ kind: 'header_part', role: 'header' }, { kind: 'footer_part', role: 'footer' });
  }
  const regionReports: RegionSelectionReport[] = pages.map((p) => {
    const census = specsStore.getLandmarks(p.sourceUrl) ?? [];
    const bodyPlaced: PlacedRegion[] = (specsByPage.get(p.slug) ?? []).map((s) => ({
      kind: 'page_body_section' as const,
      selector: s.selector,
    }));
    return reconcileRegions(census, [...bodyPlaced, ...chromePlaced], p.slug, p.sourceUrl);
  });
  writeJsonArtifact(join(resolve(outputDir), 'region-audit.json'), {
    schema: 1,
    site: basename(resolve(outputDir)),
    pages: regionReports,
  });
  const unassignedRegions = regionReports.reduce((n, r) => n + r.counts.unassigned, 0);

  return ctx.textResult({
    ok: extractErrors.length === 0 && report.every((r) => r.ok),
    themeSlug,
    reconstructed,
    failed: report.length - reconstructed,
    mediaDownloaded: downloaded,
    mediaInstalled: mediaResult.installed.length,
    htmlFallbackSections,
    htmlFallbackByReason,
    unassignedRegions,
    specsFromCache,
    specsFromLive,
    extractErrors,
    pagesReconstructed: reconstructed,
    pageTemplates: pageTemplatesWritten,
    templatesDeleted,
    templateVariants,
    assignmentFailures,
    wxrUnmatched,
    collapseError,
    summary: `${reconstructed} pages → ${pageTemplatesWritten} reconstructed templates`
      + (wxrUnmatched.length ? ` · ⚠ ${wxrUnmatched.length} WXR-unmatched (${wxrUnmatched.join(', ')})` : '')
      + (assignmentFailures ? ` · ⚠ ${assignmentFailures} assignment failures` : '')
      + (collapseError ? ` · ⚠ collapse error: ${collapseError}` : ''),
    pages: report,
  });
};
