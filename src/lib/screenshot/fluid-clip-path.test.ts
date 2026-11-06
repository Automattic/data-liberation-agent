import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { learnClipPath, parseClipPath } from './fluid-clip-path.js';

it( 'fits only stable pixel basic shapes, atomically', () => {
	for ( const value of [ 'polygon(0 0, 100px 0, 100px 50px, 0 50px)', 'inset(0 10px)', 'rect(0 100px 50px 0)', 'polygon(37px 0.0157606px, 236.092px 0.0157606px, 236.092px 204px, 37px 204px)' ] ) {
		expect( parseClipPath( value ) ).not.toBeNull();
	}
	for ( const value of [ 'circle(50px)', 'polygon(0 0, 100% 0, 100% 100%)', 'inset(0 round 10px)', 'rect(auto 100px 50px 0)' ] ) {
		expect( parseClipPath( value ) ).toBeNull();
	}
	expect( learnClipPath( 'inset(@)', [ [ { viewport: 390, value: NaN } ] ], '#frame', 'clip' ) ).toBeNull();
} );

it( 'uses existing proportional, bounded and segmented fits for shape coordinates', () => {
	const widths = [ 390, 600, 768, 1024, 1280, 1440, 1920 ];
	const fit = ( values: number[] ) => learnClipPath( 'inset(@)', [ widths.map( ( viewport, index ) => ( { viewport, value: values[ index ]! } ) ) ], '#frame', 'clip' );
	expect( fit( widths.map( width => width / 2 ) ) ).toMatchObject( { kinds: [ 'proportional' ], css: 'inset(calc(50vw))' } );
	expect( fit( widths.map( width => Math.max( 500, width ) ) )?.css ).toContain( 'max(' );
	expect( fit( [ 84.2969, 109.5156, 129.1563, 61.8438, 72.375, 79.0469, 88.8281 ] ) ).toMatchObject( { kinds: [ 'segmented' ] } );
	const container = learnClipPath( 'rect(@ @ @ @)', Array.from( { length: 4 }, () => widths.map( viewport => ( { viewport, value: viewport / 4, container: viewport / 2 } ) ) ), '#frame', 'clip' );
	expect( container?.css ).toBe( 'rect(calc(50%) calc(50%) calc(50%) calc(50%))' );
} );

it( 'fits signed clip offsets across decorative layout regimes without holding unfitted samples', () => {
	const widths = [ 320, 360, 390, 414, 600, 767, 768, 769, 775, 783, 791, 799, 800, 801, 1024, 1280, 1440, 1536, 1840, 1920 ];
	// Observed resize-only SVG wrapper x coordinates: A has a negative
	// intercept; B changes direction at a layout switch. Neither is a size.
	for ( const values of [
		[ 83.5335, 100.699, 113.848, 124.508, 396.051, 549.095, 550.048, 551.001, 556.723, 564.357, 571.997, 579.643, 580.6, 581.556, 796.67, 1089.85, 1200.08, 1248.08, 1400.08, 1440.08 ],
		[ 84.435, 101.634, 114.804, 125.48, 211.086, 290.498, 290.978, 291.458, 294.339, 298.183, 302.029, 305.878, 306.36, 306.841, 61.9316, 0, 37, 85, 237, 277 ],
	] ) {
		const fitted = learnClipPath( 'inset(@)', [ widths.map( ( viewport, index ) => ( { viewport, value: values[ index ]! } ) ) ], '#decoration', 'clip' );
		expect( fitted ).not.toBeNull();
		expect( fitted?.kinds ).toEqual( [ 'segmented' ] );
	}
} );

// One real capture/export (~15s); verifies the computed-style/export boundary.
it( 'exports a runtime polygon that follows the media frame without covering outside content', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-clip-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}#frame{width:100%;height:50vw;position:relative}#media{position:absolute;inset:0;width:200%;height:200%;background:blue}#outside{position:absolute;top:55vw;left:50px;width:50px;height:50px;background:red}</style>
	</head><body><div id="outside"></div><div id="frame"><div id="media"></div></div>
	<div id="decoration" style="width:100%;height:200px"><svg width="300" height="150"></svg></div>
	<div id="changing" style="clip-path:inset(0px)"></div><script>
	const fit = () => { const frame = document.querySelector('#frame'); const {width:w,height:h}=frame.getBoundingClientRect();
	frame.style.clipPath = 'polygon(0px 0px, '+w+'px 0px, '+w+'px '+h+'px, 0px '+h+'px)';
	const x = innerWidth * .97 - 195;
	document.querySelector('#decoration').style.clipPath = 'polygon('+x+'px 0.0158px, '+(x+190)+'px 0.0158px, '+(x+190)+'px 195px, '+x+'px 195px)';
	document.querySelector('#changing').style.clipPath = innerWidth < 1000 ? 'inset(10px)' : 'polygon(0px 0px, 100px 0px, 100px 100px, 0px 100px)'; };
	addEventListener('resize',fit); fit();</script></body></html>`;
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
		const copy = await browser.newPage( { viewport: { width: 768, height: 900 } } );
		await copy.goto( `${ sourceUrl }copy/` );
		const geometry = await copy.evaluate( () => {
			const frame = document.querySelector( '#frame' )!;
			const clip = getComputedStyle( frame ).clipPath;
			const coordinate = /,\s*([\d.]+)(px|%)/.exec( clip );
			const right = coordinate ? Number( coordinate[ 1 ] ) * ( coordinate[ 2 ] === '%' ? frame.getBoundingClientRect().width / 100 : 1 ) : NaN;
			const outside = document.querySelector( '#outside' )!.getBoundingClientRect();
			return { clip, right, width: frame.getBoundingClientRect().width,
				outside: document.elementFromPoint( outside.x + 25, outside.y + 25 )?.id };
		} );
		expect( Math.abs( geometry.right - geometry.width ), JSON.stringify( geometry ) ).toBeLessThanOrEqual( 1 );
		expect( geometry.outside ).toBe( 'outside' );
		for ( const width of [ 768, 1024 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const clip = await copy.locator( '#decoration' ).evaluate( node => getComputedStyle( node ).clipPath );
			const coordinates = clip.match( /-?[\d.]+(?=px)/g )?.map( Number );
			const x = width * .97 - 195;
			expect( coordinates, clip ).toHaveLength( 8 );
			for ( const [ index, expected ] of [ x, .0158, x + 190, .0158, x + 190, 195, x, 195 ].entries() ) {
				expect( Math.abs( coordinates![ index ]! - expected ), clip ).toBeLessThanOrEqual( 1 );
			}
		}
		expect( await copy.locator( '#changing' ).evaluate( node => getComputedStyle( node ).clipPath ) ).toBe( 'polygon(0px 0px, 100px 0px, 100px 100px, 0px 100px)' );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		expect( manifest.entries[ sourceUrl ].fluid.unmodelled ).toBeGreaterThanOrEqual( 1 );
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
