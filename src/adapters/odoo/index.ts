import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';

export const odooAdapter: PlatformAdapter = {
	id: 'odoo',
	detection,
	discover: discoverDefault,
	// /web is Odoo's application, not its public website. This scopes only
	// documents: /web/assets, /web/image and /web/content remain resources.
	routeScope: sourceUrl => ( {
		origin: new URL( sourceUrl ).origin,
		pathPrefixes: [ '/' ],
		excludedPathPrefixes: [ '/web' ],
	} ),
};
