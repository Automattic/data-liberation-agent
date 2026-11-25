import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SourceRequestGovernors } from './source-request-governor.js';
import { TemplateClusterDeferral, type CapturedProfiles } from './template-cluster-deferral.js';

/**
 * A deferred member leaves the browser pass, so the deferral must prove every
 * document post-capture derivation derives for it: on a source that serves
 * its phone identity its own server document (Wix's mobile site), that is the
 * phone document too, derived from the phone server pair.
 */
const PHONE = 'Mozilla/5.0 (iPhone) Phone';
const desktop = ( title: string ) => `<!doctype html><html><head><title>${ title }</title></head><body><main class="entry"><h1>${ title }</h1><p>Shared desktop copy.</p></main></body></html>`;
const phone = ( title: string ) => `<!doctype html><html><head><title>${ title }</title></head><body><div class="phone"><h2>${ title }</h2><p>Shared phone copy.${ title === '/post/embed/' ? '<iframe src="https://example.com/player"></iframe>' : '' }</p></div></body></html>`;

let server: Server;
let origin = '';

beforeAll( async () => {
	server = createServer( ( request, response ) => {
		const path = ( request.url ?? '/' ).split( '?' )[ 0 ]!;
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.headers[ 'user-agent' ] === PHONE ? phone( path ) : desktop( path ) );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
} );

afterAll( () => new Promise< void >( resolve => server.close( () => resolve() ) ) );

it( 'defers only members whose phone document derives from the phone server pair', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-cluster-deferral-profiles-' ) );
	mkdirSync( join( outputDir, 'html' ) );
	mkdirSync( join( outputDir, 'html-mobile' ) );
	const [ representative, verifier, plain, embed ] = [ '/post/rep/', '/post/a/', '/post/plain/', '/post/embed/' ].map( path => `${ origin }${ path }` );
	const group = { size: 4, representative: representative!, members: [ representative!, verifier!, plain!, embed! ] };
	const deferral = new TemplateClusterDeferral( { sourceUrl: `${ origin }/`, outputDir, governors: new SourceRequestGovernors() }, () => [ group ] );
	try {
		// The browser pass captured the representative and the verifier, each
		// with a phone document built from the phone server document.
		for ( const [ index, url ] of [ representative!, verifier! ].entries() ) {
			const path = new URL( url ).pathname;
			writeFileSync( join( outputDir, `html/${ index }.html` ), desktop( path ) );
			writeFileSync( join( outputDir, `html-mobile/${ index }.html` ), phone( path ) );
			const profiles = {
				desktop: { html: `html/${ index }.html`, viewport: { width: 1440, height: 900 } },
				mobile: { html: `html-mobile/${ index }.html`, userAgent: PHONE, viewport: { width: 402, height: 681 } },
			} as unknown as CapturedProfiles;
			deferral.routeCaptured( url, `html/${ index }.html`, undefined, profiles );
		}
		await deferral.close();
		// Both desktop documents derive; only the embed's phone document
		// carries an embed capture never observed.
		expect( [ plain!, embed! ].map( url => deferral.defers( url ) ) ).toEqual( [ true, false ] );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
