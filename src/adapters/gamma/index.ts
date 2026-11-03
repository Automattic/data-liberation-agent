import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { nextjsAdapter } from '../nextjs/index.js';
import { prepareGammaPage } from './capture.js';
import { detection } from './detection.js';

// Gamma publishes with Next.js, so it keeps the Next.js cleanup (route
// announcer, client error shell, /_next/image originals) and adds its own.
export const gammaAdapter: PlatformAdapter = {
	id: 'gamma',
	detection,
	discover: discoverDefault,
	resolveImageOriginal: nextjsAdapter.resolveImageOriginal,
	liberation: {
		...nextjsAdapter.liberation,
		prepare: prepareGammaPage,
	},
};
