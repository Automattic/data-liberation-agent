import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One real capture/export (~15s), including initial-document projection and
// computed-style serialization; page.content() alone misses that boundary.
it( 'exports piecewise scale with its sampled origin across a layout breakpoint', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-scale-breakpoint-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><style>#container { width:min(760px,55vw) } @media (max-width:900px) { #container { width:70vw } }</style><body>
		<div id="container">
		<div id="frame" style="width:760px">A natural-width text frame</div></div>
		<script>
		const fit = () => {
			const width = document.querySelector('#container').getBoundingClientRect().width;
			const frame = document.querySelector('#frame');
			frame.style.transform = width < 760 ? 'scale('+width/760+')' : '';
			frame.style.transformOrigin = width < 760 ? '0 0' : '';
		}; addEventListener('resize', fit); fit();
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
			urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0, deviceMode: 'auto',
			learnFluid: true, fluidWidths: [ 390, 768, 1024, 1440 ],
		} );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const copy = await browser.newPage();
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 768, 1024, 1440 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const geometry = await copy.evaluate( () => {
				const frame = document.querySelector( '#frame' )!.getBoundingClientRect();
				const container = document.querySelector( '#container' )!.getBoundingClientRect();
				return { left: frame.left, containerLeft: container.left, width: frame.width, containerWidth: container.width };
			} );
			expect( geometry.left, `frame left at ${ width }px` ).toBeCloseTo( geometry.containerLeft, 0 );
			expect( geometry.width, `frame width at ${ width }px` ).toBeCloseTo( geometry.containerWidth, 0 );
			if ( width === 1440 ) expect( geometry.width ).toBe( 760 );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
