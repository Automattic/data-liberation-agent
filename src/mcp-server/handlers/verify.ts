import type { Handler } from '../handler-types.js';

export const verifyHandler: Handler = async (args, ctx) => {
  const { verifyExtraction } = await import('../../lib/verification/verify.js');
  const report = await verifyExtraction(args.outputDir as string);
  return ctx.textResult(report);
};
