import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// Different server documents, not a viewport-driven device switch. The wide
// stylesheet boundary is unrelated to the fixed phone document's design width.
function fixture( phone: boolean ) {
	return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}main{height:200px;background:teal}
	@media(max-width:1439px){aside{color:gray}}</style></head>
	<body class="${ phone ? 'phone' : 'desktop' }"><main style="${ phone ? 'position:absolute;left:0;top:0;width:390px' : 'width:100%' }">
	${ phone ? '<section><h1>Phone document</h1><p>Compact identity</p></section>' : '<h1>Desktop document</h1><nav>Wide identity</nav>' }</main><aside>Unrelated breakpoint</aside></body></html>`;
}

it( 'keeps a fixed server-selected phone document out of tablet widths', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fixed-phone-' ) );
	let portable: string | undefined;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' ? portable : fixture( /iPhone|Android/.test( request.headers[ 'user-agent' ] ?? '' ) ) );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const sourceUrl = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch();
	try {
		const capture = await captureScreenshots( {
			urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0, deviceMode: 'auto',
			learnFluid: true, fluidWidths: [ 390, 402, 768, 1024, 1440 ],
		} );
		expect( capture.failed ).toBe( 0 );
		expect( capture.deviceMode?.mode ).toBe( 'dual' );
		expect( capture.deviceMode?.serverHtml ).toBe( 'different' );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		expect( manifest.entries[ sourceUrl ].deviceMode?.switchWidth ).toBeUndefined();
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const copy = await browser.newPage();
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 390, 768, 1024 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => copy.locator( 'h1:visible' ).allTextContents() ).toEqual( [ width === 390 ? 'Phone document' : 'Desktop document' ] );
			expect( ( await copy.locator( 'main:visible' ).boundingBox() )!.width ).toBe( width );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
