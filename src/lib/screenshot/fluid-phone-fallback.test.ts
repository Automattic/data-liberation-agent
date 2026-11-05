import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// UA-selected HTML: fluid phone geometry does not make the phone document
// appropriate for tablets, which receive desktop HTML from the source.
function fixture( phone: boolean ) {
	return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}main{height:200px;background:teal}
	@media(max-width:767px){aside{color:blue}}
	@media(max-width:1439px){aside{color:gray}}</style></head>
	<body class="${ phone ? 'phone' : 'desktop' }"><main style="${ phone ? 'position:absolute;left:0;top:0;width:100%' : 'width:100%' }">
	${ phone ? '<section><h1>Phone document</h1><p>Compact identity</p></section>' : '<h1>Desktop document</h1><nav>Wide identity</nav>' }</main><aside>Unrelated breakpoint</aside>
	${ phone ? '<script>const update=()=>document.querySelector("main").style.width=innerWidth+"px";addEventListener("resize",update);update();</script>' : '' }</body></html>`;
}

it( 'keeps a fluid server-selected phone document below the evidenced tablet boundary', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-phone-' ) );
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
		expect( manifest.entries[ sourceUrl ].fluidMobile.applied ).toBeGreaterThan( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		const profile = JSON.parse( readFileSync( join( outputDir, 'source-profile.json' ), 'utf8' ) );
		expect( profile ).toMatchObject( { switchWidth: 767, switchWidthSource: 'detected' } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const copy = await browser.newPage();
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 390, 768, 1024, 1440 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => copy.locator( 'h1:visible' ).allTextContents() ).toEqual( [ width === 390 ? 'Phone document' : 'Desktop document' ] );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
