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
		removeSelectors: [
			...( nextjsAdapter.liberation?.removeSelectors ?? [] ),
			// Gamma's empty-image slot: a grey box with an "images" icon, which the
			// published page keeps under the card. Its parent paints the same grey.
			'[data-testid="media-placeholder"]',
		],
		prepare: prepareGammaPage,
	},
};
