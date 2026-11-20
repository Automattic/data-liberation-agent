import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { bigcommerceTemplateIdentity } from './template-identity.js';

export const bigcommerceAdapter: PlatformAdapter = {
	id: 'bigcommerce',
	detection,
	discover,
	routeScope: sourceUrl => ({
		origin: new URL(sourceUrl).origin,
		pathPrefixes: ['/'],
		excludedPathPrefixes: [
			'/cart.php', '/login.php', '/account.php', '/checkout.php', '/finishorder.php',
			'/orderstatus.php', '/search.php', '/wishlist.php', '/compare', '/remote.php',
		],
		ignoredQueryParams: ['sort', '_bc_fsnf'],
	}),
	templateIdentity: bigcommerceTemplateIdentity,
	inspection: [
		{ capability: 'commerce', selector: 'a[href*="cart.php?action=add"],form[action*="/cart.php"]', evidence: 'BigCommerce purchasing surface; checkout backend requires migration' },
	],
};
