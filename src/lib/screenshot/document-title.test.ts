import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withDocumentTitle } from './document-title.js';
import { captureScreenshots } from './screenshotter.js';

const titles = ( html: string ): string[] => [ ...html.matchAll( /<title\b[^>]*>([\s\S]*?)<\/title>/gi ) ].map( ( match ) => match[ 1 ]! );

describe( 'withDocumentTitle', () => {
	it( 'keeps one head title, in the first title\'s place, holding the document title', () => {
		const html = '<!doctype html><html><head><meta charset="utf-8"><title>Example</title><meta property="og:title" content="A story"><title data-rh="true">A story | Example</title></head><body><h1>A story</h1></body></html>';
		expect( withDocumentTitle( html, 'A story | Example' ) ).toBe(
			'<!doctype html><html><head><meta charset="utf-8"><title>A story | Example</title><meta property="og:title" content="A story"></head><body><h1>A story</h1></body></html>'
		);
	} );

	it( 'leaves body titles, script text and SVG titles alone', () => {
		const html = '<html><head><script>document.write("<title>x</title>")</script><title>Old</title></head><body><svg><title>Icon</title></svg></body></html>';
		const result = withDocumentTitle( html, 'New' );
		expect( result ).toContain( 'document.write("<title>x</title>")' );
		expect( result ).toContain( '<svg><title>Icon</title></svg>' );
		expect( result ).toContain( '<title>New</title></head>' );
	} );

	it( 'escapes the title text and adds a title the head lacks', () => {
		expect( withDocumentTitle( '<html><head></head><body></body></html>', 'A & B </title>' ) ).toBe( '<html><head><title>A &amp; B &lt;/title&gt;</title></head><body></body></html>' );
		expect( withDocumentTitle( '<html><head></head><body></body></html>', '' ) ).toBe( '<html><head></head><body></body></html>' );
	} );
} );

it( 'serializes one title matching document.title when a client hoists its own', async () => {
	// The server renders a site-wide title first; the client hoists the
	// route's title ahead of it, so the browser names the page by the hoist.
	const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title><meta property="og:title" content="A story"><title>A story | Example</title></head>'
		+ '<body><main><h1>A story</h1><p>Story body.</p></main><script>const t = document.createElement("title"); t.textContent = "A story | Example"; '
		+ 'document.head.insertBefore(t, document.head.querySelector("title"));</script></body></html>';
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( page );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/document-title-' ) );
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0, viewports: [ { id: 'desktop', width: 800, height: 600 } ] } );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		expect( titles( readFileSync( join( outputDir, entry.html ), 'utf8' ) ) ).toEqual( [ 'A story | Example' ] );
	} finally {
		server.closeAllConnections();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
