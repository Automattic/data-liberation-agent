import type { PlatformAdapter } from '../../types.js';
import { bloggerAcquisition } from './acquisition.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { bloggerImageOriginal } from './media.js';
import { bloggerStructuredContent } from './template-content.js';

export type { BloggerFeedAccounting, BloggerInventory } from './types.js';

export const bloggerAdapter: PlatformAdapter = {
	id: 'blogger',
	detection,
	discover,
	routeScope: sourceUrl => ( {
		origin: new URL( sourceUrl ).origin,
		pathPrefixes: [ '/' ],
		ignoredQueryParams: [ 'updated-max', 'updated-min', 'max-results', 'start', 'by-date', 'reverse-paginate' ],
	} ),
	acquisition: bloggerAcquisition,
	structuredContent: bloggerStructuredContent,
	resolveImageOriginal: bloggerImageOriginal,
};
