import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { it } from '../../test/browser.js';
import { captureWebsite } from '../index.js';

it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'exports options from a data read still pending at baseline admission', async ( { serve } ) => {
	const { origin } = await serve( ( request, response ) => {
		if ( request.url === '/options' ) {
			response.setHeader( 'Content-Type', 'application/json' );
			setTimeout( () => response.end( '["Standard","Group"]' ), 4_300 );
			return;
		}
		if ( request.url !== '/' ) { response.writeHead( 404 ).end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( '<!doctype html><html><head><title>Registration</title></head><body><main><h1>Registration</h1><form><label>Name <input name="name"></label></form></main></body></html>' );
	} );
	const url = `${ origin }/`;
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'form-hydration-' ) );
	try {
		await captureWebsite( { url, outputDir, trustedOrigins: [ url ], deviceMode: 'reflow-only', captureImages: false, learnFluid: false, deferReference: true, templateClusters: false }, {
			findAdapter: () => ( {
				id: 'neutral-form-fixture', detect: () => true, discover: async () => ( { urls: [ { url } ] } ),
				liberation: {
					// Start the read only when the real capture reaches admission, so
					// navigation/probe timings cannot make the fixture pass by chance.
					prepare: async page => {
						const requested = page.waitForRequest( `${ origin }/options` );
						await page.evaluate( () => {
							void fetch( '/options' ).then( response => response.json() ).then( ( options: string[] ) => {
								setTimeout( () => {
									const select = document.createElement( 'select' );
									select.name = 'registration-type';
									for ( const option of options ) select.add( new Option( option ) );
									document.querySelector( 'form' )!.append( select );
								}, 200 );
							} );
						} );
						await requested;
					},
				},
			} ),
		} );
		const html = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		expect( html ).toMatch( /<select\b[^>]*name="registration-type"[^>]*>\s*<option\b[^>]*>Standard<\/option>\s*<option\b[^>]*>Group<\/option>/ );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
