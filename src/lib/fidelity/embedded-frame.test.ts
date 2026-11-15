import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { describe, expect } from 'vitest';
import { it, type BrowserFixtures } from '../../../test/browser.js';
import { observePage } from './check.js';
import { scoreViewport } from './score.js';

const skipped = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );
const serve = async ( body: ( path: string ) => string ): Promise< { server: Server; origin: string } > => {
	const server = createServer( ( request, response ) => { response.setHeader( 'content-type', request.url?.endsWith( '.js' ) ? 'text/javascript' : 'text/html' ); response.end( body( request.url ?? '/' ) ); } );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return { server, origin: `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }` };
};

describe.skipIf( skipped )( 'embedded third-party frames', () => {
	it( 'scores a cross-origin embed the source shares by its document, not the provider traffic', async ({ newPage }) => {
		// The provider's document pulls tiles from its own CDN, another host.
		const cdn = await serve( () => '' );
		const provider = await serve( () => `<script src="${ cdn.origin }/tiles.js"></script>Map` );
		const page = ( frames: string[] ) => `<p>Visit us</p>${ frames.map( src => `<iframe src="${ src }" width="300" height="150"></iframe>` ).join( '' ) }`;
		const other = await serve( () => 'Video' );
		const source = await serve( () => page( [ `${ provider.origin }/embed` ] ) );
		const faithful = await serve( () => page( [ `${ provider.origin }/embed` ] ) );
		const added = await serve( () => page( [ `${ provider.origin }/embed`, `${ other.origin }/embed` ] ) );

		try {
			const observe = async ( { newPage }: Pick<BrowserFixtures, 'newPage'>, origin: string, local: boolean ) => {
				const tab = await newPage( { viewport: { width: 768, height: 900 } } );
				const observation = await observePage( tab, `${ origin }/`, 768, 0, local ? origin : null, undefined, undefined, false, true );
				await tab.close();
				return observation;
			};
			const sourceObservation = await observe({ newPage },  source.origin, false );
			const hostFailures = ( { newPage }: Pick<BrowserFixtures, 'newPage'>, origin: string ) => observe({ newPage },  origin, true ).then( copy => scoreViewport( sourceObservation, copy ).failures.filter( failure => failure.startsWith( 'copy requested' ) ) );
			expect( await hostFailures({ newPage },  faithful.origin ) ).toEqual( [] );
			expect( await hostFailures({ newPage },  added.origin ) ).toEqual( [ `copy requested 1 external host(s): ${ new URL( other.origin ).host }` ] );
		} finally {

			for ( const { server } of [ cdn, provider, other, source, faithful, added ] ) server.close();
		}
	}, 60_000 );
} );
