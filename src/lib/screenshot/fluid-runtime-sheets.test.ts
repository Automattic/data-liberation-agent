import { describe, expect } from 'vitest';
import { it, type BrowserFixtures } from '../../../test/browser.js';

import { DEFAULT_SWEEP_WIDTHS, learnAndApplyFluidGeometry, MAX_LOCATING_WIDTHS } from './fluid-capture.js';
import { RUNTIME_SHEET_RULES_ATTRIBUTE } from './fluid-runtime-sheets.js';
import { observeRuntimeStyleWrites, restoreLoadTimeSheets } from './runtime-style-writes.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';

// A canvas with a 980px floor whose runtime regenerates an id-keyed stylesheet
// on resize: items keep their canvas offsets until the viewport exceeds the
// canvas, then the runtime centres them. The wrapper width is ordinary inline
// runtime geometry, so the width sweep runs as it does for real sources.
const runtimeSheetSource = ( authored = '' ) => `<style>body{margin:0}#canvas{min-width:980px;position:relative}#wrap{position:relative;height:900px}
	.item{width:443px;height:431px;background:#ccc}${ authored }</style>
	<div id="canvas"><div id="wrap" style="width:1440px"><div id="first" class="item"></div><div id="second" class="item"></div><div id="still" class="item"></div></div></div>
	<script>
	const sheet=document.createElement('style');sheet.id='wrap-styles';document.head.appendChild(sheet);
	const update=()=>{
		const shift=Math.max(0,innerWidth/2-490);
		document.getElementById('wrap').style.width=Math.max(980,innerWidth)+'px';
		sheet.textContent='#wrap #first {position: absolute; top: 20px; inset-inline-start: '+(47+shift)+'px; margin: 0;}\\n'+
			'#wrap #second {position: absolute; top: 20px; inset-inline-start: '+(520+shift)+'px; margin: 0;}\\n'+
			'#wrap #still {position: absolute; top: 460px; inset-inline-start: 47px; margin: 0;}';
	};
	addEventListener('resize',update);update();
	</script>`;

const WIDTHS = [ 390, 768, 980, 1024, 1280, 1440, 1920 ];

