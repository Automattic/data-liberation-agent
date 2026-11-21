import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect } from 'vitest';
import { it } from '../../test/browser.js';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';
import { bindPictureCurrentSources } from './capture-export-render.js';

// One public dual-document capture of an art-directed <picture> (~20s). The
// phone-only body class gates desktop CSS, so both device copies ship.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'records the rendered picture source of each device copy as a localized URL', async ( { serve } ) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const root = mkdtempSync( join( process.cwd(), '.tmp-test/picture-current-src-' ) );
	const page = ( phone: boolean ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Picture</title><style>body:not(.phone) p{color:#333}</style></head><body${ phone ? ' class="phone"' : '' }>
		<main><picture><source media="(max-width: 750px)" srcset="/images/phone-crop.svg"><img alt="Hero" src="/images/desktop-wide.svg" width="400" height="200"></picture>
		${ phone ? '<section><p>Phone layout</p></section>' : '' }<p>Art direction</p></main></body></html>`;
	const { server } = await serve( ( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.writeHead( 404 ).end(); return; }
		if ( request.url?.endsWith( '.svg' ) ) {
			response.setHeader( 'Content-Type', 'image/svg+xml' );
			response.end( `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><text y="20">${ request.url }</text></svg>` );
			return;
		}
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( page( /Mobile/.test( request.headers[ 'user-agent' ] ?? '' ) ) );
	} );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;

	try {
		const result = await captureWebsite( { url, outputDir: root, trustedOrigins: [ url ], learnFluid: false }, {
			findAdapter: () => ( { id: 'neutral-picture', detect: () => true, discover: async () => ( { urls: [ { url } ] } ) } ),
		} );
		expect( result.summary.routesFailed ).toBe( 0 );
		const website = join( root, 'website' );
		const $ = cheerio.load( readResolvedPage( website, join( website, 'index.html' ) ) );
		const copy = ( scope: string ) => {
			const picture = $( `.data-blocks-engine-capture-${ scope }-document picture` );
			expect( picture ).toHaveLength( 1 );
			return { source: picture.find( 'source' ).attr( 'srcset' )!, img: picture.find( 'img' ).attr( 'src' )!, current: picture.find( 'img' ).attr( 'data-blocks-engine-capture-current-src' ) };
		};
		const mobile = copy( 'mobile' );
		const desktop = copy( 'desktop' );
		for ( const { source, img } of [ mobile, desktop ] ) {
			for ( const local of [ source, img ] ) {
				expect( local ).toMatch( /^\/media\// );
				expect( existsSync( join( website, local ) ) ).toBe( true );
			}
			expect( source ).not.toBe( img );
		}
		expect( mobile.current ).toBe( mobile.source );
		expect( desktop.current ).toBe( desktop.img );
	} finally {
		rmSync( root, { recursive: true, force: true } );
	}
}, 90_000 );

it( 'keeps rendered-source evidence only when it names a local file the picture references', () => {
	const html = ( current: string ) => `<picture><source srcset="/media/a.jpg 1x"><img src="/media/b.jpg" data-blocks-engine-capture-current-src="${ current }"></picture>`;
	const local = () => true;
	expect( bindPictureCurrentSources( html( '/media/a.jpg' ), local ) ).toBe( html( '/media/a.jpg' ) );
	expect( bindPictureCurrentSources( html( '/media/b.jpg' ), local ) ).toBe( html( '/media/b.jpg' ) );
	for ( const current of [ 'https://source.test/a.jpg', '/media/c.jpg', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' ] ) {
		expect( bindPictureCurrentSources( html( current ), local ) ).not.toContain( 'current-src' );
	}
	expect( bindPictureCurrentSources( html( '/media/a.jpg' ), () => false ) ).not.toContain( 'current-src' );
} );
