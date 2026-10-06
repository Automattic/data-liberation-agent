import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// A runtime-stretched document, not a builder-specific fixture. The unrelated
// 1024px rule makes the exported phone document serve tablet widths as well.
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0}header{position:fixed;top:0;left:0;background:white;z-index:10}
nav{display:flex;flex-wrap:wrap}nav span{width:180px;height:56px;display:block}
main{padding:0 30px;box-sizing:border-box}h1{margin:10px 0;font-size:24px}
.columns{display:flex}.copy{width:66%}.portrait{width:34%;height:180px;background:teal}
body:not(.phone) .device{color:navy}
@media(max-width:767px){.columns{display:block}.copy,.portrait{width:100%}}
@media(max-width:1024px){aside{border-color:gray}}
</style></head><body><header style="width:1px"><nav><span>Home</span><span>About</span><span>Contact</span></nav></header>
<div class="spacer" style="height:1px"></div><main style="width:1px"><h1>About our work</h1>
<div class="device" style="padding-top:1px">Device geometry</div><div class="columns"><div class="copy">Independent content</div><div class="portrait"></div></div><aside>Other breakpoint</aside></main>
<script>
const phone=/iPhone|Android/.test(navigator.userAgent);if(phone)document.body.classList.add('phone');
function update(){const width=document.documentElement.clientWidth;document.querySelector('header').style.width=width+'px';document.querySelector('main').style.width=width+'px';document.querySelector('.spacer').style.height=document.querySelector('header').getBoundingClientRect().height+'px';document.querySelector('.device').style.paddingTop=(width<768?(phone?30:10):(phone?40:20))+'px'}
addEventListener('resize',update);update();
</script></body></html>`;

async function geometry( page: Page ) {
	return page.evaluate( () => {
		const rect = ( selector: string ) => {
			const elements = [ ...document.querySelectorAll( selector ) ];
			const element = elements.find( candidate => candidate.getBoundingClientRect().width > 0 )!;
			const box = element.getBoundingClientRect();
			return { width: box.width, top: box.top, bottom: box.bottom };
		};
		const heading = rect( 'h1' );
		return {
			section: rect( 'main' ).width, portrait: rect( '.portrait' ).width,
			header: rect( 'header' ).bottom, spacer: rect( '.spacer' ).bottom,
			heading: heading.top,
			headingVisible: !!document.elementFromPoint( 35, heading.top + 12 )?.closest( 'h1' ),
			padding: getComputedStyle( [ ...document.querySelectorAll( '.device' ) ].find( element => element.getBoundingClientRect().width > 0 )! ).paddingTop,
		};
	} );
}

it( 'learns each responsive document through tablet widths without freezing phone geometry or sharing segment rules', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'issue-375-' ) );
	let portable: string | undefined;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' ? portable : fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const address = server.address() as { port: number };
	const sourceUrl = `http://127.0.0.1:${ address.port }/`;
	const browser = await chromium.launch();
	try {
		const capture = await captureScreenshots( {
			urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0,
			learnFluid: true, fluidWidths: [ 390, 402, 600, 767, 768, 769, 1024, 1280, 1440 ],
		} );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const source = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		const phone = await browser.newPage( { viewport: { width: 402, height: 900 }, isMobile: true, userAgent: 'iPhone' } );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await source.goto( sourceUrl, { waitUntil: 'domcontentloaded' } );
		await phone.goto( sourceUrl, { waitUntil: 'domcontentloaded' } );
		await copy.goto( `${ sourceUrl }copy/`, { waitUntil: 'domcontentloaded' } );
		for ( const width of [ 390, 402, 600, 768, 1024, 1440, 768, 390 ] ) {
			for ( const page of [ source, phone, copy ] ) await page.setViewportSize( { width, height: 900 } );
			await phone.waitForTimeout( 50 );
			const expected = await geometry( width <= 1024 ? phone : source );
			const actual = await geometry( copy );
			expect( actual.section, `section at ${ width }` ).toBeCloseTo( expected.section, 0 );
			expect( actual.portrait, `portrait at ${ width }` ).toBeCloseTo( expected.portrait, 0 );
			expect( actual.header, `header at ${ width }` ).toBeCloseTo( expected.header, 0 );
			expect( actual.spacer, `spacer at ${ width }` ).toBeCloseTo( actual.header, 0 );
			expect( actual.heading ).toBeGreaterThanOrEqual( actual.header );
			expect( actual.headingVisible ).toBe( true );
			expect( actual.padding, `document segment at ${ width }` ).toBe( expected.padding );
		}
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.routes[ 0 ].fluidGeometry.desktop.applied ).toBeGreaterThan( 0 );
		expect( receipt.routes[ 0 ].fluidGeometry.mobile.applied ).toBeGreaterThan( 0 );
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
