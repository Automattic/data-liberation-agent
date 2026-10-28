import type { Page } from 'playwright';

/**
 * A one-second bucket permits thousands of incidental errors, but cuts off well
 * below the observed ~10,000/s runaway. This is a containment policy, not a
 * claimed Chromium crash threshold. Bucket boundaries can admit two bursts.
 */
export const MAX_PAGE_ERRORS_PER_SECOND = 2_000;
export const PAGE_ERROR_STORM = 'page_error_storm';

/** Count without retaining Error objects or stacks; close only this profile. */
export function guardPageErrors( page: Page, onStorm: ( reason: string ) => void, limit = MAX_PAGE_ERRORS_PER_SECOND ) {
	// Invalid overrides must not silently disable containment.
	limit = Number.isFinite( limit ) && limit >= 1 ? Math.floor( limit ) : MAX_PAGE_ERRORS_PER_SECOND;
	let total = 0;
	let count = 0;
	let start = Date.now();
	let stopped = false;
	const onError = () => {
		total++;
		if ( stopped ) return;
		const now = Date.now();
		if ( now - start >= 1_000 ) { start = now; count = 0; }
		if ( ++count <= limit ) return;
		stopped = true;
		onStorm( `${ total } uncaught page errors; more than ${ limit } in one second; profile context closed` );
		void page.context().close().catch( () => {} );
	};
	page.on( 'pageerror', onError );
	return {
		stopped: () => stopped,
		dispose: () => page.off( 'pageerror', onError ),
	};
}
