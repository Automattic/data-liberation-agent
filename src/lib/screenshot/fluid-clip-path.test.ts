import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { learnClipPath, parseClipPath } from './fluid-clip-path.js';

it( 'fits only stable pixel basic shapes, atomically', () => {
	for ( const value of [ 'polygon(0 0, 100px 0, 100px 50px, 0 50px)', 'inset(0 10px)', 'rect(0 100px 50px 0)' ] ) {
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

// One real capture/export (~15s); verifies the computed-style/export boundary.
it( 'exports a runtime polygon that follows the media frame without covering outside content', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-clip-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}#frame{width:100%;height:50vw;position:relative}#media{position:absolute;inset:0;width:200%;height:200%;background:blue}#outside{position:absolute;top:55vw;left:50px;width:50px;height:50px;background:red}</style>
	</head><body><div id="outside"></div><div id="frame"><div id="media"></div></div>
	<div id="changing" style="clip-path:inset(0px)"></div><script>
	const fit = () => { const frame = document.querySelector('#frame'); const {width:w,height:h}=frame.getBoundingClientRect();
	frame.style.clipPath = 'polygon(0px 0px, '+w+'px 0px, '+w+'px '+h+'px, 0px '+h+'px)';
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
		expect( await copy.locator( '#changing' ).evaluate( node => getComputedStyle( node ).clipPath ) ).toBe( 'polygon(0px 0px, 100px 0px, 100px 100px, 0px 100px)' );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
		expect( manifest.entries[ sourceUrl ].fluid.unmodelled ).toBeGreaterThanOrEqual( 1 );
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
