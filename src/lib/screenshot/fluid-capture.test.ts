import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

	it( 'learns a responsive top offset only for captured anchor targets', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<span id="features" data-dla-anchor-target="features" data-dla-anchor-source-id="feature-section" style="position:absolute;top:787px;width:0;height:0"></span>
			<div id="ordinary" style="position:absolute;top:144px;width:100px;height:100px"></div>
			<section id="feature-section" style="position:absolute;top:787px"></section>
			<script>
				const update = () => {
					document.querySelector('#feature-section').style.top = (innerWidth * 0.5464) + 'px';
				};
				addEventListener('resize', update);
				update();
			</script>
		` );

		await learnAndApplyFluidGeometry( page, {
			widths: [ 768, 1024, 1280, 1440, 1920 ],
			settleMs: 50,
		} );

		expect( await page.locator( '#features' ).getAttribute( 'style' ) ).toContain( 'top: 54.64vw' );
		expect( await page.locator( '#ordinary' ).getAttribute( 'style' ) ).toContain( 'top:144px' );
		await page.close();
	} );

	it( 'keeps a marker coordinate when its source is sticky chrome', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `
			<header id="source" style="position:sticky;top:0;height:40px">Header</header>
			<span id="target" data-dla-anchor-target="target" data-dla-anchor-source-id="source" style="position:absolute;top:640px;width:0;height:0"></span>
			<div style="height:1800px"></div>
		` );

		await learnAndApplyFluidGeometry( page, { widths: [ 768, 1440 ], settleMs: 20 } );

		expect( await page.locator( '#target' ).getAttribute( 'style' ) ).toContain( 'top:640px' );
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
} );
