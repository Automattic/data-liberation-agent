import { replaySourceReload, SOURCE_NAVIGATION_LIMITS } from '../source-navigation.js';
import { type ProfileDiagnostic } from './manifest-queue.js';
import type { Page, Route } from 'playwright';

const READ_ONLY_METHODS = new Set( [ 'GET', 'HEAD', 'OPTIONS' ] );
const readOnlyProbePages = new WeakMap< Page, { active: number } >();

/** One page-owned handler; baseline and lazy-load requests pass through unchanged. */
export async function installReadOnlyProbeGuard( page: Page, record: ( diagnostic: ProfileDiagnostic ) => void ): Promise< void > {
	if ( ! page.route ) return;
	if ( readOnlyProbePages.has( page ) ) return;
	const state = { active: 0 };
	readOnlyProbePages.set( page, state );
	await page.route( '**/*', async route => {
		const request = route.request();
		if ( ! state.active || READ_ONLY_METHODS.has( request.method() ) ) { await route.fallback(); return; }
		record( { code: 'interaction_request_blocked', reason: `${ request.method() } ${ new URL( request.url() ).pathname } blocked during interaction probing` } );
		await route.fulfill( { status: 204, body: '' } );
	} );
}

/** Scope protection to an interaction drive, including nested probes and failure paths. */
export async function withReadOnlyProbes< T >( page: Page, probe: () => Promise< T > ): Promise< T > {
	const state = readOnlyProbePages.get( page );
	if ( ! state ) return probe();
	state.active++;
	try { return await probe(); }
	finally { state.active--; }
}

/**
 * Keep the page on its route while post-baseline probes drive it. A probe can
 * trigger a navigation no click handler can cancel -- a script assigning
 * `location` after a swatch or card is activated -- and a committed navigation
 * replaces the document, taking the capture's in-page evidence with it, so a
 * route whose baseline was already captured would fail. Aborting main-frame
 * document requests leaves the current document in place; every other request
 * falls through to the capture's existing routing.
 */
export async function lockMainFrameNavigation( page: Page, onAttempt?: ( destination: string ) => void, allowReload = false ): Promise< () => Promise< void > > {
	if ( ! page.route ) return async () => {};
	let reloads = 0;
	const deadline = Date.now() + SOURCE_NAVIGATION_LIMITS.timeoutMs;
	const guard = async ( route: Route ) => {
		const request = route.request();
		// Let the read-only guard record and block unsafe form submissions too.
		if ( readOnlyProbePages.get( page )?.active && ! READ_ONLY_METHODS.has( request.method() ) ) { await route.fallback(); return; }
		if ( request.isNavigationRequest() && request.frame() === page.mainFrame() ) {
			if (allowReload && request.method() === 'GET' && reloads < SOURCE_NAVIGATION_LIMITS.hops && Date.now() < deadline) {
				const current = new URL(page.url()); current.hash = '';
				if (request.url() === current.href) {
					reloads++;
					try { await replaySourceReload(route, current.href, deadline - Date.now()); return; }
					catch { /* A reload changing identity/outcome remains unexplained drift. */ }
				}
			}
			onAttempt?.( request.url() );
			await route.abort( 'aborted' );
			return;
		}
		await route.fallback();
	};
	await page.route( '**/*', guard );
	return async () => {
		await page.unroute( '**/*', guard ).catch( () => {} );
	};
}

