import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One real capture/export (~15s), including initial-document projection and
// computed-style serialization; page.content() alone misses that boundary.
it( 'exports the sampled origin with a scale absent at the reference width', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-origin-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
		<div id="container" style="width:min(760px,55vw)">
		<div id="frame" style="width:760px">A natural-width text frame</div></div>
		<div id="varying" style="width:760px">Varying origin</div><script>
		const fit = () => {
			const width = document.querySelector('#container').getBoundingClientRect().width;
			const frame = document.querySelector('#frame');
			frame.style.transform = width < 760 ? 'scale('+width/760+')' : '';
			frame.style.transformOrigin = width < 760 ? '0 0' : '';
			const varying = document.querySelector('#varying');
			varying.style.transform = frame.style.transform;
			varying.style.transformOrigin = width < 760 ? innerWidth / 10 + 'px 0' : '';
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
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		expect( manifest.entries[ sourceUrl ].fluid.unmodelled ).toBe( 1 );
		expect( await copy.locator( '#varying' ).evaluate( node => getComputedStyle( node ).transform ) ).toBe( 'none' );
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
