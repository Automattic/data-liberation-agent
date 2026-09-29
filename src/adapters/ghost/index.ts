import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import { detection } from './detection.js';

// Ghost themes credit the platform with a link to ghost.org ("Powered by
// Ghost", "Published with Ghost"), so only the link-based credit rule is used.
// The shared plain-text rule also scans <body>, and "Ghost" is an ordinary
// word: on demo.ghost.io/design/ it deleted "created with Ghost" from the
// sentence "new sites are created with Ghost's friendly publication theme".
const ghostCreditRules = providerCreditRules( 'ghost', [ 'ghost.org' ], 'Ghost' )
	.filter( ( rule ) => ! rule.creditText );

// Portal (members) and Sodo Search render their UI at runtime into these
// roots. Portal's floating "Subscribe" trigger is an iframe whose src is the
// live site, so a captured copy would frame the source origin; neither app
// can run without Ghost's members/search APIs.
const RUNTIME_ROOTS = [ '#ghost-portal-root', '#sodo-search-root' ];

// Ghost serves a standard sitemap index (pages, posts, authors, tags), so the
// generic discovery covers it.
export const ghostAdapter: PlatformAdapter = {
	id: 'ghost',
	detection,
	discover: discoverDefault,
	liberation: {
		cleanupRules: ghostCreditRules,
		removeSelectors: RUNTIME_ROOTS,
	},
};
