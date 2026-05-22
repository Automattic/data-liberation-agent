import type { Handler } from '../handler-types.js';
import { extractSignature } from '../../lib/replicate/section-extract.js';

export const sectionExtractHandler: Handler = async (args, ctx) => {
  const url = args.url as string | undefined;
  const detail = args.detail as string | undefined;
  if (!url || !detail) return ctx.errorResult('url and detail are required');
  if (detail === 'signature') {
    const html = args.html as string | undefined;
    if (!html) return ctx.errorResult('html is required for detail=signature');
    return ctx.textResult(extractSignature(url, html, html.length));
  }
  return ctx.errorResult('detail=full is not available via this entry; runs in the capture pipeline');
};
