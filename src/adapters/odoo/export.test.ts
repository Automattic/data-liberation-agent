import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { odooAdapter } from './index.js';

it( 'reports scoped exclusions, keeps account links external and localizes /web resources', () => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/odoo-' ) );
	try {
		for ( const directory of [ 'html', 'screenshots', 'resources/captured' ] ) mkdirSync( join( outputDir, directory ), { recursive: true } );
		const sourceUrl = 'https://site.test/';
		const excluded = [ 'web/login', 'web/signup', 'web/reset_password' ].map( path => sourceUrl + path );
		writeFileSync( join( outputDir, 'html/home.html' ), '<html><body><main><h1>Shop</h1><a href="/web/login">Sign in</a><img src="/web/image/1"></main></body></html>' );
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: {
			[ sourceUrl ]: { html: 'html/home.html' },
			...Object.fromEntries( excluded.map( url => [ url, { html: 'html/home.html' } ] ) ),
		} } ) );
		writeFileSync( join( outputDir, 'resources/captured/image.svg' ), '<svg xmlns="http://www.w3.org/2000/svg"/>' );
		writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources: {
			[ `${sourceUrl}web/image/1` ]: { path: 'resources/captured/image.svg', contentType: 'image/svg+xml' },
		} } ) );
		const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir, sourceUrl, platform: 'odoo', routeScope: odooAdapter.routeScope!( sourceUrl ), summary: {}, failures: [] } ), 'utf8' ) );
		expect( receipt.excludedRoutes ).toEqual( excluded );
		expect( receipt.routes ).toHaveLength( 1 );
		const html = readFileSync( join( outputDir, receipt.routes[ 0 ].path ), 'utf8' );
		expect( html ).toContain( 'href="https://site.test/web/login"' );
		expect( html ).not.toContain( 'src="/web/image/1"' );
		expect( html ).toMatch( /src="[^\"]*\.svg"/ );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
