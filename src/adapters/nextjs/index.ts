import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';

export const nextjsAdapter: PlatformAdapter = {
	id: 'nextjs',
	detection,
	discover: discoverDefault,
	resolveImageOriginal( value ) {
		const url = new URL( value );
		const target = url.pathname === '/_next/image' ? url.searchParams.get( 'url' ) : null;
		return target ? new URL( target, url ).href : undefined;
	},
	liberation: {
		// App Router shadow host and Pages Router's reserved announcer id.
		// Never remove authored live regions by ARIA role or visual appearance.
		removeSelectors: ['next-route-announcer', '#__next-route-announcer__'],
		// App Router replaces the whole document with this shell when the client
		// app crashes after hydration ("Application error: a client-side exception
		// has occurred"). A plain load renders the page; the shell is never content.
		clientErrorShellSelectors: ['html#__next_error__'],
	},
};
