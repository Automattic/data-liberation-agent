import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { DEFAULT_SWEEP_WIDTHS, learnAndApplyFluidGeometry } from './fluid-capture.js';
import { RUNTIME_SHEET_RULES_ATTRIBUTE } from './fluid-runtime-sheets.js';

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
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	it( 'keeps canvas offsets below the capture width instead of freezing the capture width sheet', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		const reference = await browser.newPage();
		const copy = await browser.newPage();
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
				await reference.waitForTimeout( 30 );
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

	it( 'refines an adaptive sweep where only a runtime sheet changes and learns the full ladder\'s rules', async () => {
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
		const learn = async ( widths?: number[] ) => {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			try {
				await page.setContent( source );
				const result = await learnAndApplyFluidGeometry( page, { settleMs: 30, ...( widths ? { widths } : {} ) } );
				const rules = await page.evaluate( attribute => [ ...document.querySelectorAll( `[${ attribute }]` ) ].map( node => node.textContent ?? '' ), RUNTIME_SHEET_RULES_ATTRIBUTE );
				return { result, rules };
			} finally { await page.close(); }
		};
		const full = await learn( DEFAULT_SWEEP_WIDTHS );
		const adaptive = await learn();
		expect( full.rules.join( '\n' ) ).toContain( '(min-width:783px)' );
		expect( adaptive.rules ).toEqual( full.rules );
		expect( adaptive.result.byKind ).toEqual( full.result.byKind );
		expect( adaptive.result.sampledWidths ).toEqual( [ 390, 600, 768, 775, 783, 801, 1024, 1440, 1920 ] );
	}, 60_000 );

	it( 'leaves authored stylesheets and width-independent runtime rules untouched', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
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
