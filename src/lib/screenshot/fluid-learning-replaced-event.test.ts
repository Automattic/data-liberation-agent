import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

// Source libraries such as MooTools replace window.Event with their own class,
// whose constructor dereferences a native event it never receives. Capture's
// in-page scroll dispatch must not depend on the page's window.Event (#763).
it.skipIf( process.env.SKIP_BROWSER_TESTS )( 'learns fluid geometry when the source replaces window.Event', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'issue-763-replaced-event-' ) );
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( `<!doctype html><html><head><title>T</title>
			<script>window.Event = function ( event ) { this.target = event.target.nodeType; };</script>
			<style>main{max-width:960px;margin:0 auto}section{height:1400px}</style></head>
			<body><main><h1>Replaced Event</h1><div id="box" style="width:900px">Box</div><section>Tall</section></main>
			<script>var size = function () { document.getElementById( 'box' ).style.width = Math.round( innerWidth * 0.8 ) + 'px'; };
			size(); addEventListener( 'resize', size );</script></body></html>` );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	try {
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0, learnFluid: true } );
		expect( result.failed ).toBe( 0 );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		expect( entry.fluid ).toBeDefined();
		expect( entry.fluid.diagnostic ).toBeUndefined();
		expect( entry.fluidMobile?.diagnostic ).toBeUndefined();
	} finally {
		await new Promise( resolve => server.close( resolve ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
