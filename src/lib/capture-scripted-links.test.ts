import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// A client-routed site whose links are scripted click targets (#1465): the
// router renders from its own state, so a cancelled pushState still replaces
// the nodes, and popstate renders the address bar's route again.
const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px}.card{padding:12px;border:1px solid #ccc;margin:8px 0}</style>
</head><body><main id="app"></main>
<script>
let current = location.pathname;
function render() {
	const app = document.querySelector('#app');
	app.innerHTML = '<h1>Page ' + current + '</h1>' +
		'<div role="link" tabindex="0" id="push" class="card">Work</div>' +
		'<div role="link" tabindex="0" id="assign" class="card" aria-label="About me"><span>About</span></div>' +
		'<div role="link" tabindex="0" id="control" class="card">Nothing</div>';
	app.querySelector('#push').onclick = () => setTimeout(() => { current = '/work'; history.pushState({}, '', '/work'); render(); }, 150);
	app.querySelector('#assign').onclick = () => location.assign('/about');
	app.querySelector('#control').onclick = () => { document.body.dataset.clicked = 'yes'; };
}
addEventListener('popstate', () => { current = location.pathname; render(); });
render();
</script></body></html>`;

it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'exports scripted role=link destinations as anchors to the portable routes through the public capture API', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'scripted-links-' ) );
	const server = createServer( ( request, response ) => {
		if ( request.url?.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.statusCode = 404; response.end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( source );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	try {
		const result = await captureWebsite( { url, outputDir: root, captureImages: false, trustedOrigins: [ url ], learnFluid: false }, {
			findAdapter: () => ( { id: 'scripted-links', detect: () => true, discover: async () => ( { urls: [ url, `${ url }work`, `${ url }about` ].map( url => ( { url } ) ) } ) } ),
		} );
		expect( result.summary.routesFailed ).toBe( 0 );
		const website = join( root, 'website' );
		const $ = cheerio.load( readResolvedPage( website, join( website, 'index.html' ) ) );
		const target = ( id: string ) => new URL( $( `#${ id }` ).attr( 'href' ) ?? '', `${ url }index.html` ).pathname;
		for ( const id of [ 'push', 'assign' ] ) {
			expect( $( `#${ id }` ).length ).toBeGreaterThan( 0 );
			$( `#${ id }` ).each( ( _index, node ) => expect( $( node ).prop( 'tagName' )?.toLowerCase() ).toBe( 'a' ) );
			expect( $( `#${ id }` ).attr( 'role' ) ).toBeUndefined();
			expect( $( `#${ id }` ).attr( 'class' ) ).toBe( 'card' );
		}
		expect( target( 'push' ) ).toBe( '/work/index.html' );
		expect( target( 'assign' ) ).toBe( '/about/index.html' );
		expect( $( '#assign' ).attr( 'aria-label' ) ).toBe( 'About me' );
		expect( $( '#assign > span' ).text() ).toBe( 'About' );
		// A click that changes nothing stays an unlinked scripted element.
		$( '#control' ).each( ( _index, node ) => expect( $( node ).prop( 'tagName' )?.toLowerCase() ).toBe( 'div' ) );
		expect( $( '#control' ).attr( 'role' ) ).toBe( 'link' );
		expect( $( '#control' ).attr( 'href' ) ).toBeUndefined();
		const receipt = JSON.parse( readFileSync( join( root, 'capture-receipt.json' ), 'utf8' ) ) as {
			scriptedLinks?: { pages: Array< { url: string; profiles: Record< string, { candidates: number; resolved: number; unresolved: number } > } > };
		};
		const home = receipt.scriptedLinks?.pages.find( page => page.url === url );
		expect( home?.profiles.desktop ).toMatchObject( { candidates: 3, resolved: 2, unresolved: 1 } );
	} finally {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 180_000 );
