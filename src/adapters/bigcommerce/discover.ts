import { discoverGeneric } from '../discover-generic.js';

/** Stencil's index names typed children, including content pages without path conventions. */
export const discover = (url: string, opts: Record<string, unknown>) =>
	discoverGeneric(url, opts, { extraSitemaps: ['/xmlsitemap.php'] });
