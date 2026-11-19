import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it as unit } from 'vitest';
import { it } from '../../../test/browser.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector, type FidelityReference } from '../fidelity/reference.js';
import { capturedSwaps, holdSourceMotion, motionChanges, motionDisagreement, observeMotionHold, readPaintedTokens, readPaintState, releaseSourceMotion } from './motion-hold.js';
import { captureScreenshots } from './screenshotter.js';

describe( 'motion agreement', () => {
	unit( 'counts a change as rotation only when something appears while something else disappears', () => {
		expect( motionChanges( [ 'text:One', 'text:Title' ], [ 'text:Title', 'text:Two' ] ) ).toEqual( [ 'text:One', 'text:Two' ] );
		// Lazy content and entrances only appear; they are not rotation.
		expect( motionChanges( [ 'text:Title' ], [ 'text:Title', 'text:Late' ] ) ).toEqual( [] );
		expect( motionChanges( [ 'text:Title', 'text:Loading' ], [ 'text:Title' ] ) ).toEqual( [] );
	} );

	unit( 'compares only rotating tokens with the captured document', () => {
		const captured = [ 'text:Title', 'text:One', 'text:Wide only' ];
		expect( motionDisagreement( captured, [ 'text:Title', 'text:Two' ], [ 'text:One', 'text:Two' ] ) ).toEqual( [ 'text:One', 'text:Two' ] );
		// A width-dependent static difference is not a rotation and never blocks agreement.
		expect( motionDisagreement( captured, [ 'text:Title', 'text:One' ], [ 'text:One', 'text:Two' ] ) ).toEqual( [] );
		expect( motionDisagreement( captured, [ 'text:Title', 'text:Two' ], [] ) ).toEqual( [] );
	} );

	unit( 'treats a hidden/painted swap against capture at the same width as rotation', () => {
		const captured = { painted: [ 'text:Title', 'text:One' ], latent: [ 'text:Two', 'text:Three' ], rotating: [], width: 1440 };
		const observed = { painted: [ 'text:Title', 'text:Two' ], latent: [ 'text:One', 'text:Three' ], width: 1440 };
		expect( capturedSwaps( captured, observed ) ).toEqual( [ 'text:One', 'text:Two' ] );
		// Another width legitimately shows different content.
		expect( capturedSwaps( captured, { ...observed, width: 390 } ) ).toEqual( [] );
		// Content that only appeared (a late reveal) is not a swap.
		expect( capturedSwaps( captured, { painted: [ 'text:Title', 'text:One', 'text:Two' ], latent: [ 'text:Three' ], width: 1440 } ) ).toEqual( [] );
	} );
} );

