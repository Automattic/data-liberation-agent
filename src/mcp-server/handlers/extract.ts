import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '../../lib/extraction/detect-platform.js';
import { ExtractionLog } from '../../lib/extraction/extraction-log.js';
import { WxrBuilder } from '../../lib/extraction/wxr-builder.js';
import { rehydrateBuilderFromWxr } from '../../lib/extraction/wxr-rehydrate.js';
import type { Handler } from '../handler-types.js';

export const extractHandler: Handler = async (args, ctx) => {
  const detection = await detect(args.url as string);
  const adapter = ctx.findAdapter(detection.platform);
  if (!adapter) {
    return ctx.errorResult(`No adapter available for platform: ${detection.platform}`);
  }

  const outputDir = args.outputDir as string;
  mkdirSync(outputDir, { recursive: true });

  const log = new ExtractionLog(outputDir);

  if (!log.acquireLock()) {
    return ctx.errorResult(
      'Extraction already in progress in this directory. Use a different outputDir or wait for the current extraction to complete.',
    );
  }

  try {
    const opts = {
      token: args.token,
      cdpPort: args.cdpPort,
      adminToken: args.adminToken,
      shopDomain: args.shopDomain,
      delay: args.delay,
      resume: args.resume,
      dryRun: args.dryRun,
      limit: args.limit,
      verbose: args.verbose,
      outputDir,
    };

    const inventory = (await adapter.discover(args.url as string, opts)) as {
      siteMeta?: { title?: string; tagline?: string; language?: string };
    };
    const wxr = new WxrBuilder({
      title: inventory.siteMeta?.title || 'Imported Site',
      url: args.url as string,
      description: inventory.siteMeta?.tagline || '',
      language: inventory.siteMeta?.language || 'en-US',
    }, { contentStatus: args.contentStatus === 'publish' ? 'publish' : 'draft' });

    const wxrPath = join(outputDir, 'output.wxr');

    // On resume, rehydrate the builder from any existing WXR so serialize()
    // preserves prior items instead of writing only the newly extracted ones.
    if (args.resume) {
      rehydrateBuilderFromWxr(wxr, wxrPath);
    }

    await adapter.extract(inventory, wxr, opts, { log, server: ctx.server });

    if (!args.dryRun && wxr.items.length > 0) {
      wxr.serialize(wxrPath);
    }

    // Optional screenshot capture. The manifest at
    // output/<site>/screenshots/manifest.json is keyed by URL; filesystem-level
    // joins against output.wxr / products.jsonl happen out-of-band (no
    // WordPress-side postmeta injection).
    let screenshotResult: import('../../lib/screenshot/types.js').ScreenshotResult | undefined;
    if (args.screenshots && !args.dryRun) {
      const { ImportSession } = await import('../../lib/extraction/import-session.js');
      // resume:true — continuing the same run the adapter just finished, not
      // starting a new one. Preserves session.json (cursors, counters) so
      // liberate_status reflects state.
      const session = ImportSession.loadOrCreate(outputDir, detection.platform, opts, { resume: true });
      session.setStage('screenshotting');
      const processedUrls = Array.from(log.getProcessedUrls());
      const { captureScreenshots } = await import('../../lib/screenshot/screenshotter.js');
      screenshotResult = await captureScreenshots({
        urls: processedUrls,
        outputDir,
        primaryUrl: args.url as string,
        server: ctx.server,
      });
      session.setStage('finalizing');
    }

    const summary = log.getSummary();
    const validation = args.dryRun ? { valid: true, warnings: [] } : wxr.validate();

    const qualityScores = { high: 0, medium: 0, low: 0 };
    for (const entry of summary.processed) {
      const score = (entry as Record<string, unknown>).qualityScore as string;
      if (score === 'high' || score === 'medium' || score === 'low') {
        qualityScores[score]++;
      }
    }

    return ctx.textResult({
      wxrPath: args.dryRun ? null : wxrPath,
      redirectMapPath: wxr.redirects.length > 0 ? join(outputDir, 'redirect-map.json') : null,
      outputDir,
      summary: {
        pagesExtracted: wxr.items.filter((i) => i.type === 'page').length,
        postsExtracted: wxr.items.filter((i) => i.type === 'post').length,
        mediaDownloaded: summary.mediaDownloaded.length,
        mediaFailed: summary.mediaFailed.length,
        categoriesFound: wxr.categories.length,
        tagsFound: wxr.tags.length,
        menuItemsFound: wxr.items.filter((i) => i.type === 'nav_menu_item').length,
        failedUrls: summary.failed.length,
        qualityScores,
      },
      failures: summary.failed.map((f) => ({
        url: (f as Record<string, unknown>).url,
        error: (f as Record<string, unknown>).error,
      })),
      wxrValidation: validation,
      dryRun: !!args.dryRun,
      ...(screenshotResult ? { screenshots: screenshotResult } : {}),
    });
  } finally {
    log.releaseLock();
  }
};
