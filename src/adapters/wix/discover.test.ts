import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { discover } from './discover.js';

it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'retries a transient sitemap failure but not a missing optional sitemap', async ( { serve } ) => {
	const requests: Record< string, number > = {};
	let origin = '';
	( { origin } = await serve( ( request, response ) => {
		const path = request.url ?? '/';
		requests[ path ] = ( requests[ path ] ?? 0 ) + 1;
		if ( path === '/sitemap.xml' && requests[ path ] === 1 ) { response.writeHead( 503 ).end(); return; }
		if ( path === '/sitemap.xml' ) {
			response.setHeader( 'Content-Type', 'application/xml' );
			response.end( `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ origin }/</loc></url></urlset>` );
			return;
		}
		if ( path === '/' ) { response.setHeader( 'Content-Type', 'text/html' ); response.end( '<!doctype html><title>Home</title><nav><a href="/">Home</a></nav>' ); return; }
		response.writeHead( 404 ).end();
	} ) );
	const inventory = await discover( origin, {} );
	expect( inventory.urls.map( ( row ) => row.url ) ).toEqual( [ `${ origin }/` ] );
	expect( requests[ '/sitemap.xml' ] ).toBe( 2 );
	for ( const optional of [ '/blog-posts-sitemap.xml', '/store-products-sitemap.xml', '/forum-posts-sitemap.xml' ] ) expect( requests[ optional ] ).toBe( 1 );
	expect( inventory.diagnostics ).toEqual( [] );
}, 120_000 );
