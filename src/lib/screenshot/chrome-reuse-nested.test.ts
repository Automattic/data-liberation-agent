import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import type { ManifestEntry } from './manifest-queue.js';

// One desktop pipeline pass, three local pages; approximately 30 seconds.
// Before #1610: two nav clicks and one content click per interior route.
// After: zero nav clicks and one content click, with negative outcomes reused.
it.skipIf( ! existsSync( chromium.executablePath() ) )( 'reuses nested nav negative outcomes without skipping page content', async () => {
	const clicks: Array<{ path: string; control: string }> = [];
	const server = createServer( ( request, response ) => {
		if ( request.url?.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		const url = new URL( request.url!, 'http://fixture' );
		if ( url.pathname === '/click' ) {
			clicks.push( { path: url.searchParams.get( 'path' )!, control: url.searchParams.get( 'control' )! } );
			response.end();
			return;
		}
		response.setHeader( 'content-type', 'text/html' );
		response.end( `<!doctype html><style>body{font:16px Arial}nav ul{display:flex;gap:20px}button{cursor:pointer}</style>
<header><img width="100" height="20" alt="Banner ${ url.pathname }" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><h1>Page ${ url.pathname }</h1>
<nav><ul><li><button data-control="nav-a" aria-haspopup="menu">Courses</button><ul><li>Submenu A</li></ul></li><li><button data-control="nav-b" aria-haspopup="menu">Services</button><ul><li>Submenu B</li></ul></li></ul></nav></header>
<main><button data-control="content" aria-haspopup="dialog">Content</button></main>
<script>document.addEventListener('click', e => { const b=e.target.closest('button'); if(b) fetch('/click?path='+encodeURIComponent(location.pathname)+'&control='+b.dataset.control); });</script>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'nested-chrome-' ) );
	try {
		const urls = [ '/', '/two', '/three' ].map( path => origin + path );
		await captureScreenshots( {
			urls, primaryUrl: urls[ 0 ], outputDir, concurrency: 1, settleMs: 50,
			learnFluid: false, force: true, sharedChrome: true,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		} );
		const { entries } = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) ) as { entries: Record<string, ManifestEntry> };
		const counts = urls.slice( 1 ).map( url => {
			const path = new URL( url ).pathname;
			return { path, nav: clicks.filter( click => click.path === path && click.control.startsWith( 'nav-' ) ).length, content: clicks.filter( click => click.path === path && click.control === 'content' ).length };
		} );
		console.log( 'nested chrome route probe clicks:', JSON.stringify( counts ) );
		for ( const [ index, url ] of urls.slice( 1 ).entries() ) {
			expect( counts[ index ]!.nav ).toBe( 0 );
			expect( counts[ index ]!.content ).toBeGreaterThan( 0 );
			expect( entries[ url ]!.sharedChrome ).toMatchObject( { chromeReused: true, nestedMatches: 1, reusedOutcomes: expect.any( Number ) } );
			expect( entries[ url ]!.sharedChrome!.reusedOutcomes ).toBeGreaterThanOrEqual( 2 );
			expect( entries[ url ]!.interactions!.components?.filter( component => component.selector.includes( 'nav' ) ).flatMap( component => component.transitions ) ?? [] ).toEqual( [] );
			expect( entries[ url ]!.interactions!.states.filter( state => state.trigger.selector.includes( 'nav' ) ) ).toEqual( [] );
			expect( entries[ url ]!.sharedChrome!.reason ).toContain( '1 nested landmarks matched' );
			expect( entries[ url ]!.interactions!.states.some( state => state.trigger.selector.includes( 'main' ) && ! state.reusedFrom ) ).toBe( true );
		}
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 180_000 );