describe( 'runtime-written stylesheet offsets', () => {

	it( 'leaves time-driven transforms live while learning stable width-driven translations', async ({ newContext }) => {
		const context = await newContext( { viewport: { width: 1440, height: 900 } } );
		await context.addInitScript( observeRuntimeStyleWrites );
		const page = await context.newPage();
		try {
			await page.goto( 'data:text/html,' + encodeURIComponent( `<style>
				#track { transition: transform 80ms linear; } div { width: 40px; height: 40px; }
				</style><div id="track" style="transform:translateX(0px)"></div>
				<div id="layout" style="transform:translateX(0px)"></div><script>
				const track = document.getElementById('track');
				let phase = 0, locked = false; window.advances = 0;
				track.addEventListener('transitionend', () => { locked = false; window.advances++; });
				setInterval(() => {
					if (locked) return;
					locked = true; phase++;
					track.style.transform = 'translateX(' + (-phase * 40) + 'px)';
				}, 150);
				const resize = () => document.getElementById('layout').style.transform = 'translateX(' + innerWidth / 4 + 'px)';
				addEventListener('resize', resize); resize();
				</script>` ) );
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1024, 1440 ], settleMs: 30 } );
			const rules = await page.locator( 'style[data-blocks-engine-capture-fluid-rules]' ).allTextContents();
			expect( await page.locator( '#track' ).getAttribute( 'data-blocks-engine-capture-fluid-segment' ) ).toBeNull();
			expect( rules.join( '' ) ).toContain( 'transform:' );
			expect( await page.locator( '#layout' ).getAttribute( 'data-blocks-engine-capture-fluid-segment' ) ).not.toBeNull();
			const before = await page.evaluate( () => ( window as unknown as { advances: number } ).advances );
			await page.waitForFunction( before => ( window as unknown as { advances: number } ).advances >= before + 2, before );
			await page.setViewportSize( { width: 768, height: 900 } );
			await page.waitForFunction( () => getComputedStyle( document.getElementById( 'layout' )! ).transform === 'matrix(1, 0, 0, 1, 192, 0)' );
		} finally { await context.close(); }
	}, 30_000 );

	it( 'learns a width-driven scale that a scroll-linked parallax also rewrites', async ({ newContext }) => {
		// blocks-engine#7374: the hero scene's resting scale depends on the width,
		// and the scroll handler parallaxes it. Capture's own lazy-load sweep
		// scrolls the page, which must not read as time-driven motion.
		const context = await newContext( { viewport: { width: 1440, height: 900 } } );
		await context.addInitScript( observeRuntimeStyleWrites );
		const page = await context.newPage();
		try {
			await page.goto( 'data:text/html,' + encodeURIComponent( `<style>body{margin:0}#scene{height:600px}#tail{height:4000px}</style>
				<div id="scene" style="transform-origin:66% 48%;transform:translate3d(0px,0px,0px) scale(1.025)"></div><div id="tail"></div><script>
				const scene = document.getElementById('scene');
				const paint = () => {
					const base = matchMedia('(max-width:780px)').matches ? 1.035 : 1.025, p = Math.min(1, scrollY / 600);
					scene.style.transform = 'translate3d(0px,' + p * 15 + 'px,0px) scale(' + (base + p * .065) + ')';
				};
				addEventListener('scroll', paint, { passive: true }); addEventListener('resize', paint); paint();
				</script>` ) );
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 775, 783, 1024, 1440 ], settleMs: 30 } );
			expect( await page.locator( '#scene' ).getAttribute( 'data-blocks-engine-capture-fluid-segment' ) ).not.toBeNull();
			await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
			for ( const [ width, scale ] of [ [ 768, 1.035 ], [ 1440, 1.025 ] ] as const ) {
				await page.setViewportSize( { width, height: 900 } );
				const matrix = await page.locator( '#scene' ).evaluate( node => new DOMMatrix( getComputedStyle( node ).transform ).a );
				expect( matrix, `scale at ${ width }px` ).toBeCloseTo( scale, 3 );
			}
		} finally { await context.close(); }
	}, 30_000 );

	it( 'keeps canvas offsets below the capture width instead of freezing the capture width sheet', async ({ newPage }) => {
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		const reference = await newPage();
		const copy = await newPage();
		try {
			await page.setContent( runtimeSheetSource() );
			await reference.setContent( runtimeSheetSource() );
			const result = await learnAndApplyFluidGeometry( page, { widths: WIDTHS, settleMs: 30 } );
			expect( result.byKind[ 'runtime-sheet' ] ).toBe( 2 );
			// Learned rules sit beside the sheet that owns them, so document scoping
			// and cascade order follow the source sheet.
			expect( await page.evaluate( attribute => document.getElementById( 'wrap-styles' )?.nextElementSibling?.hasAttribute( attribute ), RUNTIME_SHEET_RULES_ATTRIBUTE ) ).toBe( true );
			await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
			await copy.setContent( await page.content() );
			// Sampled widths plus an unsampled width inside the wide regime; between
			// sparse samples the shared fitter may choose a different equivalent fit.
			for ( const width of [ 390, 768, 980, 1024, 1440, 1600, 1920 ] ) {
				await reference.setViewportSize( { width, height: 900 } );
				// Wait for the source resize handler, not a timer: under suite load
				// Chromium can still expose the preceding viewport's sheet after 30ms.
				await reference.waitForFunction( width =>
					document.getElementById( 'wrap' )!.style.width === `${ Math.max( 980, width ) }px`, width );
				await copy.setViewportSize( { width, height: 900 } );
				for ( const id of [ '#first', '#second', '#still' ] ) {
					const expected = await reference.locator( id ).boundingBox();
					const actual = await copy.locator( id ).boundingBox();
					expect( Math.abs( actual!.x - expected!.x ), `${ id } at ${ width }` ).toBeLessThanOrEqual( 1 );
					expect( actual!.y ).toBeCloseTo( expected!.y, 0 );
				}
			}
		} finally { await page.close(); await reference.close(); await copy.close(); }
	}, 40_000 );

	// A tagline fitter writes a size for the current width into its own sheet as
	// an !important id rule; no element carries inline geometry. Where it writes
	// the authored class step, the frozen rule would pin 62px at every width and
	// is dropped; where it shrank the text to fit, the fitted size is kept. A
	// fitter that only shrinks is judged by its sheets at load, not by what
	// capture's earlier probe resizes left behind (including a sheet it first
	// created at a probe width).
	const authored = 'innerWidth>=1536?64:innerWidth>=1280?62:40';
	const eager = ( size: string ) => `const sheet=document.head.appendChild(document.createElement('style'));
		const update=()=>{ sheet.textContent='#t { font-size: '+(${ size })+'px !important; }'; };
		addEventListener('resize',update);update();`;
	const shrinking = ( atLoad: boolean ) => `let sheet, last=1e9;
		const update=()=>{ sheet??=document.head.appendChild(document.createElement('style')); last=Math.min(last,${ authored }); sheet.textContent='#t { font-size: '+last+'px !important; }'; };
		addEventListener('resize',update);${ atLoad ? 'update();' : '' }`;
	const scaled = [ [ 390, '40px' ], [ 1440, '62px' ], [ 1600, '64px' ] ] as const;
	it.for( [
		[ 'drops a fitted size the authored cascade reproduces', eager( authored ), false, 1, scaled ],
		[ 'drops a shrink-only fitted size after probe resizes', shrinking( true ), true, 1, scaled ],
		[ 'empties a shrink-only sheet first created at a probe width', shrinking( false ), true, undefined, scaled ],
		[ 'keeps a fitted size that shrank the text', eager( 'innerWidth>=1536?34:30' ), false, undefined, [ [ 390, '30px' ], [ 1440, '30px' ], [ 1600, '30px' ] ] ],
	] as const )( '%s', { timeout: 60_000 }, async ( [ _label, fitter, probed, pruned, expected ], { newPage } ) => {
		const source = `<style>body{margin:0}#t{font-size:40px}@media (min-width:1280px){#t{font-size:62px}}@media (min-width:1536px){#t{font-size:64px}}</style>
			<h1 id="t">Estrategia</h1>
			<script>${ fitter }</script>`;
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		const copy = await newPage();
		try {
			// Capture installs the runtime-write tracker before any source script
			// and navigates; setContent's document.open() would drop its listeners.
			await page.addInitScript( observeRuntimeStyleWrites );
			await page.route( 'http://fixture.test/', route => route.fulfill( { contentType: 'text/html', body: source } ) );
			await page.goto( 'http://fixture.test/' );
			if ( probed ) {
				// Capture probes visit a phone width before the document is serialized.
				for ( const width of [ 390, 1440 ] ) {
					await page.setViewportSize( { width, height: 900 } );
					await page.evaluate( () => new Promise( requestAnimationFrame ) );
				}
				expect( await page.locator( '#t' ).evaluate( node => getComputedStyle( node ).fontSize ) ).toBe( '40px' );
			}
			// Serialization projects learning onto the document captured before the sweep.
			await restoreLoadTimeSheets( page );
			await markInitialDocument( page );
			const initial = await page.content();
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
			expect( result.byKind[ 'runtime-fitted' ] ).toBe( pruned );
			await copy.setContent( projectInitialDocument( initial, await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ) );
			for ( const [ width, size ] of expected ) {
				await copy.setViewportSize( { width, height: 900 } );
				expect( await copy.locator( '#t' ).evaluate( node => getComputedStyle( node ).fontSize ), `at ${ width }` ).toBe( size );
			}
		} finally { await page.close(); await copy.close(); }
	} );

	it( 'refines an adaptive sweep where only a runtime sheet changes and learns the full ladder\'s rules', async ({ newPage }) => {
		// Inline geometry is one line at every width; only the sheet switches,
		// inside the tablet band. Its offset series must drive refinement.
		const source = `<style>body{margin:0}#wrap{position:relative;height:200px}.item{width:40px;height:40px}</style>
			<div id="wrap" style="width:720px"><div id="first" class="item"></div></div>
			<script>
			const sheet=document.createElement('style');document.head.appendChild(sheet);
			const update=()=>{
				document.getElementById('wrap').style.width=innerWidth/2+'px';
				sheet.textContent='#wrap #first {position: absolute; top: 0; left: '+(innerWidth>=783?100:20)+'px;}';
			};
			addEventListener('resize',update);update();
			</script>`;
		const learn = async ( { newPage }: Pick<BrowserFixtures, 'newPage'>, widths?: number[] ) => {
			const page = await newPage( { viewport: { width: 1440, height: 900 } } );
			try {
				await page.setContent( source );
				const result = await learnAndApplyFluidGeometry( page, { settleMs: 30, ...( widths ? { widths } : {} ) } );
				const rules = await page.evaluate( attribute => [ ...document.querySelectorAll( `[${ attribute }]` ) ].map( node => node.textContent ?? '' ), RUNTIME_SHEET_RULES_ATTRIBUTE );
				return { result, rules };
			} finally { await page.close(); }
		};
		const full = await learn({ newPage },  DEFAULT_SWEEP_WIDTHS );
		const adaptive = await learn({ newPage });
		expect( full.rules.join( '\n' ) ).toContain( '(min-width:783px)' );
		expect( adaptive.rules ).toEqual( full.rules );
		expect( adaptive.result.byKind ).toEqual( full.result.byKind );
		expect( adaptive.result.sampledWidths ).toEqual( [ 320, 360, 390, 414, 600, 768, 775, 783, 801, 900, 1024, 1440, 1920 ] );
	}, 60_000 );

	it( 'locates a column switch that falls between two ladder widths', async ({ newPage }) => {
		// Two centred columns below 1105px, three from 1105px. The ladder has no
		// width between 1024 and 1200, so the switch must be located by extra widths.
		// The grid's inline width is ordinary runtime geometry, so the sweep runs.
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<style>body{margin:0}#grid{position:relative;margin:0 45px;height:1400px}.card{position:absolute;width:265px;height:600px}</style>
				<div id="grid" style="width:1350px"><div id="one" class="card"></div><div id="two" class="card"></div><div id="three" class="card"></div></div>
				<script>const sheet=document.createElement('style');document.head.appendChild(sheet);
				const update=()=>{
					const w=innerWidth, wide=w>=1105, a=wide?w/2-532.5:Math.max(175,w/2-355);
					document.getElementById('grid').style.width=(w-90)+'px';
					sheet.textContent='#grid #one{top:20px;inset-inline-start:'+a+'px}#grid #two{top:20px;inset-inline-start:'+(a+355)+'px}'+
						'#grid #three{top:'+(wide?20:700)+'px;inset-inline-start:'+(wide?a+710:a)+'px}';
				};
				addEventListener('resize',update);update();</script>` );
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
			const rules = ( await page.evaluate( attribute => [ ...document.querySelectorAll( `[${ attribute }]` ) ].map( node => node.textContent ?? '' ), RUNTIME_SHEET_RULES_ATTRIBUTE ) ).join( '\n' );
			// The three-column rule starts within a few pixels of the real switch, not at 1200.
			const switches = [ ...rules.matchAll( /@media \(min-width:(\d+)px\) \{\n[^\n]*#three\) \{ top: 20px/g ) ].map( match => Number( match[ 1 ] ) );
			expect( switches ).toHaveLength( 1 );
			expect( switches[ 0 ] ).toBeGreaterThanOrEqual( 1105 );
			expect( switches[ 0 ] ).toBeLessThanOrEqual( 1113 );
			expect( result.sampledWidths.filter( width => width > 1024 && width < 1200 ).length ).toBeLessThanOrEqual( MAX_LOCATING_WIDTHS );
			// Below the switch the two columns keep centring instead of holding one offset.
			expect( rules ).toContain( 'inset-inline-start: calc(50vw + -355px)' );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'stops after the probes when inline geometry and observed runtime sheets are constant', async ({ newPage }) => {
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<div id="wrap" style="width:720px;height:100px"><div id="item"></div></div>
				<script>const sheet=document.createElement('style');document.head.appendChild(sheet);
				const update=()=>{document.getElementById('wrap').style.width='720px';sheet.textContent='#item{position:absolute;left:20px;top:10px}/*'+innerWidth+'*/'};
				addEventListener('resize',update);update();</script>` );
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
			expect( result.sampledWidths ).toEqual( [ 390, 768, 1920 ] );
			expect( result.unmodelled ).toBe( 0 );
		} finally { await page.close(); }
	}, 20_000 );

	it( 'leaves authored stylesheets and width-independent runtime rules untouched', async ({ newPage }) => {
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( runtimeSheetSource( '#still{outline:1px solid red}@media (max-width:800px){#first{outline-offset:2px}}' ) );
			const authored = await page.evaluate( () => document.querySelector( 'style' )?.textContent );
			await learnAndApplyFluidGeometry( page, { widths: WIDTHS, settleMs: 30 } );
			expect( await page.evaluate( () => document.querySelector( 'style' )?.textContent ) ).toBe( authored );
			const learned = await page.evaluate( attribute => [ ...document.querySelectorAll( `[${ attribute }]` ) ].map( node => node.textContent ?? '' ).join( '\n' ), RUNTIME_SHEET_RULES_ATTRIBUTE );
			expect( learned ).toContain( '#wrap #first' );
			expect( learned ).toContain( '#wrap #second' );
			expect( learned ).not.toContain( '#still' );
			expect( learned ).not.toMatch( /\btop\b/ );
		} finally { await page.close(); }
	}, 40_000 );
} );
