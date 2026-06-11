//
// liberate_ingest_local_site
// ==========================
// Stage 1a of the owned-source path: ingest a local static-site directory,
// normalize each page into native block markup (validated by the roundtrip
// oracle), and write composed sidecars + a normalize-report. No Playwright,
// no Studio. Downstream stages (theme-scaffold, install, compare) consume
// the composed sidecars.
//
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Handler } from '../handler-types.js';
import { validateOutputDir } from '../../lib/screenshot/output-layout.js';
import { composedSidecarPath } from '../../lib/streaming/block-markup-validate.js';
import { ingestLocalSite } from '../../lib/replicate/local-site/ingest.js';
import { composePage } from '../../lib/replicate/normalize/compose-page.js';
import {
  detectBehaviors,
  detectSectionBehavior,
  type BehaviorSourceAssets,
} from '../../lib/replicate/normalize/detect-behaviors.js';
import { collectSourceAssets } from '../../lib/replicate/local-theme/source-assets.js';
import type {
  NormalizeReportEntry,
  RevealBehavior,
  Section,
  SectionBehavior,
} from '../../lib/replicate/local-site/types.js';

const NORMALIZE_REPORT_SCHEMA = 1;

export const ingestLocalSiteHandler: Handler = async (args, ctx) => {
  const dir = args.dir as string | undefined;
  const outputDir = (args.outputDir as string | undefined) ?? dir;
  const nativeBehaviors = args.nativeBehaviors === true;
  if (!dir) return ctx.errorResult('dir is required');
  if (!outputDir) return ctx.errorResult('outputDir is required');
  try {
    validateOutputDir(outputDir);
  } catch (err) {
    return ctx.errorResult((err as Error).message);
  }

  let site;
  try {
    site = ingestLocalSite(dir);
  } catch (err) {
    return ctx.errorResult(`ingest failed: ${(err as Error).message}`);
  }

  // Per-section DOM-pattern detection runs on BOTH paths (pure + regex-fast):
  // a tagged section keeps its inner VERBATIM — content survival is path-
  // independent (carry E2E: emitChild destroyed tab/panel scaffolding and the
  // carried source JS had nothing to drive). `native` only decides the
  // WRAPPER: dla/<kind> directives (nativeBehaviors) vs a plain core/group.
  // reveal stays flag-gated — it changes visuals via the plugin, which the
  // carry path never installs. Detection consumes the RAW collected css —
  // assets.css has WP_COMPAT_CSS prepended, which is detection-immune (no
  // html.js section gate, no scroll-listener patterns). The convert handler
  // re-runs the same pure detection for sticky/gaps/plugin wiring —
  // identical inputs, identical result (deterministic).
  const assets = collectSourceAssets(dir, site.pages.map((p) => ({ relPath: p.relPath, html: p.html })));
  const assetSlice: BehaviorSourceAssets = { css: assets.css, js: assets.js };
  const detectSection = (s: Section): SectionBehavior | undefined => detectSectionBehavior(s.html, assetSlice);
  let reveal: RevealBehavior | undefined;
  if (nativeBehaviors) {
    reveal = detectBehaviors(assetSlice).reveal;
  }

  mkdirSync(join(outputDir, 'composed'), { recursive: true });

  const entries: Array<NormalizeReportEntry & { slug: string }> = [];
  const failedPages: Array<{ slug: string; error: string }> = [];
  const emptyPages: string[] = [];

  for (const page of site.pages) {
    // Per-page isolation: one bad page (roundtrip failure / compose misfit)
    // must not abort the whole ingest — record it and keep going.
    try {
      const { postContent, report } = composePage(page, { reveal, detectSection, native: nativeBehaviors });
      if (postContent === '' && report.length === 0) emptyPages.push(page.slug);
      writeFileSync(composedSidecarPath(outputDir, page.slug), postContent);
      for (const r of report) entries.push({ ...r, slug: page.slug });
    } catch (err) {
      failedPages.push({ slug: page.slug, error: (err as Error).message });
    }
  }

  // Per-kind counts come from the compose REPORTS (single source of truth —
  // no re-detection drift), then the global detection RE-RUNS with the fired
  // kinds so their driver js is claimed out of the gap residue. The second
  // pass is pure + regex-fast and deterministic (same strings in → same
  // reveal/sticky out); only residue claiming differs, and sectionKinds can
  // only exist AFTER compose produced the reports — hence two passes.
  let behaviorsSummary:
    | { reveal: boolean; tabs: number; slider: number; modal: number; gaps: number }
    | undefined;
  if (nativeBehaviors) {
    const countOf = (kind: 'tabs' | 'slider' | 'modal'): number =>
      entries.filter((e) => e.blockType === `dla/${kind}`).length;
    const tabs = countOf('tabs');
    const slider = countOf('slider');
    const modal = countOf('modal');
    const sectionKinds = new Set<'tabs' | 'slider' | 'modal'>();
    if (tabs > 0) sectionKinds.add('tabs');
    if (slider > 0) sectionKinds.add('slider');
    if (modal > 0) sectionKinds.add('modal');
    const final = detectBehaviors(assetSlice, { sectionKinds });
    behaviorsSummary = { reveal: !!final.reveal, tabs, slider, modal, gaps: final.gaps.length };
  }

  // Atomic write (tmp + rename) — a crash mid-write must not leave a torn
  // normalize-report.json behind. The composed/ recursive mkdir above already
  // guarantees outputDir exists.
  const reportPath = join(outputDir, 'normalize-report.json');
  const tmpPath = `${reportPath}.tmp.${process.pid}`;
  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({ schema: NORMALIZE_REPORT_SCHEMA, site: dir, entries, failedPages, emptyPages }, null, 2),
    );
    renameSync(tmpPath, reportPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return ctx.errorResult(`failed to write normalize-report: ${(err as Error).message}`);
  }

  return ctx.textResult({
    pages: site.pages.length,
    sections: entries.length,
    lowConfidence: entries.filter((e) => e.confidence < 1).length,
    failedPageCount: failedPages.length,
    failedPagesList: failedPages,
    emptyPages,
    reportPath,
    // Standalone observability (key absent when the flag is off): what
    // detection found + per-kind section counts from the compose reports.
    // No artifact write here — behavior-gaps.json belongs to the convert stage.
    ...(behaviorsSummary !== undefined ? { behaviors: behaviorsSummary } : {}),
  });
};
