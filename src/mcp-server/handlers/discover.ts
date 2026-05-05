import { detect } from '../../lib/extraction/detect-platform.js';
import type { Handler } from '../handler-types.js';

export const discoverHandler: Handler = async (args, ctx) => {
  const detection = await detect(args.url as string);
  const adapter = ctx.findAdapter(detection.platform);
  if (!adapter) {
    return ctx.errorResult(
      `No adapter available for platform: ${detection.platform}. Supported: ${
        ctx.adapters.map((a) => a.id).join(', ') || 'none (install an adapter)'
      }`,
    );
  }
  const opts = {
    token: args.token,
    cdpPort: args.cdpPort,
    verbose: args.verbose,
  };
  const inventory = await adapter.discover(args.url as string, opts);

  const { detectFeatures } = await import('../../lib/features/detect-features.js');
  const inv = inventory as { urls?: Array<{ url: string }> };
  const urls = (inv.urls || []).map((u) => u.url);
  const platformFeatures = detectFeatures(detection.platform, urls, []);

  return ctx.textResult({ ...(inventory as object), platformFeatures });
};
