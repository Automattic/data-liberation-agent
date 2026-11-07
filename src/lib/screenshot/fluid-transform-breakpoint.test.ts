import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// Real capture/export (~15s per case), including initial-document projection
// and computed-style serialization. Use the production adaptive sweep.
it.each( [ 'identity scale', 'varying dimensions', 'constant dimensions' ] )( 'exports %s with a scaled box equal to its parent', async scenario => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-scale-breakpoint-' ) );
	let portable: string | undefined;
	const dimensionsFixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><style>
		body { margin:0 } #container { width:100vw }
		</style><body><div id="container"><div id="frame" style="transform-origin:0 0">Scaled frame</div></div><script>
		const fit = () => {
			const viewport = innerWidth;
			const constant = ${ scenario === 'constant dimensions' };
			const width = constant ? 256 : viewport > 800 ? 1800 : 860;
			const scale = constant ? .7038 + viewport * .00006174 : viewport / width;
			const height = constant ? 264.646 : viewport > 800 ? 256 : viewport >= 768 ? 356 : 300 + viewport * viewport / 10000;
			const container = document.querySelector('#container');
			const frame = document.querySelector('#frame');
			container.style.width = width * scale + 'px';
			container.style.height = height * scale + 'px';
			frame.style.width = width + 'px'; frame.style.height = height + 'px';
			frame.style.transform = 'scale(' + scale + ')';
		}; addEventListener('resize', fit); fit();
		</script></body></html>`;
	const fixture = scenario !== 'identity scale' ? dimensionsFixture : `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><style>#container { width:559.172px } @media (max-width:1300px) { #container { width:40.93vw } } @media (max-width:1100px) { #container { width:calc(451.43px + 8.76vw) } }</style><body>
		<div id="container">
		<div id="frame" style="width:559.172px">A natural-width text frame</div></div>
		<script>
		const fit = () => {
			const width = document.querySelector('#container').getBoundingClientRect().width;
			const frame = document.querySelector('#frame');
			frame.style.transform = width < 559.172 ? 'scale('+width/559.172+')' : '';
			frame.style.transformOrigin = width < 559.172 ? '0 0' : '';
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
			learnFluid: true,
		} );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const copy = await browser.newPage();
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 768, 1024, 1200, 1440 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const geometry = await copy.evaluate( () => {
				const frame = document.querySelector( '#frame' )!.getBoundingClientRect();
				const container = document.querySelector( '#container' )!.getBoundingClientRect();
				return { left: frame.left, containerLeft: container.left, width: frame.width, containerWidth: container.width, height: frame.height, containerHeight: container.height };
			} );
			expect( geometry.left, `frame left at ${ width }px` ).toBeCloseTo( geometry.containerLeft, 0 );
			expect( Math.abs( geometry.width - geometry.containerWidth ), `frame width at ${ width }px` ).toBeLessThanOrEqual( 1 );
			if ( scenario !== 'identity scale' ) expect( Math.abs( geometry.height - geometry.containerHeight ), `frame height at ${ width }px` ).toBeLessThanOrEqual( 1 );
			if ( scenario === 'identity scale' && width === 1440 ) expect( geometry.width ).toBeCloseTo( 559.172, 1 );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
