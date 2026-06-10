//
// liberate_ingest_local_site
// ==========================
// Stage 1a of the owned-source path: ingest a local static-site directory,
// normalize each page into native block markup (validated by the roundtrip
// oracle), and write composed sidecars + a normalize-report. No Playwright,
// no Studio. Downstream stages (theme-scaffold, install, compare) consume
// the composed sidecars.
//
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Handler } from '../handler-types.js';
import { ingestLocalSite } from '../../lib/replicate/local-site/ingest.js';
import { composePage } from '../../lib/replicate/normalize/compose-page.js';
import type { NormalizeReportEntry } from '../../lib/replicate/local-site/types.js';

const NORMALIZE_REPORT_SCHEMA = 1;

export const ingestLocalSiteHandler: Handler = async (args, ctx) => {
  const dir = args.dir as string | undefined;
  const outputDir = (args.outputDir as string | undefined) ?? dir;
  if (!dir) return ctx.errorResult('dir is required');
  if (!outputDir) return ctx.errorResult('outputDir is required');

  let site;
  try {
    site = ingestLocalSite(dir);
  } catch (err) {
    return ctx.errorResult(`ingest failed: ${(err as Error).message}`);
  }

  const entries: Array<NormalizeReportEntry & { slug: string }> = [];
  const failedPages: Array<{ slug: string; error: string }> = [];

  for (const page of site.pages) {
    try {
      const { postContent, report } = composePage(page);
      const sidecar = join(outputDir, 'composed', `${page.slug}.blocks.html`);
      mkdirSync(dirname(sidecar), { recursive: true });
      writeFileSync(sidecar, postContent);
      for (const r of report) entries.push({ ...r, slug: page.slug });
    } catch (err) {
      failedPages.push({ slug: page.slug, error: (err as Error).message });
    }
  }

  const reportPath = join(outputDir, 'normalize-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify({ schema: NORMALIZE_REPORT_SCHEMA, site: dir, entries, failedPages }, null, 2),
  );

  return ctx.textResult({
    pages: site.pages.length,
    sections: entries.length,
    lowConfidence: entries.filter((e) => e.confidence < 1).length,
    failedPages: failedPages.length,
    failedPagesList: failedPages,
    reportPath,
  });
};
