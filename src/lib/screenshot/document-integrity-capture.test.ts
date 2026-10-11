import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { countBodyTags } from './document-integrity.js';

// Issue #763: a `<body` inside script text is not a second document, while a
// document genuinely stacked into itself still is. One real-Chromium capture
// per page; wall time is roughly 20s for both.
const popupHelper = `<!doctype html><html><head><title>Popup helper</title></head><body>
  <script>
    function preview(link) {
      var w = window.open("#", "image_preview", "width=600,height=400");
      w.document.write('<body leftmargin="0" topmargin="0"><img src="' + link + '" /></body>');
    }
  </script>
  <h1>Real page</h1>
</body></html>`;

const stacked = `<!doctype html><html><head><title>Stacked</title></head><body><h1>Real page</h1>
  <script>document.body.appendChild(document.createElement('body')).textContent = 'nested document';</script>
</body></html>`;

describe( 'document integrity during capture', () => {
	const pages: Record< string, string > = { '/popup': popupHelper, '/stacked': stacked };
	let server: Server;
	let origin: string;
	let outputDir: string;

	beforeAll( async () => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		outputDir = mkdtempSync( join( parent, 'issue-763-' ) );
		server = createServer( ( request, response ) => {
			response.setHeader( 'Content-Type', 'text/html' );
			response.end( pages[ request.url ?? '' ] ?? '' );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	} );
	afterAll( async () => {
		await new Promise( resolve => server.close( resolve ) );
		rmSync( outputDir, { recursive: true, force: true } );
	} );

	it( 'persists a page whose script text contains "<body" with no failed route', async () => {
		const url = `${ origin }/popup`;
		const result = await captureScreenshots( { urls: [ url ], outputDir: join( outputDir, 'popup' ), concurrency: 1, settleMs: 0, learnFluid: true } );
		expect( result.failed ).toBe( 0 );
		const manifest = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) );
		const entry = manifest.entries[ url ];
		const html = readFileSync( join( outputDir, 'popup', entry.html ), 'utf8' );
		expect( html ).toContain( 'w.document.write' );
		expect( countBodyTags( html ) ).toBe( 1 );
		// Fluid learning ran and recorded an outcome (applied, or a diagnostic).
		expect( entry.fluid ).toBeDefined();
	}, 60_000 );

	it( 'still refuses a document genuinely stacked into itself', async () => {
		const url = `${ origin }/stacked`;
		const result = await captureScreenshots( { urls: [ url ], outputDir: join( outputDir, 'stacked' ), concurrency: 1, settleMs: 0 } );
		expect( result.failed ).toBe( 1 );
		const failures = JSON.parse( readFileSync( join( outputDir, 'stacked', 'screenshots', 'failures.json' ), 'utf8' ) );
		expect( failures[ 0 ].error ).toMatch( /nested document capture \(2 <body> in one page\)/ );
		expect( existsSync( join( outputDir, 'stacked', 'html', 'homepage.html' ) ) ).toBe( false );
	}, 60_000 );
} );
