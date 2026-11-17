import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { describe, expect } from 'vitest';
import { it, type BrowserFixtures } from '../../../test/browser.js';
import { observePage } from './check.js';
import { scoreViewport } from './score.js';

const skipped = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

describe.skipIf( skipped )( 'embedded third-party frames', () => {
	it( 'scores a cross-origin embed the source shares by its document, not the provider traffic', async ({ serve, newPage }) => {
 const serveBody = (body: (path: string) => string) => serve((request, response) => { response.setHeader('content-type', request.url?.endsWith('.js') ? 'text/javascript' : 'text/html'); response.end(body(request.url ?? '/')); });
		// The provider's document pulls tiles from its own CDN, another host.
		const cdn = await serveBody( () => '' );
		const provider = await serveBody( () => `<script src="${ cdn.origin }/tiles.js"></script>Map` );
		const page = ( frames: string[] ) => `<p>Visit us</p>${ frames.map( src => `<iframe src="${ src }" width="300" height="150"></iframe>` ).join( '' ) }`;
		const other = await serveBody( () => 'Video' );
		const source = await serveBody( () => page( [ `${ provider.origin }/embed` ] ) );
		const faithful = await serveBody( () => page( [ `${ provider.origin }/embed` ] ) );
		const added = await serveBody( () => page( [ `${ provider.origin }/embed`, `${ other.origin }/embed` ] ) );

		{
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
		}
	}, 60_000 );
} );
