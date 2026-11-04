import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// One real capture (~10s): the final paragraph cannot clear the observer's
// bottom inset at the document's natural maximum scroll position.
it.skipIf( skipBrowser )( 'serializes the revealed end state of a short final paragraph behind a negative rootMargin', async () => {
	const fixture = `<!doctype html><html><head><style>
		body{margin:0}main{padding-top:2400px}p{margin:0;height:24px}
		.reveal{opacity:0;transition:opacity .3s}.reveal.on{opacity:1}
	</style></head><body><main><p id="last" class="reveal">Final paragraph</p></main>
	<script>const observer = new IntersectionObserver(entries => {
		for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add('on');
	}, {rootMargin:'-100px'}); observer.observe(document.querySelector('#last'));</script>
	</body></html>`;
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/entrance-tail-' ) );
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
			viewports: [ { id: 'desktop', width: 800, height: 600 } ] } );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		const html = readFileSync( join( outputDir, entry.html ), 'utf8' );
		expect( html ).toMatch( /<p\b[^>]*id="last"[^>]*class="reveal on"/ );
	} finally {
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
