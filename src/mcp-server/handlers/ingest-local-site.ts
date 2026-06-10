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
import { ingestLocalSite } from '../../lib/replicate/local-site/ingest.js';
import { composePage } from '../../lib/replicate/normalize/compose-page.js';
import type { NormalizeReportEntry } from '../../lib/replicate/local-site/types.js';

const NORMALIZE_REPORT_SCHEMA = 1;

export const ingestLocalSiteHandler: Handler = async (args, ctx) => {
  const dir = args.dir as string | undefined;
  const outputDir = (args.outputDir as string | undefined) ?? dir;
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

  const composedDir = join(outputDir, 'composed');
  mkdirSync(composedDir, { recursive: true });

  const entries: Array<NormalizeReportEntry & { slug: string }> = [];
  const failedPages: Array<{ slug: string; error: string }> = [];
  const emptyPages: string[] = [];

  for (const page of site.pages) {
    // Per-page isolation: one bad page (roundtrip failure / compose misfit)
    // must not abort the whole ingest — record it and keep going.
    try {
      const { postContent, report } = composePage(page);
      if (postContent === '' && report.length === 0) emptyPages.push(page.slug);
      writeFileSync(join(composedDir, `${page.slug}.blocks.html`), postContent);
      for (const r of report) entries.push({ ...r, slug: page.slug });
    } catch (err) {
      failedPages.push({ slug: page.slug, error: (err as Error).message });
    }
  }

  // Atomic write (tmp + rename) — a crash mid-write must not leave a torn
  // normalize-report.json behind. composedDir's recursive mkdir above already
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
  });
};
