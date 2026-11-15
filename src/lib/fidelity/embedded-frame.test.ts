import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { observePage } from './check.js';
import { scoreViewport } from './score.js';

const skipped = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );
const serve = async ( body: ( path: string ) => string ): Promise< { server: Server; origin: string } > => {
	const server = createServer( ( request, response ) => { response.setHeader( 'content-type', request.url?.endsWith( '.js' ) ? 'text/javascript' : 'text/html' ); response.end( body( request.url ?? '/' ) ); } );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return { server, origin: `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }` };
};

describe.skipIf( skipped )( 'embedded third-party frames', () => {
	it( 'scores a cross-origin embed the source shares by its document, not the provider traffic', async () => {
		// The provider's document pulls tiles from its own CDN, another host.
		const cdn = await serve( () => '' );
		const provider = await serve( () => `<script src="${ cdn.origin }/tiles.js"></script>Map` );
		const page = ( frames: string[] ) => `<p>Visit us</p>${ frames.map( src => `<iframe src="${ src }" width="300" height="150"></iframe>` ).join( '' ) }`;
		const other = await serve( () => 'Video' );
		const source = await serve( () => page( [ `${ provider.origin }/embed` ] ) );
		const faithful = await serve( () => page( [ `${ provider.origin }/embed` ] ) );
		const added = await serve( () => page( [ `${ provider.origin }/embed`, `${ other.origin }/embed` ] ) );
		const browser = await chromium.launch();
		try {
			const observe = async ( origin: string, local: boolean ) => {
				const tab = await browser.newPage( { viewport: { width: 768, height: 900 } } );
				const observation = await observePage( tab, `${ origin }/`, 768, 0, local ? origin : null, undefined, undefined, false, true );
				await tab.close();
				return observation;
			};
			const sourceObservation = await observe( source.origin, false );
			const hostFailures = ( origin: string ) => observe( origin, true ).then( copy => scoreViewport( sourceObservation, copy ).failures.filter( failure => failure.startsWith( 'copy requested' ) ) );
			expect( await hostFailures( faithful.origin ) ).toEqual( [] );
			expect( await hostFailures( added.origin ) ).toEqual( [ `copy requested 1 external host(s): ${ new URL( other.origin ).host }` ] );
		} finally {
			await browser.close();
			for ( const { server } of [ cdn, provider, other, source, faithful, added ] ) server.close();
		}
	}, 60_000 );
} );
