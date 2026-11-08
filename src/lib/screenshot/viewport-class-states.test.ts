import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { expect, it } from 'vitest';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';
import { captureViewportClassStates, type ViewportClassMemo } from './viewport-class-states.js';

// A sidebar script pins the menu open at wide widths and draws its toggle open
// with it (the Google Sites pattern); narrower widths show the closed icon.
const source = `<!doctype html><html><head><style>
.bar{display:block;width:20px;height:2px;transform:none}
.open .bar{transform:rotate(45deg)}
@media (min-width:600px){.open .bar{background:red}}
</style></head><body><button><span class="icon"><i class="bar"></i></span></button><script>
const sync=()=>document.querySelector('.icon').setAttribute('class',innerWidth>=1280?'icon open':'icon');
addEventListener('resize',sync);sync();
</script></body></html>`;

it( 'serves script-toggled class state at the widths the source applied it', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeRuntimeStyleWrites );
		await page.setContent( source );
		await markInitialDocument( page );
		const initial = await page.content();
		const result = await captureViewportClassStates( page, { settleMs: 0 } );
		expect( result.aliased ).toBe( 1 );

		// The serialized copy is the pre-sweep document plus what the sweep learned;
		// the source script rewrites classes on later resizes, and the copy runs no script.
		await page.setViewportSize( { width: 1024, height: 900 } );
		await page.setViewportSize( { width: 1440, height: 900 } );
		const copy = projectInitialDocument( initial, await page.content() ).replace( /<script\b[\s\S]*?<\/script>/gi, '' );
		const exported = await browser.newPage();
		await exported.setContent( copy );
		const bar = async ( width: number ) => {
			await exported.setViewportSize( { width, height: 900 } );
			return exported.evaluate( () => {
				const style = getComputedStyle( document.querySelector( '.bar' )! );
				return { open: style.transform !== 'none', red: style.backgroundColor === 'rgb(255, 0, 0)' };
			} );
		};
		expect( await bar( 1440 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1280 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1279 ) ).toEqual( { open: false, red: false } );
		expect( await bar( 1024 ) ).toEqual( { open: false, red: false } );
	} finally {
		await browser.close();
	}
}, 60_000 );

// One real capture/export (~20s): both sweeps run against a resize-driven runtime.
it( 'keeps learned transforms through the viewport class sweep', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'viewport-class-fluid-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}#frame{width:100px;height:100px}.open{background:red}</style></head>
	<body><main><div id="frame">Moving frame</div></main><script>
	const fit=()=>{
		const frame=document.querySelector('#frame');
		frame.style.transform='translate('+((innerWidth>=1200?innerWidth*.9-96:innerWidth*.96-186))+'px, 0px)';
		frame.className=innerWidth>=1281?'open':'';
		// The class sweep bisects this boundary (the fluid ladder does not).
		// Like a runtime's lazy reveal, the ancestor state remains once reached.
		if(innerWidth===1281)document.querySelector('main').classList.add('revealed');
	};addEventListener('resize',fit);fit();
	</script></body></html>`;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' ? portable : fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const sourceUrl = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch();
	try {
		const capture = await captureScreenshots( {
			urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0,
			deviceMode: 'auto', learnFluid: true,
		} );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const sourcePage = await browser.newPage();
		const copy = await browser.newPage();
		await sourcePage.goto( sourceUrl );
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 1440, 1024, 768 ] ) {
			await sourcePage.setViewportSize( { width, height: 900 } );
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => sourcePage.locator( '#frame' ).evaluate( element => element.getBoundingClientRect().left ) ).toBeCloseTo( width >= 1200 ? width * .9 - 96 : width * .96 - 186, 1 );
			const expected = await sourcePage.locator( '#frame' ).boundingBox();
			const actual = await copy.locator( '#frame' ).boundingBox();
			expect( Math.abs( actual!.x - expected!.x ), `frame left at ${ width }px` ).toBeLessThanOrEqual( 1 );
			expect( await copy.locator( '#frame' ).evaluate( element => getComputedStyle( element ).backgroundColor ) ).toBe( width >= 1281 ? 'rgb(255, 0, 0)' : 'rgba(0, 0, 0, 0)' );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );

it.each( [
	{ name: 'matching breakpoint', secondBreakpoint: 768, reuses: true },
	{ name: 'different breakpoint outside range', secondBreakpoint: 2000, reuses: false },
	{ name: 'different breakpoint inside range', secondBreakpoint: 1000, reuses: false },
] )( 'verifies shared header memo for $name', async ( { secondBreakpoint, reuses } ) => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeRuntimeStyleWrites );
		const memo: ViewportClassMemo = new Map();
		const makeRoute = ( breakpoint: number ) => `<!doctype html><html><head><style>.header{color:black}.header.is-mobile{color:red}</style></head><body><header class="header">Shared</header><script>const sync=()=>document.querySelector('.header').classList.toggle('is-mobile',innerWidth<${breakpoint});addEventListener('resize',sync);sync()</script></body></html>`;
		const results = [];
		for ( const breakpoint of [ 768, secondBreakpoint ] ) {
			await page.setContent( makeRoute( breakpoint ) );
			results.push( await captureViewportClassStates( page, { settleMs: 0, memo } ) );
		}
		// A reused toggle is proven at the extremes and either side of its flip, with no ladder or bisection.
		if ( reuses ) expect( [ ...results[ 1 ]!.sampledWidths ].sort( ( a, b ) => a - b ) ).toEqual( [ 390, 767, 768, 1920 ] );
		else {
			expect( results[ 1 ]!.sampledWidths ).toEqual( expect.arrayContaining( [ 390, 1920 ] ) );
			expect( results[ 1 ]!.sampledWidths.length ).toBeGreaterThan( 2 );
		}
		const mediaRules = await page.locator( 'style[data-blocks-engine-capture-fluid-sheet-rules]' ).last().textContent();
		if ( reuses ) expect( mediaRules ).toContain( '(max-width:767px)' );
		else expect( mediaRules ).toContain( secondBreakpoint === 1000 ? '(max-width:999px)' : '(max-width:1999px)' );
	} finally {
		await browser.close();
	}
}, 60_000 );