// A three-slide testimonial carousel advancing every 300 ms. Each slide paints a
// distinct colour, so the screenshot names the slide it shows.
const COLORS = [ [ 220, 30, 30 ], [ 30, 160, 30 ], [ 30, 30, 220 ] ];
const CAROUSEL = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Testimonials</title>
	<style>body{margin:0;font:20px Arial}.testimonials{position:relative;height:300px}
	.slide{position:absolute;inset:0;margin:0;opacity:0;transition:opacity .7s}.slide.active{opacity:1}
	${ COLORS.map( ( [ r, g, b ], index ) => `.s${ index }{background:rgb(${ r },${ g },${ b })}` ).join( '' ) }</style></head>
	<body><main><h1>What clients say</h1><section class="testimonials">
	<blockquote class="slide s0 active">First client loved it</blockquote>
	<blockquote class="slide s1">Second client recommends it</blockquote>
	<blockquote class="slide s2">Third client came back</blockquote>
	</section></main><script>let current = 0;
	// Like a framework re-render: the timer posts a message, and the render it
	// schedules swaps the classes and re-arms the next timer.
	const channel = new MessageChannel();
	channel.port1.onmessage = () => {
		const slides = document.querySelectorAll('.slide');
		slides[current].classList.remove('active'); current = (current + 1) % slides.length; slides[current].classList.add('active');
		setTimeout(() => channel.port2.postMessage(0), 300);
	};
	setTimeout(() => channel.port2.postMessage(0), 300);</script></body></html>`;
const activeSlides = ( html: string ) => [ ...html.matchAll( /<blockquote class="slide s(\d)( active)?"/g ) ].filter( match => match[ 2 ] ).map( match => Number( match[ 1 ] ) );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'source motion hold', () => {
	// About one second: one page.
	it( 'defers source timers, including ones source scripts register during the hold, and runs probe timers', async ( { newPage, serve } ) => {
		const { origin } = await serve( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( '<!doctype html><script>window.rearm = () => setTimeout(() => { window.rearmed = true; }, 20);</script>' );
		} );
		const page = await newPage();
		await page.addInitScript( observeMotionHold );
		await page.goto( `${ origin }/` );
		await page.evaluate( () => {
			const state = window as unknown as { ticks: number; frames: number; late: boolean; rearmed: boolean };
			state.ticks = 0; state.frames = 0; state.late = false; state.rearmed = false;
			setInterval( () => { state.ticks++; }, 20 );
			const frame = () => { state.frames++; requestAnimationFrame( frame ); };
			requestAnimationFrame( frame );
			setTimeout( () => { state.late = true; }, 150 );
		} );
		await page.waitForFunction( () => ( window as unknown as { ticks: number } ).ticks > 2 );
		expect( await holdSourceMotion( page ) ).toBe( true );
		const read = () => page.evaluate( () => { const state = window as unknown as { ticks: number; frames: number; late: boolean; rearmed: boolean }; return { ticks: state.ticks, frames: state.frames, late: state.late, rearmed: state.rearmed }; } );
		const before = await read();
		// A page script re-arming its timer during the hold is source work.
		await page.evaluate( () => { ( window as unknown as { rearm: () => void } ).rearm(); } );
		const probe = await page.evaluate( () => new Promise<boolean>( resolve => setTimeout( () => resolve( true ), 30 ) ) );
		await page.waitForTimeout( 300 );
		expect( probe ).toBe( true );
		expect( await read() ).toEqual( before );
		await releaseSourceMotion( page );
		await page.waitForFunction( ( ticks: number ) => { const state = window as unknown as { ticks: number; late: boolean; rearmed: boolean }; return state.ticks > ticks && state.late && state.rearmed; }, before.ticks );
	}, 20_000 );

	// About 30 seconds: one capture with three reference cells.
	it( 'freezes the reference on the carousel slide the captured document serialized', async ( { serve } ) => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'motion-hold-carousel-' ) );
		const { origin } = await serve( ( _request, response ) => { response.setHeader( 'content-type', 'text/html' ); response.end( CAROUSEL ); } );
		const url = `${ origin }/`;
		try {
			const collector = createReferenceCollector( directory, url, [ url ] );
			const captured = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir: directory, concurrency: 1, settleMs: 100, learnFluid: false, observeSource: collector.observe, declareSourceProfile: collector.declare } );
			expect( captured.failed ).toBe( 0 );
			const receiptPath = exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'default', summary: { routesDiscovered: 1, routesCaptured: 1, routesSkipped: 0, routesFailed: 0, durationMs: captured.durationMs }, failures: [], discoveryDiagnostics: [] } );
			const manifest = JSON.parse( readFileSync( collector.finalize( receiptPath ), 'utf8' ) ) as FidelityReference;
			const website = [ ...new Set( activeSlides( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) ) ) ];
			expect( website ).toHaveLength( 1 );
			expect( manifest.entries.length ).toBeGreaterThan( 0 );
			for ( const entry of manifest.entries ) {
				expect( entry.readiness.diagnostics ?? [] ).not.toContainEqual( expect.stringContaining( 'source motion disagrees' ) );
				expect( activeSlides( readFileSync( join( directory, entry.document!.path ), 'utf8' ) ) ).toEqual( website );
				const png = PNG.sync.read( readFileSync( join( directory, entry.screenshot!.path ) ) );
				// Sample the middle of the slide band below the heading.
				const offset = ( png.width * 250 + Math.floor( png.width / 2 ) ) * 4;
				const pixel = [ png.data[ offset ]!, png.data[ offset + 1 ]!, png.data[ offset + 2 ]! ];
				const shown = COLORS.findIndex( color => color.every( ( channel, index ) => Math.abs( channel - pixel[ index ]! ) < 8 ) );
				expect( shown, `${ entry.viewport }: ${ pixel.join( ',' ) }` ).toBe( website[ 0 ] );
			}
		} finally { if ( ! process.env.KEEP_MOTION ) rmSync( directory, { recursive: true, force: true } ); }
	}, 120_000 );

	// Sub-second: painted tokens exclude hidden and clipped slides.
	it( 'reads painted text, excluding hidden, transparent and clipped content', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( `<style>.track{width:200px;overflow:hidden;white-space:nowrap}.track span{display:inline-block;width:200px}</style>
			<p>Shown</p><p style="display:none">Hidden</p><p style="opacity:0">Transparent</p>
			<div style="opacity:0"><blockquote><p>Faded slide</p></blockquote></div><div style="visibility:hidden"><p>Invisible slide</p></div>
			<div class="track"><span>In view</span><span>Parked outside</span></div>` );
		expect( await readPaintedTokens( page ) ).toEqual( [ 'text:In view', 'text:Shown' ] );
		expect( ( await readPaintState( page ) ).latent ).toEqual( [ 'text:Faded slide', 'text:Hidden', 'text:Invisible slide', 'text:Parked outside', 'text:Transparent' ] );
	}, 20_000 );
} );
