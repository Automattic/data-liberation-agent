import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

// Two sequential routes, ~5 seconds. The storm starts on a probe, after baseline HTML.
it( 'contains a page-error storm without discarding baseline artifacts (#1022)', async () => {
	const server = createServer( ( _, response ) => response.end( '<!doctype html><title>Fixture</title><main>Baseline</main>' ) );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/page-errors-' ) );
	let stormPage: import('playwright').Page | undefined;
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( {
			urls: [ url, url + 'healthy' ], outputDir, concurrency: 1, settleMs: 0, maxPageErrorsPerSecond: 5,
			viewports: [ { id: 'desktop', width: 800, height: 600 } ],
			prepareCapture: async page => {
				if ( page.url() !== url ) return;
				stormPage = page;
				await page.setContent( `<!doctype html><title>Fixture</title><main><h1>Baseline</h1>
					<button aria-haspopup="dialog" onclick="setInterval(() => { for(let i=0;i<20;i++) setTimeout(() => { throw new RangeError('storm') },0) },1)">Open</button></main>` );
			},
		} );
		const entries = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries;
		const entry = entries[ url ];
		expect( entries[ url + 'healthy' ].html ).toBeTruthy();
		expect( entries[ url + 'healthy' ].profiles.desktop.diagnostics ).toBeUndefined();
		expect( entry.profiles.desktop.diagnostics ).toContainEqual( { code: 'page_error_storm', reason: expect.stringContaining( 'more than 5 in one second' ) } );
		expect( readFileSync( join( outputDir, entry.html ), 'utf8' ) ).toContain( '<h1>Baseline</h1>' );
		expect( entry.profiles.desktop.phases.map( ( row: { phase: string } ) => row.phase ) ).not.toContain( 'selectable' );
		expect( entry.profiles.desktop.phases.map( ( row: { phase: string } ) => row.phase ) ).not.toContain( 'scroll-states' );
		expect( stormPage?.isClosed() ).toBe( true );
		expect( result.browserRestarts ).toBe( 0 );
	} finally {
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 30_000 );
