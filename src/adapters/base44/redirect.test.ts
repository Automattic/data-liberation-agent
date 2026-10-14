import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { resolveClientRedirect, CLIENT_REDIRECT_PROBE_MS, CLIENT_REDIRECT_POLL_MS } from './redirect.js';
import { isRouteDrift, serverRedirectTarget } from '../../lib/screenshot/document-integrity.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'Base44 client rewrite seam', () => {
	// Base44 rewrites an unavailable members-only route with history.pushState:
	// the URL bar changes without a navigation request, which the capture's
	// main-frame navigation guard cannot see or block.
	const cases = [
		{ name: 'same-site pushState rewrite declared as the alias', expectAlias: true },
		{ name: 'a route that stays on its own path stays uncaptured', expectAlias: false },
	] as const;

	for ( const { name, expectAlias } of cases ) {
		it( name, async () => {
			const origin = createServer( ( request, response ) => {
				const drift = expectAlias && request.url === '/';
				response.writeHead( 200, { 'content-type': 'text/html' } );
				response.end( `<!doctype html><h1>shell</h1><script>setTimeout(function(){history.replaceState(null,'',${ JSON.stringify( drift ? '/login?from_url=%2F' : '' ) });},200);</script>` );
			} );
			await new Promise< void >( ( resolve ) => origin.listen( 0, '127.0.0.1', resolve ) );
			const url = `http://127.0.0.1:${ ( origin.address() as { port: number } ).port }/`;
			const browser = await chromium.launch();
			try {
				const page = await browser.newPage();
				await page.goto( url, { waitUntil: 'load' } );
				const target = await resolveClientRedirect( page, url );
				if ( expectAlias ) {
					expect( target ).toBe( `${ new URL( url ).origin }/login?from_url=%2F` );
					// The predicate is the caller's own alias proof (screenshotter.ts):
					// only a same-site path departure is declared.
					expect( serverRedirectTarget( url, target! ) ).toBe( target );
					expect( isRouteDrift( target!, url ) ).toBe( true );
				} else expect( target ).toBeUndefined();
			} finally {
				await browser.close();
				origin.closeAllConnections();
				await new Promise< void >( ( resolve ) => origin.close( () => resolve() ) );
			}
		}, 60_000 );
	}

	it( 'keeps the probe bounded for capture time budgeting', () => {
		expect( CLIENT_REDIRECT_POLL_MS ).toBeLessThan( CLIENT_REDIRECT_PROBE_MS );
		expect( CLIENT_REDIRECT_PROBE_MS ).toBeLessThanOrEqual( 2 * 1_000 );
	} );
} );
