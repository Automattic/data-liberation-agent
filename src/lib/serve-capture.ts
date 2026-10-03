import { resolveCheckDirectory } from './fidelity/check.js';
import { startStaticServer, type StaticServer } from './replicate/local-site/static-server.js';

/** Serve the owned portable artifact with the same route resolution as fidelity checks.
 * The caller owns close(); no live-source request or browser is needed.
 */
export function serveCapture( directory: string ): Promise< StaticServer > {
	const { websiteDir } = resolveCheckDirectory( directory );
	return startStaticServer( websiteDir );
}
