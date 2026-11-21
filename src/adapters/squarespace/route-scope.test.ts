import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { routeInScope } from '../../lib/url/route-scope.js';
import { squarespaceAdapter } from './index.js';

const sourceUrl = 'https://site.test/';
const scope = squarespaceAdapter.routeScope!( sourceUrl );

it( 'keeps authored pages and excludes the platform commerce, account and admin routes', () => {
	for ( const path of [ '', 'services', 'cartography', 'shop/p/candle', 'accounting', 'new-page' ] ) expect( routeInScope( sourceUrl + path, scope ) ).toBe( true );
	for ( const path of [ 'cart', 'cart/', 'checkout', 'commerce/orders', 'account', 'account/orders', 'config', 'api/census/RecordHit' ] ) expect( routeInScope( sourceUrl + path, scope ) ).toBe( false );
} );

it( 'reports the cart as an excluded route and keeps the cart icon link external', () => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/squarespace-' ) );
	try {
		for ( const directory of [ 'html', 'screenshots' ] ) mkdirSync( join( outputDir, directory ), { recursive: true } );
		writeFileSync( join( outputDir, 'html/home.html' ), '<html><body><div class="floating-cart hidden"><a href="/cart">Cart</a></div><main><h1>Salon</h1><a href="/services">Services</a></main></body></html>' );
		writeFileSync( join( outputDir, 'html/services.html' ), '<html><body><main><h1>Services</h1></main></body></html>' );
		writeFileSync( join( outputDir, 'html/cart.html' ), '<html><body><main><h2>Shopping Cart</h2><p>You have nothing in your shopping cart.</p></main></body></html>' );
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: {
			[ sourceUrl ]: { html: 'html/home.html' },
			[ `${sourceUrl}services` ]: { html: 'html/services.html' },
			[ `${sourceUrl}cart` ]: { html: 'html/cart.html' },
		} } ) );
		const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir, sourceUrl, platform: 'squarespace', routeScope: scope, summary: {}, failures: [] } ), 'utf8' ) );
		expect( receipt.excludedRoutes ).toEqual( [ `${sourceUrl}cart` ] );
		expect( receipt.routes ).toHaveLength( 2 );
		const home = receipt.routes.find( ( route: { url: string } ) => route.url === sourceUrl );
		const html = readFileSync( join( outputDir, home.path ), 'utf8' );
		expect( html ).toContain( 'href="https://site.test/cart"' );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
