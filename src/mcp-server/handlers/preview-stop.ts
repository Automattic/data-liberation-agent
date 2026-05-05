import type { Handler } from '../handler-types.js';

export const previewStopHandler: Handler = async (args, ctx) => {
  const { stopPreview } = await import('../../lib/preview/playground-server.js');
  const result = await stopPreview({ outputDir: args.outputDir as string });
  return ctx.textResult(result);
};
