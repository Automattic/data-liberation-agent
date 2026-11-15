import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

it.each( [ true, false ] )( 'restores slide geometry after a post-learning resize (keep nodes: %s)', async keepNodes => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1000, height: 700 } } );
		await page.setContent( `
			<style>body{margin:0}#strip{position:relative;width:50vw;height:100px;overflow:auto}.slide{position:absolute;height:100px}</style>
			<div id="gallery" class="wide"><div id="strip"></div></div>
			<script>
				function layout() {
					const width = innerWidth / 2;
					document.querySelector('#gallery').className = innerWidth < 800 ? 'narrow' : 'wide';
					if (!window.keepNodes) document.querySelector('#strip').innerHTML = [0,1].map(i =>
						'<div class="slide" style="width:'+width+'px;inset:0px auto auto '+i*width+'px">Slide '+i+'</div>'
					).join('');
				}
				addEventListener('resize', layout);
				layout();
			</script>
		` );
		await learnAndApplyFluidGeometry( page, { widths: [ 400, 800, 1200 ], settleMs: 10 } );
		const geometry = () => page.locator( '#strip' ).evaluate( strip => ( {
			client: strip.clientWidth, scroll: strip.scrollWidth,
			slides: [ ...strip.children ].map( slide => ( {
				width: slide.getBoundingClientRect().width,
				left: ( slide as HTMLElement ).offsetLeft,
				segment: slide.getAttribute( 'data-blocks-engine-capture-fluid-segment' ),
				inlineWidth: ( slide as HTMLElement ).style.width,
			} ) ),
		} ) );
		expect( ( await geometry() ).scroll ).toBeGreaterThan( ( await geometry() ).client );
		// Like responsive-resource acquisition, resize the live source after fluid
		// has stripped pixels, then return to its captured state in a later task.
		await page.evaluate( keep => { ( window as unknown as { keepNodes: boolean } ).keepNodes = keep; }, keepNodes );
		await page.setViewportSize( { width: 400, height: 700 } );
		await page.waitForFunction( () => document.querySelector( '#gallery' )!.className === 'narrow' );
		const suspended = await geometry();
		expect( suspended.scroll ).toBeGreaterThan( suspended.client );
		for ( const slide of suspended.slides ) expect( slide.width ).toBeGreaterThan( 0 );
		await page.setViewportSize( { width: 1000, height: 700 } );
		await page.waitForFunction( () => document.querySelector( '#gallery' )!.className === 'wide' );
		const returned = await geometry();
		expect( returned.scroll ).toBeGreaterThan( returned.client );
		expect( returned.slides.map( slide => [ slide.width, slide.left ] ) ).toEqual( [ [ 500, 0 ], [ 500, 500 ] ] );
		for ( const slide of returned.slides ) expect( Boolean( slide.segment || slide.inlineWidth ) ).toBe( true );
	} finally { await browser.close(); }
}, 20_000 );
