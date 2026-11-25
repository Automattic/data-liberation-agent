import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { desktopContextOptions } from '../browser-kit/browser-kit.js';
import { createSourceContext } from '../browser-kit/source-identity.js';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { reportReadiness, waitForStable, type SettleOutcome } from './page-helpers.js';

// A throttled source (#2278): a booking form mounts its Combo Meal select from
// a same-origin menu API response. While this capture's governor holds that
// fetch for the source's pause, the source has not been asked yet; the
// readiness bound must not be spent on the capture's own hold, or the route is
// serialized without the select every reference cell later shows.
const PAUSE_SECONDS = 7;

describe.skipIf( !! process.env.SKIP_BROWSER_TESTS || ! existsSync( chromium.executablePath() ) )( 'readiness under the capture\'s own source pacing (real Chromium)', () => {
	// About 9 seconds: one page whose hydration fetch is held 7s by the governor.
	it( 'waits for a hydration fetch the source governor held past the readiness bound', async ( { browser, serve } ) => {
		const { origin } = await serve( ( request, response ) => {
			if ( request.url === '/menu-items' ) {
				response.setHeader( 'content-type', 'application/json' );
				response.end( '["Combo A","Combo B"]' );
				return;
			}
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<!doctype html><title>Booking</title><h1>Booking</h1><form id="booking"></form>
				<script>
					setTimeout( () => fetch( '/menu-items' ).then( ( r ) => r.json() ).then( ( items ) => {
						const select = document.createElement( 'select' );
						select.id = 'combo';
						for ( const item of items ) select.append( new Option( item ) );
						document.getElementById( 'booking' ).append( select );
					} ), 300 );
				</script>` );
		} );
		const governors = new SourceRequestGovernors();
		const context = await createSourceContext( browser, await desktopContextOptions( browser ), { governors, sourceUrl: origin } );
		try {
			const page = await context.newPage();
			const waits: Array< { wait: string } & SettleOutcome > = [];
			reportReadiness( page, ( wait, outcome ) => waits.push( { wait, ...outcome } ) );
			await page.goto( `${ origin }/booking`, { waitUntil: 'load', timeout: 15_000 } );
			// The source throttles: every further load waits out its pause.
			governors.forOrigin( origin ).observeBrowserOutcome( 429, String( PAUSE_SECONDS ) );
			await waitForStable( page );
			expect( waits.find( ( w ) => w.wait === 'network-quiet' )?.reason ).toBe( 'quiet' );
			expect( await page.evaluate( () => document.querySelectorAll( '#combo option' ).length ) ).toBe( 2 );
		} finally {
			await context.close();
		}
	}, 45_000 );
} );
