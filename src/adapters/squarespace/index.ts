import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import { capture } from './capture.js';
import { templateStyleNormalization } from './template-styles.js';
import { squarespaceStructuredContent } from './template-content.js';
import { squarespaceAcquisition } from './acquisition.js';

export type { SquarespaceInventory, SquarespaceAdapterOpts } from './types.js';

export const squarespaceAdapter: PlatformAdapter = {
  // Squarespace page-view analytics (`RecordHit`, `render-batch`); fires on every load.
  sourceTelemetry: ['/api/census/'],
  id: 'squarespace', detection, discover, templateStyleNormalization, structuredContent: squarespaceStructuredContent,
  acquisition: squarespaceAcquisition,
	// Commerce, customer-account and admin routes are the platform's runtime,
	// not authored pages: /cart is linked from every page's (often hidden) cart
	// icon and would otherwise import as a frozen "nothing in your cart" page.
	// This scopes only documents; links to these routes stay external.
	routeScope: sourceUrl => ( {
		origin: new URL( sourceUrl ).origin,
		pathPrefixes: [ '/' ],
		excludedPathPrefixes: [ '/cart', '/checkout', '/commerce', '/account', '/config', '/api' ],
	} ),
  // Scroll-animation states depend on which elements entered the viewport.
  runtimeStateClasses: [/^pre(Scale|Fade|Slide|Clip|Flex)$/, /^(scale|fade|slide|clip|flex)In$/],
  liberation: { ...capture, cleanupRules: providerCreditRules('squarespace', ['squarespace.com'], 'Squarespace') },
};
