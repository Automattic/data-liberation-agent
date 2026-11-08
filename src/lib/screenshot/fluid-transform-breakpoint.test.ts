import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// Real capture/export (~15s per case), including initial-document projection
// and computed-style serialization. Use the production adaptive sweep.
// The positioned case also verifies absolute dimensions against source samples.
it.each( [ 'identity scale', 'varying dimensions', 'constant dimensions', 'positioned dimensions' ] )( 'exports %s across viewport breakpoints', async scenario => {
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
			const positioned = ${ scenario === 'positioned dimensions' };
			// Measured Canva frame: nonlinear phone sizing, a layout switch,
			// then proportional desktop sizing capped at the reference width.
			const points = [[320,249.732],[360,258.989],[390,265.036],[414,269.411],[600,293.848],[768,307.425],[900,315.05],[1024,320.653],[1200,291.094],[1280,310.501],[1366,331.362],[1920,331.362]];
			const upper = points.findIndex(point => point[0] >= viewport);
			const low = points[Math.max(0, upper - 1)], high = points[upper < 0 ? points.length - 1 : upper];
			const measuredWidth = low[0] === high[0] ? low[1] : low[1] + (high[1] - low[1]) * (viewport - low[0]) / (high[0] - low[0]);
			const width = positioned ? measuredWidth : constant ? 256 : viewport > 800 ? 1800 : 860;
			const scale = positioned ? 1 : constant ? .7038 + viewport * .00006174 : viewport / width;
			const height = positioned ? width * 395.178 / 331.362 : constant ? 264.646 : viewport > 800 ? 256 : viewport >= 768 ? 356 : 300 + viewport * viewport / 10000;
			const container = document.querySelector('#container');
			const frame = document.querySelector('#frame');
			container.style.width = (positioned ? viewport : width * scale) + 'px';
			if ( positioned ) { frame.style.position = 'absolute'; frame.style.transform = 'translate(20px, 30px)'; }
			container.style.height = height * scale + 'px';
			frame.style.width = width + 'px'; frame.style.height = height + 'px';
			if ( ! positioned ) frame.style.transform = 'scale(' + scale + ')';
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
			if ( scenario === 'positioned dimensions' ) {
				const expected = { 768: 307.425, 1024: 320.653, 1200: 291.094, 1440: 331.362 }[ width ]!;
				expect( Math.abs( geometry.width - expected ), `positioned width at ${ width }px` ).toBeLessThanOrEqual( 1 );
				continue;
			}
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
