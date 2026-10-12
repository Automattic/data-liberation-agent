import { documentRequestUrl } from './route-key.js';

/**
 * Query keys that name a state-changing action rather than a document.
 *
 * Visiting one is not reading a page: it adds to a cart, removes a cart line,
 * ends a session or opens a comment-moderation view, and is often slow or
 * fails outright. Commerce: `add-to-cart`, `add_to_wishlist`, `remove_item`,
 * `undo_item`, `wc-ajax`. Session: `customer-logout`. Comments: `replytocom`,
 * `unapproved`, `moderation-hash`. Keys match case-insensitively on any host.
 *
 * This is the single list. The platform contract has no discovery-policy hook,
 * so adapters do not extend it; add a key here when a platform needs one.
 */
export const STATE_CHANGING_QUERY_KEYS: readonly string[] = [
	'add-to-cart', 'add_to_wishlist', 'remove_item', 'undo_item', 'wc-ajax',
	'customer-logout',
	'replytocom', 'unapproved', 'moderation-hash',
];

/** `action` query values that change state on any path, `wp-login.php` included. */
const STATE_CHANGING_ACTIONS: readonly string[] = [ 'logout' ];

/** Discovery diagnostic code for a route refused because it is an action URL. */
export const ROUTE_EXCLUDED_ACTION_URL = 'route_excluded_action_url';

/** Unresolved-anchor reason for a link whose target is an action URL. */
export const ACTION_URL_REASON = 'target is a state-changing action URL';

/** The state-changing query parameter a URL carries (`add-to-cart`, `action=logout`), if any. */
export function stateChangingAction( url: string ): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL( url );
	} catch {
		return undefined;
	}
	for ( const [ rawKey, value ] of parsed.searchParams ) {
		const key = rawKey.toLowerCase();
		if ( STATE_CHANGING_QUERY_KEYS.includes( key ) ) return key;
		if ( key === 'action' && STATE_CHANGING_ACTIONS.includes( value.toLowerCase() ) ) return `action=${ value.toLowerCase() }`;
	}
	return undefined;
}

/**
 * Route admission for action URLs, shared by the initial inventory and the
 * linked frontier: the `route_excluded_action_url` diagnostic for a URL that
 * must never be visited as a page, or undefined for an ordinary route. An
 * excluded URL spends no route budget and is never failed, omitted or missing.
 */
export function actionUrlExclusion( url: string ): { code: string; url: string; reason: string } | undefined {
	const action = stateChangingAction( url );
	if ( ! action ) return undefined;
	return { code: ROUTE_EXCLUDED_ACTION_URL, url: documentRequestUrl( url ), reason: `State-changing action URL (query ${ action })` };
}
