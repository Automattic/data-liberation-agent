//
// liberate_compare
// ================
// Thin MCP wrapper over compareScreenshotDirs. Reads an origin screenshot
// dir and a replica screenshot dir, returns the per-pathname desktop/mobile
// parity scores, and writes comparison.json + diff PNGs into the replica dir.
//
import type { Handler } from '../handler-types.js';
import type { ViewportId } from '../../lib/screenshot/compare.js';

export const compareHandler: Handler = async (args, ctx) => {
  const originDir = args.originDir as string;
  const replicaDir = args.replicaDir as string;
  if (!originDir || !replicaDir) {
    return ctx.errorResult('liberate_compare requires originDir + replicaDir');
  }
  const start = Date.now();
  try {
    const { compareScreenshotDirs } = await import('../../lib/screenshot/compare.js');
    const result = await compareScreenshotDirs({
      originDir,
      replicaDir,
      viewports: args.viewports as ViewportId[] | undefined,
      diffOutputDir: args.diffOutputDir as string | undefined,
    });
    console.error(`[compare] ${JSON.stringify({ tool: 'compare', originDir, replicaDir, count: result.results.length, durationMs: Date.now() - start })}`);
    return ctx.textResult(result);
  } catch (e) {
    console.error(`[compare] ${JSON.stringify({ tool: 'compare', originDir, replicaDir, ok: false, durationMs: Date.now() - start })}`);
    return ctx.errorResult((e as Error).message);
  }
};
