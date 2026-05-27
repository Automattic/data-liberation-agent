//
// liberate_reconstruct_pages
// ==========================
// Deterministic per-PAGE reconstruction, wired for the /liberate→replicate flow.
// For EACH content page: capture computed-style section specs, reconstruct them
// into block-pattern markup (verbatim copy, mediaMapped images, theme tokens),
// gate through validate_artifacts, and write the pattern + per-page template +
// icon assets into the running Studio theme. Replaces the old cluster-rep-only
// reconstruction that left every other page rendering carried source HTML.
//
// Single extraction pass per page (specs captured once); section image URLs are
// downloaded + installed into the WP media library, then rewritten on the specs
// via the resulting CDN→WP map before reconstruction. Cache is flushed once at
// the end so freshly-written patterns register immediately.
//

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PaletteToken } from '../../lib/replicate/footer-color.js';
import type { FontFamilyToken } from '../../lib/replicate/page-reconstruct.js';
import { extractFullFromUrl, rewriteThroughMediaMap } from '../../lib/replicate/section-extract.js';
import type { SectionSpec } from '../../lib/replicate/section-extract.js';
import { buildPageReconstruction } from '../../lib/replicate/reconstruct-pages.js';
import { installMediaForUrl } from '../../lib/streaming/media-install.js';
import { BlockFixerClient } from '../../lib/streaming/block-fixer-client.js';
import { downloadMedia } from '../../lib/extraction/media.js';
import { MediaStubStore } from '../../lib/extraction/media-stubs.js';
import { deriveInstallThemeSlug } from './install-theme.js';
import { themeCacheFlushCommands } from './install-theme.js';
import type { Handler } from '../handler-types.js';

const execFileAsync = promisify(execFile);

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
): Promise<boolean> {
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
    if (!id) return false;
    // Pass content as a single argv value (execFile = no shell, so no escaping /
    // injection concern); page block markup is well under ARG_MAX. The wp-cli
    // field is `post_content` (the bare `--content` flag is silently ignored).
    await wp(['post', 'update', id, `--post_content=${content}`]);
    return true;
  } catch {
    return false;
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
  const mediaDir = join(resolve(outputDir), 'media');

  // 1. Extract every page once. Specs are reused after the media map is built.
  const specsByPage = new Map<string, SectionSpec[]>();
  const srcUrls = new Set<string>();
  const extractErrors: Array<{ slug: string; error: string }> = [];
  for (const p of pages) {
    try {
      const specs = await extractFullFromUrl(p.sourceUrl, {});
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
  let downloaded = 0;
  for (const u of srcUrls) {
    if (!/^https?:/i.test(u)) continue;
    const ex = stubs.get(u);
    if (ex && ex.status === 'success' && ex.localPath) continue;
    try {
      const res = await downloadMedia(u, mediaDir, seenNames);
      if (res.localPath) {
        stubs.markSuccess(u, res.localPath);
        downloaded++;
      }
    } catch {
      /* best-effort — a missing image becomes a flagged placeholder downstream */
    }
  }
  stubs.flush();

  const mediaResult = await installMediaForUrl({
    outputDir,
    url: pages[0].sourceUrl,
    wpRoot,
    useStudioCli: true,
  });
  const mediaMap: Record<string, string> = {};
  for (const it of mediaResult.installed) mediaMap[it.sourceUrl] = it.localUrl;

  // Theme palette tokens (from the installed theme.json) — used to map captured
  // card/cell background colors to token slugs (the gate forbids inline hex).
  const paletteTokens = readThemePalette(join(themeRoot, 'theme.json'));
  // Theme fontFamily tokens — used to map each captured element's computed
  // font-family to the nearest registered token (per-element family fidelity).
  const fontFamilies = readThemeFontFamilies(join(themeRoot, 'theme.json'));

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
  for (const p of pages) {
    const specs = specsByPage.get(p.slug);
    if (!specs) {
      report.push({ slug: p.slug, ok: false, reason: 'extraction-failed' });
      continue;
    }
    applyMediaMap(specs, mediaMap);
    let built;
    try {
      built = buildPageReconstruction(specs, { slug: p.slug, title: p.title, themeSlug, isHome: p.isHome, paletteTokens, fontFamilies });
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
    }
    // Canonicalize the block markup so it validates in the editor, then make the
    // WP page a real editable block page: write it into post_content (rendered via
    // the template's wp:post-content).
    const fixResult = (await blockFixer.fix([built.postContent]))[0];
    const finalContent = fixResult?.html ?? built.postContent;
    const postUpdated = await updatePagePostContent(studioSitePath, p.slug, p.isHome ?? false, finalContent);
    report.push({
      slug: p.slug,
      ok: true,
      patternSlug: built.patternSlug,
      sectionsRendered: built.sectionsRendered,
      iconAssets: built.iconAssetCount,
      assets: built.expectedAssets.length,
      provenanceFlags: built.provenanceFlags,
      postContentUpdated: postUpdated,
      blocksFixed: fixResult?.changed ?? false,
    });
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

  const reconstructed = report.filter((r) => r.ok).length;
  return ctx.textResult({
    ok: extractErrors.length === 0 && report.every((r) => r.ok),
    themeSlug,
    reconstructed,
    failed: report.length - reconstructed,
    mediaDownloaded: downloaded,
    mediaInstalled: mediaResult.installed.length,
    extractErrors,
    pages: report,
  });
};
