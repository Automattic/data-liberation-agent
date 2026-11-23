import type { PlatformAdapter } from '../../types.js';
import { amebaAcquisition } from './acquisition.js';
import { canonicalizeAmebaHtml } from './canonicalize.js';
import { amebaStructuredContent } from './content.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { amebaTemplateIdentity } from './template-identity.js';

export const amebaOwndAdapter: PlatformAdapter = {
	id: 'ameba-ownd',
	detection,
	discover,
	// The blog list pagination repeats the homepage's posts (`/posts/page/1` is
	// the homepage); every post is already reachable from its month archive.
	// Keyword search results are runtime queries, not authored documents.
	routeScope: sourceUrl => ( {
		origin: new URL( sourceUrl ).origin,
		pathPrefixes: [ '/' ],
		excludedPathPrefixes: [ '/posts/page', '/search' ],
	} ),
	templateIdentity: amebaTemplateIdentity,
	structuredContent: amebaStructuredContent,
	acquisition: amebaAcquisition,
	liberation: {
		canonicalizeHtml: canonicalizeAmebaHtml,
		cleanupRules: [
			{
				id: 'ameba-ownd-related-posts', category: 'provider-service', selector: '.complementary--relatedPosts',
				evidence: 'Ameba Ownd picks related posts at runtime for each article; the server sends the widget empty.',
			},
		],
	},
};
