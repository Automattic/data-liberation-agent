import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { learnAndApplyFluidGeometry } from '../../lib/screenshot/fluid-capture.js';
import { capture } from './capture.js';
import { wixGalleryStripGeometry, type WixGalleryStripReading } from './gallery-strip-geometry.js';

const reading = ( overrides: Partial< Record< 'parent' | 'container' | 'scroll', Partial< WixGalleryStripReading[ 'parent' ] > > > = {} ): WixGalleryStripReading => ( {
	hostWidth: 1440,
	parent: { className: 'pro-gallery-parent-container gallery-slider', width: '1440px', important: false, base: 1440, ...overrides.parent },
	container: { className: 'pro-gallery inline-styles one-row hide-scrollbars slider ltr', width: '1450px', important: false, base: 1440, ...overrides.container },
	scroll: { className: 'gallery-horizontal-scroll gallery-column scroll-snap', width: '1450px', important: false, base: 1450, ...overrides.scroll },
} );

describe( 'wixGalleryStripGeometry', () => {
	it( 'maps a strip sized to its host plus a delta onto host-relative widths', () => {
		expect( wixGalleryStripGeometry( reading() ) ).toEqual( { parent: '100%', container: 'calc(100% + 10px)', scroll: '100%' } );
	} );

	it( 'declines markup that is not a horizontal strip and pixels that are not the host relationship', () => {
		expect( wixGalleryStripGeometry( reading( { container: { className: 'pro-gallery inline-styles ltr' } } ) ) ).toBeNull();
		expect( wixGalleryStripGeometry( reading( { scroll: { className: 'gallery-column' } } ) ) ).toBeNull();
		expect( wixGalleryStripGeometry( reading( { parent: { width: '1200px' } } ) ) ).toBeNull();
		expect( wixGalleryStripGeometry( reading( { scroll: { width: '1460px' } } ) ) ).toBeNull();
		expect( wixGalleryStripGeometry( reading( { container: { width: '90%' } } ) ) ).toBeNull();
		expect( wixGalleryStripGeometry( reading( { parent: { important: true } } ) ) ).toBeNull();
	} );
} );

/**
 * The runtime as measured on a live Wix page: a horizontal strip whose parent
 * container is written at the host's width, and whose container and scroll
 * strip are the host plus 10 px. On ketatov.com the gallery re-lays out too
 * late for the width sweep to see, so every sample reads the capture width's
 * pixels; the stand-in lays out once. Items keep their pixel boxes inside the
 * scroll strip.
 */
const strip = ( layout: string, delta: number ) => `<style>body{margin:0}.host{width:100%;min-width:980px}
	.pro-gallery-parent-container{margin:-5px}.pro-gallery{position:relative}.gallery-horizontal-scroll{overflow-x:scroll}
	.item{position:absolute;top:0;height:200px;background:#999}</style>
	<div class="host"><div class="pro-gallery-parent-container gallery-slider">
		<div id="pro-gallery-container-comp-a" class="pro-gallery inline-styles ${ layout } ltr" style="display:flex">
			<div id="gallery-horizontal-scroll-comp-a" class="gallery-horizontal-scroll gallery-column scroll-snap">
				<div class="strip" style="position:relative;width:2400px;height:200px">
					${ [ 0, 1, 2, 3 ].map( i => `<div class="item" id="item-${ i }" style="left:${ i * 600 }px;width:590px"></div>` ).join( '' ) }
				</div>
			</div>
		</div>
	</div></div>
	<script id="runtime">
		const layOut = () => {
			const host = document.querySelector( '.host' ).getBoundingClientRect().width;
			document.querySelector( '.pro-gallery-parent-container' ).style.width = host + 'px';
			document.querySelector( '.pro-gallery-parent-container' ).style.height = '200px';
			for ( const id of [ 'pro-gallery-container-comp-a', 'gallery-horizontal-scroll-comp-a' ] ) {
				document.getElementById( id ).style.width = ( host + ${ delta } ) + 'px';
				document.getElementById( id ).style.height = '205px';
			}
		};
		layOut();
	</script>`;

/** The strip's container width and each item box relative to it, at the current width. */
const boxes = () => {
	const container = document.querySelector( '[id^="pro-gallery-container-"]' )!.getBoundingClientRect();
	const host = document.querySelector( '.host' )!.getBoundingClientRect().width;
	const items = [ ...document.querySelectorAll( '.item' ) ].map( item => {
		const box = item.getBoundingClientRect();
		return [ item.id, box.x - container.x, box.y - container.y, box.width, box.height ];
	} );
	return { host, container: container.width, items };
};

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'wix beforeSerialize gallery strips', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	/** Learn fluid geometry and run the hook at 1440 as capture does, then render the frozen document (no runtime) at each width. */
	const frozenAt = async ( markup: string, widths: number[] ) => {
		const tab = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await tab.setContent( markup );
			const learned = await learnAndApplyFluidGeometry( tab, { settleMs: 10 } );
			await capture.beforeSerialize!( tab, { url: 'https://example.com/', viewport: 'desktop' } );
			const frozen = await tab.evaluate( () => {
				document.getElementById( 'runtime' )!.remove();
				return document.documentElement.outerHTML;
			} );
			const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			try {
				await copy.setContent( frozen );
				const reference = await copy.evaluate( boxes );
				const results = [];
				for ( const width of widths ) {
					await copy.setViewportSize( { width, height: 900 } );
					results.push( { width, ...( await copy.evaluate( boxes ) ) } );
				}
				return { reference, results, styles: await copy.evaluate( () => [ '.pro-gallery-parent-container', '[id^="pro-gallery-container-"]', '[id^="gallery-horizontal-scroll-"]' ].map( selector => document.querySelector( selector )!.getAttribute( 'style' ) ) ) };
			} finally {
				await copy.close();
			}
		} finally {
			await tab.close();
		}
	};

	it( 'carries a horizontal strip as host-relative widths, so the copy follows its host with item boxes unchanged', async () => {
		const { reference, results } = await frozenAt( strip( 'one-row slider', 10 ), [ 390, 768, 1440, 1920 ] );
		expect( reference.container ).toBe( 1450 );
		for ( const result of results ) {
			expect( result.container ).toBe( result.host + 10 );
			expect( result.items ).toEqual( reference.items );
		}
		expect( results.map( result => result.container ) ).toEqual( [ 990, 990, 1450, 1930 ] );
	}, 30_000 );

	it( 'leaves a gallery that is not a horizontal strip as the runtime wrote it', async () => {
		const { styles } = await frozenAt( strip( 'one-row', 10 ), [] );
		expect( styles ).toEqual( [ 'width: 1440px; height: 200px;', 'display: flex; width: 1450px; height: 205px;', 'width: 1450px; height: 205px;' ] );
	}, 30_000 );
} );
