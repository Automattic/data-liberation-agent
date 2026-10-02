import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

describe( 'learnAndApplyFluidGeometry', () => {
	let browser: Browser;

	beforeAll( async () => {
		browser = await chromium.launch();
	} );

	afterAll( async () => {
		await browser.close();
	} );

	it( 'preserves fractional constant typography through learning and static serialization', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		const copy = await browser.newPage();
		try {
			await page.setContent( '<p id="copy" style="font-family:serif;font-size:17.94px;line-height:1.2">A long editorial text run must keep its original subpixel font metrics.</p>' );
			const measure = async ( target: typeof page ) => target.locator( '#copy' ).evaluate( element => {
				const style = getComputedStyle( element );
				const canvas = document.createElement( 'canvas' ).getContext( '2d' )!;
				canvas.font = `${ style.fontSize } ${ style.fontFamily }`;
				return { fontSize: style.fontSize, lineHeight: style.lineHeight, advance: canvas.measureText( element.textContent! ).width };
			} );
			const before = await measure( page );
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 50 } );
			await copy.setContent( await page.content() );
			for ( const width of [ 390, 768, 1440 ] ) {
				await copy.setViewportSize( { width, height: 900 } );
				expect( await measure( copy ) ).toEqual( before );
			}
		} finally { await page.close(); await copy.close(); }
	} );

	it( 'preserves minimum sizing and blank paragraph typography without a width sweep', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<p id="blank" style="font-size:12px;line-height:normal;margin:0;min-height:14px"><br></p>
				<div style="min-width:100px;max-width:500px;min-height:20px"></div>
				<div style="width:50%;height:auto"></div>` );
			const original = await page.locator( '#blank' ).getAttribute( 'style' );
			const originalHeight = await page.locator( '#blank' ).evaluate( element => element.getBoundingClientRect().height );
			const resize = vi.spyOn( page, 'setViewportSize' );
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 10 } );
			expect( resize ).not.toHaveBeenCalled();
			expect( result.applied ).toBe( 0 );
			expect( await page.locator( '#blank' ).getAttribute( 'style' ) ).toBe( original );
			expect( await page.locator( '#blank' ).evaluate( element => element.getBoundingClientRect().height ) ).toBe( originalHeight );
		} finally {
			await page.close();
		}
	} );

	it( 'still learns runtime-sized text, generated glyphs, and explicit blank spacers', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<style>#glyph::before{content:'★'}</style>
				<p id="text" style="font-size:18px">Text<br></p>
				<p id="glyph" style="font-size:18px"><br></p>
				<p id="spacer" style="width:720px"><br></p>
				<script>function update(){
					document.getElementById('text').style.fontSize = innerWidth / 80 + 'px';
					document.getElementById('glyph').style.fontSize = innerWidth / 80 + 'px';
					document.getElementById('spacer').style.width = innerWidth / 2 + 'px';
				} addEventListener('resize',update);update();</script>` );
			const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 50 } );
			expect( result.applied ).toBeGreaterThanOrEqual( 3 );
			for ( const id of [ 'text', 'glyph' ] ) {
				expect( await page.locator( `#${ id }` ).getAttribute( 'style' ) ).toContain( 'vw' );
			}
			expect( await page.locator( '#spacer' ).getAttribute( 'style' ) ).toMatch( /(?:50vw|100%)/ );
		} finally {
			await page.close();
		}
	} );

	it( 'never learns a top offset: anchor targets move with their section instead', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<section id="feature-section" style="position:relative;height:400px"><span id="features" data-dla-anchor-target="features" data-dla-anchor-source-id="feature-section" style="position:absolute;width:0;height:0"></span></section>
			<div id="ordinary" style="position:absolute;top:144px;width:100px;height:100px"></div>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( '#features' ).getAttribute( 'style' ) ).not.toContain( 'top' );
		expect( await page.locator( '#ordinary' ).getAttribute( 'style' ) ).toContain( 'top:144px' );
		await page.close();
	} );

	it( 'keeps container-derived heights definite after runtime removal', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div id="runtime-parent"><div id="canvas" style="height:720px"></div></div>
			<script>
				const update = () => {
					const height = innerWidth * 0.5;
					document.querySelector('#runtime-parent').style.height = height + 'px';
					document.querySelector('#canvas').style.height = height + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( '#canvas' ).getAttribute( 'style' ) ).toContain( 'height: 50vw' );
		await page.locator( '#runtime-parent' ).evaluate( ( element ) => {
			element.style.height = 'auto';
		} );
		expect( await page.locator( '#canvas' ).evaluate( ( element ) => element.getBoundingClientRect().height ) ).toBeGreaterThan( 1 );
		await page.close();
	} );

	it( 'never collapses a tile whose only container is sized by the tile itself', async () => {
		// A gallery tile inside a shrink-to-fit item: every ancestor measures
		// exactly the tile, so "fills its parent" fits every sample — but that
		// parent has no definite size of its own, and a percentage collapses it.
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div style="position:relative">
				<div id="item" style="position:absolute;top:0;left:0"><div id="shrink">
					<div id="tile" style="height:744px;width:628px;margin:0px"></div>
				</div></div>
			</div>
			<script>
				const sizes = {
					390: [ 390, 900 ], 600: [ 600, 900 ], 768: [ 768, 582 ], 1024: [ 447, 789 ],
					1280: [ 558, 761 ], 1440: [ 628, 744 ], 1920: [ 698, 726 ],
				};
				const update = () => {
					const [ width, height ] = sizes[ innerWidth ] ?? sizes[ 1440 ];
					document.getElementById( 'tile' ).style.width = width + 'px';
					document.getElementById( 'tile' ).style.height = height + 'px';
				};
				addEventListener( 'resize', update );
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		const style = await page.locator( '#tile' ).getAttribute( 'style' );
		expect( style ).not.toContain( '100%' );
		// Removing the runtime leaves the tile at the size the source rendered.
		await page.evaluate( () => document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() ) );
		const box = await page.locator( '#tile' ).boundingBox();
		expect( Math.abs( box!.width - 628 ) ).toBeLessThanOrEqual( 2 );
		expect( Math.abs( box!.height - 744 ) ).toBeLessThanOrEqual( 2 );
		await page.close();
	}, 20_000 );

	it( 'follows the sampled sizes when a container fit cannot be verified', async () => {
		// The same shrink-to-fit gallery tile: the percentage is refused, and no
		// single viewport expression fits the whole sweep. The sweep still saw
		// the tile at every width, so the copy must follow those sizes rather
		// than keep the capture width's everywhere.
		const sizes: Record< number, [ number, number ] > = {
			390: [ 390, 900 ], 600: [ 600, 900 ], 768: [ 768, 582 ], 1024: [ 447, 789 ],
			1280: [ 558, 761 ], 1440: [ 628, 744 ], 1920: [ 698, 726 ],
		};
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div style="position:relative">
				<div id="item" style="position:absolute;top:0;left:0"><div id="shrink">
					<div id="tile" style="height:744px;width:628px;margin:0px"></div>
				</div></div>
			</div>
			<script>
				const sizes = ${ JSON.stringify( sizes ) };
				const update = () => {
					const [ width, height ] = sizes[ innerWidth ] ?? sizes[ 1440 ];
					document.getElementById( 'tile' ).style.width = width + 'px';
					document.getElementById( 'tile' ).style.height = height + 'px';
				};
				addEventListener( 'resize', update );
				update();
			</script>
		` );

		const result = await learnAndApplyFluidGeometry( page, {
			widths: Object.keys( sizes ).map( Number ),
			settleMs: 50,
		} );

		// Serialize and reload without the runtime, as the exported copy does.
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const [ width, [ expectedWidth, expectedHeight ] ] of Object.entries( sizes ) ) {
			await copy.setViewportSize( { width: Number( width ), height: 900 } );
			const box = await copy.locator( '#tile' ).boundingBox();
			expect( Math.abs( box!.width - expectedWidth ), `width at ${ width }` ).toBeLessThanOrEqual( 2 );
			expect( Math.abs( box!.height - expectedHeight ), `height at ${ width }` ).toBeLessThanOrEqual( 2 );
		}
		// Between samples the width follows the fitted rule, not the capture width.
		await copy.setViewportSize( { width: 1100, height: 900 } );
		expect( Math.round( ( await copy.locator( '#tile' ).boundingBox() )!.width ) ).toBe( 480 );
		expect( result.unmodelled ).toBe( 0 );
		await copy.close();
		await page.close();
	}, 20_000 );

	it( 'keeps a gallery image fluid through a zero-width picture parent', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div id="item" style="width:412px;height:412px"><picture><img id="image" style="width:412px;height:412px"></picture></div>
			<script>
				const sizes = { 390:294, 600:287, 768:281 };
				const update = () => {
					const size = sizes[innerWidth] ?? Math.round(innerWidth * 0.3 - 20);
					for (const id of ['item', 'image']) {
						const element = document.getElementById(id);
						element.style.width = size + 'px';
						element.style.height = size + 'px';
					}
				};
				addEventListener('resize', update);
				update();
			</script>
		` );
		await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const [ width, expected ] of [ [ 390, 294 ], [ 768, 281 ], [ 1440, 412 ], [ 1600, 460 ], [ 1728, 498 ] ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const box = await copy.locator( '#image' ).boundingBox();
			expect( Math.abs( box!.width - expected ), `image at ${ width }` ).toBeLessThanOrEqual( 2 );
		}
		await copy.close();
		await page.close();
	}, 30_000 );

	it( 'retains gallery grid positions written as absolute inset coordinates', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div style="position:relative"><div id="first" style="position:absolute;inset:0px auto auto 0px;width:412px;height:412px"></div>
			<div id="second" style="position:absolute;inset:0px auto auto 442px;width:412px;height:412px"></div>
			<div id="third" style="position:absolute;inset:442px auto auto 442px;width:412px;height:412px"></div></div>
			<script>
				const narrow = { 390: [294, 324], 600: [287, 317], 768: [281, 311] };
				const update = () => {
					const [tile, step] = narrow[innerWidth] ?? [Math.round(innerWidth * .3 - 20), Math.round(innerWidth * .3 + 10)];
					for (const [id, top, left] of [['first', 0, 0], ['second', 0, step], ['third', step, step]]) {
						const el = document.getElementById(id);
						el.style.inset = top + 'px auto auto ' + left + 'px';
						el.style.width = tile + 'px';
						el.style.height = tile + 'px';
					}
				};
				addEventListener('resize', update);
				update();
			</script>
		` );
		await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const [ width, step ] of [ [ 390, 324 ], [ 768, 311 ], [ 1440, 442 ], [ 1600, 490 ], [ 1728, 528 ] ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const first = await copy.locator( '#first' ).boundingBox();
			const second = await copy.locator( '#second' ).boundingBox();
			const third = await copy.locator( '#third' ).boundingBox();
			expect( Math.abs( second!.x - first!.x - step ), `column at ${ width }` ).toBeLessThanOrEqual( 2 );
			expect( Math.abs( third!.y - first!.y - step ), `row at ${ width }` ).toBeLessThanOrEqual( 2 );
		}
		await copy.close();
		await page.close();
	}, 30_000 );

	it( 'keeps a fluid tile wrapper sized when its intermediate parent shrink-wraps it', async () => {
		const page = await browser.newPage( { viewport: { width: 980, height: 900 } } );
		await page.setContent( `
			<div style="position:relative;width:100vw">
				<div id="item" style="position:absolute;top:0;left:0;width:253px;height:253px">
					<div id="shrink"><div id="wrapper" style="width:253px;height:253px">
						<div id="tile" style="width:253px;height:253px"></div>
					</div></div>
				</div>
			</div>
			<script>
				const update = () => {
					const width = Math.max(253, Math.round(innerWidth / 3 - 73));
					for (const id of ['item', 'wrapper', 'tile']) {
						const element = document.getElementById(id);
						element.style.width = width + 'px';
						element.style.height = width + 'px';
					}
				};
				addEventListener('resize', update);
				update();
			</script>
		` );
		await learnAndApplyFluidGeometry( page, { settleMs: 30 } );
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 980, height: 900 } } );
		await copy.setContent( html );
		for ( const [ width, expected ] of [ [ 390, 253 ], [ 768, 253 ], [ 1440, 407 ], [ 1600, 460 ], [ 1728, 503 ] ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			for ( const id of [ 'item', 'wrapper', 'tile' ] ) {
				const box = await copy.locator( `#${ id }` ).boundingBox();
				expect( Math.abs( box!.width - expected ), `${ id } at ${ width }` ).toBeLessThanOrEqual( 2 );
			}
		}
		await copy.close();
		await page.close();
	}, 30_000 );

	it( 'preserves responsive wrapper reflow across desktop regimes', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div id="wrapper" style="width:321px;height:180px"><img src="about:blank" style="display:block;width:100%;height:100%"></div>
			<script>
				const update = () => {
					const width = innerWidth >= 1600 ? 358 : 321;
					document.getElementById('wrapper').style.width = width + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 768, 1024, 1280, 1440, 1600, 1680, 1840, 1920 ],
			settleMs: 50,
		} );
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const [ width, expected ] of [ [ 1440, 321 ], [ 1600, 358 ], [ 1680, 358 ], [ 1728, 358 ] ] as const ) {
			await copy.setViewportSize( { width, height: 900 } );
			const box = await copy.locator( '#wrapper' ).boundingBox();
			expect( Math.abs( ( box?.width ?? 0 ) - expected ), `wrapper width at ${ width }` ).toBeLessThanOrEqual( 2 );
		}
		await copy.close();
		await page.close();
	}, 30_000 );

	it( 'learns runtime-written fluid font sizes', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<h1 id="portfolio" style="font-size: 10px">PORTFOLIO</h1>
			<script>
				const update = () => document.querySelector('#portfolio').style.fontSize = (innerWidth * 0.233) + 'px';
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( '#portfolio' ).getAttribute( 'style' ) ).toContain( 'font-size: 23.3vw' );
		await page.evaluate( () => {
			setTimeout( () => {
				document.querySelector< HTMLElement >( '#portfolio' )!.style.fontSize = '336.6px';
			}, 10 );
		} );
		await page.waitForTimeout( 40 );
		expect( await page.locator( '#portfolio' ).getAttribute( 'style' ) ).toContain( 'font-size: 23.3vw' );
		await page.close();
	} );

	it( 'learns the ceiling when the widest sample is capped', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<h1 id="portfolio" style="font-size: 10px">PORTFOLIO</h1>
			<script>
				const update = () => document.querySelector('#portfolio').style.fontSize = Math.min(innerWidth * 0.2, 300) + 'px';
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( '#portfolio' ).getAttribute( 'style' ) ).toContain( 'font-size: min(300px, 20vw)' );
		// At an unsampled width past the switch the ceiling, not the slope, must win.
		await page.setViewportSize( { width: 1600, height: 900 } );
		expect(
			await page.locator( '#portfolio' ).evaluate( ( element ) => getComputedStyle( element ).fontSize )
		).toBe( '300px' );
		await page.close();
	}, 20_000 );

	it( 'ships one rule per regime when the container share changes at the mobile breakpoint', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<style>
				#scaled-container { width: 88vw; }
				@media (min-width: 768px) { #scaled-container { width: 96vw; } }
			</style>
			<div id="scaled-container">
				<h1 id="portfolio" style="font-size: 10px">PORTFOLIO</h1>
			</div>
			<script>
				const update = () => {
					const container = document.getElementById('scaled-container');
					document.getElementById('portfolio').style.fontSize = (container.clientWidth * 0.2434) + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		// Above 768px the box spans 96% of the viewport but on a phone it
		// spans 88%, so no single vw expression reproduces both regimes. The
		// rules live in a stylesheet keyed by a persistent attribute, and the
		// runtime's inline pixels must not outrank them.
		const style = await page.locator( 'style[data-dla-fluid-rules]' ).textContent();
		expect( style ).toContain( '@media (max-width:767px)' );
		expect( style ).toContain( '21.42vw' );
		expect( style ).toContain( '@media (min-width:768px)' );
		expect( style ).toContain( '23.36vw' );
		expect( await page.locator( '#portfolio' ).getAttribute( 'data-dla-fluid-segment' ) ).toBeTruthy();
		expect( await page.locator( '#portfolio' ).getAttribute( 'style' ) ).not.toContain( 'font-size' );

		// A width the sweep sampled on the mobile regime: the source's own
		// runtime renders 83.5px here; a single desktop fit would render 91.2px.
		await page.setViewportSize( { width: 390, height: 900 } );
		await page.waitForTimeout( 80 );
		const mobileFontSize = await page
			.locator( '#portfolio' )
			.evaluate( ( element ) => parseFloat( getComputedStyle( element ).fontSize ) );
		expect( Math.abs( mobileFontSize - 83.5 ) ).toBeLessThanOrEqual( 2 );

		// The desktop regime must stay exact too.
		await page.setViewportSize( { width: 1440, height: 900 } );
		await page.waitForTimeout( 80 );
		const desktopFontSize = await page
			.locator( '#portfolio' )
			.evaluate( ( element ) => parseFloat( getComputedStyle( element ).fontSize ) );
		expect( Math.abs( desktopFontSize - 0.2434 * 1382 ) ).toBeLessThanOrEqual( 2 );
		await page.close();
	}, 20_000 );

	it( 'keeps segmented rules authoritative when the source runtime writes pixels after learning', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<style>
				#scaled-container { width: 88vw; }
				@media (min-width: 768px) { #scaled-container { width: 96vw; } }
			</style>
			<div id="scaled-container">
				<h1 id="portfolio" style="font-size: 10px">PORTFOLIO</h1>
			</div>
			<script>
				const update = () => {
					const container = document.getElementById('scaled-container');
					document.getElementById('portfolio').style.fontSize = (container.clientWidth * 0.2434) + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( 'style[data-dla-fluid-rules]' ).textContent() ).toContain( '21.42vw' );
		// A late runtime write (viewport resize, re-layout) would put back
		// inline pixels, which outrank the stylesheet at every width. The
		// capture must strip them until serialization.
		await page.setViewportSize( { width: 1024, height: 900 } );
		await page.waitForTimeout( 120 );
		expect( await page.locator( '#portfolio' ).getAttribute( 'style' ) ).not.toContain( 'font-size' );
		const fontSize = await page
			.locator( '#portfolio' )
			.evaluate( ( element ) => parseFloat( getComputedStyle( element ).fontSize ) );
		expect( Math.abs( fontSize - 0.2434 * 983 ) ).toBeLessThanOrEqual( 2 );
		await page.close();
	}, 20_000 );

	it( 'keeps mixed-unit image height responsive and intrinsic width aligned after serialization', async () => {
		const source = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await source.setContent( `
			<style>
				#frame { position: relative; width: 420px; height: 228px; left: 84px }
				@media (max-width: 500px) { #frame { --image-height: 208px } }
				@media (min-width: 501px) and (max-width: 767px) { #frame { --image-height: 100% } }
				#image { position: absolute; width: var(--image-width); height: var(--image-height) }
			</style>
			<div id="frame" style="--image-height: 369.333px; --image-width: 231px"><div id="image"></div></div>
			<script>
				const update = () => {
					const frame = document.querySelector( '#frame' );
					const height =
						innerWidth < 768
							? innerWidth === 390
								? '208px'
								: '100%'
							: ( innerWidth * 0.23 ) + 'px';
					frame.style.setProperty( '--image-height', height );
				};
				addEventListener( 'resize', update );
				update();
			</script>` );
		const heights: Record< number, number > = {};
		for ( const width of [ 390, 600, 768, 1024, 1280, 1440, 1536, 1680, 1792, 1920 ] ) {
			await source.setViewportSize( { width, height: 900 } );
			await source.waitForTimeout( 10 );
			heights[ width ] = ( await source.locator( '#image' ).boundingBox() )!.height;
		}
		await learnAndApplyFluidGeometry( source, { settleMs: 30 } );
		const html = await source.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const width of [ 390, 600, 1600, 1728 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const box = ( await copy.locator( '#image' ).boundingBox() )!;
			expect(
				Math.abs( box.height - ( heights[ width ] ?? width * 0.23 ) ),
				`height at ${ width }`
			).toBeLessThanOrEqual( 2 );
			expect( box.width, `intrinsic width at ${ width }` ).toBe( 231 );
			expect( box.x, `alignment at ${ width }` ).toBe( 92 );
		}
		await copy.close();
		await source.close();
	}, 30_000 );

	it( 'learns a translated positioned image owner across independent widths', async () => {
		const source = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await source.setContent( `
			<style>body { margin: 0 }</style>
			<div id="frame" style="position: relative; width: 100vw; height: 300px">
				<div id="owner" style="position: absolute; width: 231px; height: 228px; transform: matrix(1, 0, 0, 1, 754.776, 0)">
					<img id="image" width="231" height="228" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='231' height='228'/%3E">
				</div>
			</div>
			<script>
				const update = () => {
					const x = innerWidth * 0.52415;
					document.querySelector( '#owner' ).style.transform = 'matrix(1, 0, 0, 1, ' + x + ', 0)';
				};
				addEventListener( 'resize', update );
				update();
			</script>` );
		for ( const width of [ 390, 600, 768, 1024, 1280, 1440, 1536, 1840, 1920 ] ) {
			await source.setViewportSize( { width, height: 900 } );
			await source.waitForTimeout( 10 );
		}
		await learnAndApplyFluidGeometry( source, { settleMs: 30 } );
		const html = await source.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.setContent( html );
		for ( const width of [ 1600, 1728 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			const box = await copy.locator( '#image' ).boundingBox();
			expect( Math.abs( box!.x - width * 0.52415 ), `image x at ${ width }` ).toBeLessThanOrEqual( 2 );
			expect( box!.width ).toBe( 231 );
		}
		await copy.close();
		await source.close();
	}, 30_000 );

	it( 'does not rewrite scaled, rotated, or vertically translated matrices', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		const matrices = [
			'matrix(2, 0, 0, 2, 40, 0)',
			'matrix(0, 1, -1, 0, 40, 0)',
			'matrix(1, 0, 0, 1, 40, 24)',
		];
		await page.setContent( `
			<div id="scaled" style="width: 40px; height: 40px; transform: ${ matrices[ 0 ] }"></div>
			<div id="rotated" style="width: 40px; height: 40px; transform: ${ matrices[ 1 ] }"></div>
			<div id="vertical" style="width: 40px; height: 40px; transform: ${ matrices[ 2 ] }"></div>
		` );
		await learnAndApplyFluidGeometry( page, { settleMs: 20 } );
		for ( const [ index, id ] of [ 'scaled', 'rotated', 'vertical' ].entries() ) {
			expect(
				await page.locator( `#${ id }` ).evaluate( ( element ) => getComputedStyle( element ).transform )
			).toBe( matrices[ index ] );
			expect( await page.locator( `#${ id }` ).getAttribute( 'data-dla-fluid-segment' ) ).toBeNull();
		}
		const html = await page.evaluate( () => {
			document.querySelectorAll( 'script' ).forEach( ( script ) => script.remove() );
			return document.documentElement.outerHTML;
		} );
		const copy = await browser.newPage( { viewport: { width: 1600, height: 900 } } );
		await copy.setContent( html );
		for ( const [ index, id ] of [ 'scaled', 'rotated', 'vertical' ].entries() ) {
			expect(
				await copy.locator( `#${ id }` ).evaluate( ( element ) => getComputedStyle( element ).transform )
			).toBe( matrices[ index ] );
		}
		await copy.close();
		await page.close();
	}, 30_000 );

	it( 'keeps a non-translation matrix written when the sweep restores its viewport', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<div id="owner" style="width: 231px; height: 228px; transform: matrix(1, 0, 0, 1, 754.776, 0)"></div>
			<script>
				let restored = false;
				addEventListener( 'resize', () => {
					const owner = document.querySelector( '#owner' );
					if ( innerWidth === 1440 && restored ) {
						owner.style.transform = 'matrix(0, 1, -1, 0, 754.776, 24)';
					} else {
						owner.style.transform = 'matrix(1, 0, 0, 1, ' + ( innerWidth * 0.52415 ) + ', 0)';
					}
					if ( innerWidth === 1440 ) restored = true;
				} );
			</script>
		` );
		await learnAndApplyFluidGeometry( page, { settleMs: 30 } );

		expect( await page.locator( '#owner' ).getAttribute( 'style' ) ).toContain( 'matrix(0, 1, -1, 0, 754.776, 24)' );
		expect( await page.locator( '#owner' ).getAttribute( 'data-dla-fluid-segment' ) ).toBeNull();
		await page.close();
	}, 30_000 );

	it( 'learns a runtime-written header offset as media-scoped padding rules', async () => {
		// A fixed header's clearance is written onto the first section as
		// inline pixels: mobile padding is 12vw of chrome plus 37.5px of
		// header content; desktop is chrome content the sweep cannot formula
		// (given here exactly as the live site reported it at the sampled
		// widths). The learned rules must reproduce both regimes and leave
		// the unfittable desktop tail at the value it observed.
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		// The site also offsets the section from a more specific author rule
		// reading a runtime variable that is only measured at load, as real
		// platforms do. The runtime's inline pixels outranked that rule; the
		// learned rules replace them, so they must outrank it too — or the
		// copy silently ships the variable's frozen capture-width value.
		await page.setContent( `
			<style>:root { --header-height: 79.0469px; }
			main .sections .page-section:first-child { padding-top: var(--header-height, 100px); }</style>
			<main><div class="sections"><section id="first-section" class="page-section" data-test="page-section" style="min-height: 1vh; padding-top: 79.0469px"></section></div></main>
			<script>
				const desktop = { 1024: 61.8438, 1280: 72.375, 1440: 79.0469, 1920: 88.8281 };
				const update = () => {
					const width = innerWidth;
					const pad = width < 800
						? width * 0.12 + 37.5
						: width <= 1024 ? desktop[1024]
						: width <= 1280 ? desktop[1024] + (width - 1024) / 256 * (desktop[1280] - desktop[1024])
						: width <= 1440 ? desktop[1280] + (width - 1280) / 160 * (desktop[1440] - desktop[1280])
						: desktop[1440] + (width - 1440) / 480 * (desktop[1920] - desktop[1440]);
					document.getElementById('first-section').style.paddingTop = pad + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		const style = await page.locator( 'style[data-dla-fluid-rules]' ).textContent();
		expect( style ).toContain( '@media (max-width:1023px)' );
		expect( style ).toContain( 'calc(12vw + 37.5px)' );
		expect( style ).toContain( '@media (min-width:1024px) and (max-width:1919px)' );
		expect( style ).toContain( '@media (min-width:1920px)' );
		expect( await page.locator( '#first-section' ).getAttribute( 'data-dla-fluid-segment' ) ).toBeTruthy();
		expect( await page.locator( '#first-section' ).getAttribute( 'style' ) ).not.toContain( 'padding-top' );

		// A late runtime write must not put inline pixels back above the rules.
		await page.setViewportSize( { width: 1000, height: 900 } );
		await page.waitForTimeout( 120 );
		expect( await page.locator( '#first-section' ).getAttribute( 'style' ) ).not.toContain( 'padding-top' );

		// The mobile regime reproduces the source's clearance at 390.
		await page.setViewportSize( { width: 390, height: 900 } );
		await page.waitForTimeout( 80 );
		const mobilePadding = await page
			.locator( '#first-section' )
			.evaluate( ( element ) => parseFloat( getComputedStyle( element ).paddingTop ) );
		expect( Math.abs( mobilePadding - 84.3 ) ).toBeLessThanOrEqual( 1 );

		// The sampled desktop answer stays exact at the capture width.
		await page.setViewportSize( { width: 1440, height: 900 } );
		await page.waitForTimeout( 80 );
		const desktopPadding = await page
			.locator( '#first-section' )
			.evaluate( ( element ) => parseFloat( getComputedStyle( element ).paddingTop ) );
		expect( Math.abs( desktopPadding - 79.0469 ) ).toBeLessThanOrEqual( 1 );
		await page.close();
	}, 20_000 );

	it( 'learns runtime padding on ordinary rendered geometry without platform markers', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<style>html { scroll-behavior:smooth } body { min-height:2400px }.hero { height: 180px; }</style>
			<main><div id="hero" class="hero" style="padding-top:178.781px"></div><div id="closed-menu" style="display:none;padding-top:240px"></div></main>
			<script>
				function updateHeaderClearance() {
					const width = innerWidth;
					const padding = width < 768 ? width * 0.12 + 36.97
						: width < 800 ? 242.156
						: 150.02 + width * 0.02;
					document.querySelector('#hero').style.paddingTop = padding + 'px';
				}
				addEventListener('resize', updateHeaderClearance);
				addEventListener('scroll', () => {
					if ( scrollY > 0 ) {
						document.querySelector('#hero').style.paddingTop = (parseFloat(document.querySelector('#hero').style.paddingTop) + 36) + 'px';
					} else updateHeaderClearance();
				});
				updateHeaderClearance();
			</script>
		` );
		await learnAndApplyFluidGeometry( page, {
			widths: [ 390, 600, 767, 768, 769, 799, 800, 801, 1024, 1280, 1440 ],
			settleMs: 40,
		} );

		const rules = await page.locator( 'style[data-dla-fluid-rules]' ).textContent();
		expect( rules ).toContain( 'padding-top' );
		expect( rules ).toContain( '@media' );
		expect( await page.locator( '#hero' ).getAttribute( 'style' ) ).not.toContain( 'padding-top' );
		expect( await page.locator( '#closed-menu' ).getAttribute( 'style' ) ).toContain( 'padding-top:240px' );
		expect( await page.locator( '#closed-menu' ).getAttribute( 'data-dla-fluid-segment' ) ).toBeNull();
		await page.setViewportSize( { width: 768, height: 900 } );
		await page.waitForTimeout( 60 );
		expect( Number.parseFloat( await page.locator( '#hero' ).evaluate( element => getComputedStyle( element ).paddingTop ) ) ).toBeCloseTo( 242.156, 0 );
		await page.close();
	}, 40_000 );
} );
