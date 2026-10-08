import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

describe( 'responsive readiness contract', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch( { headless: true } ); } );
	afterAll( async () => { await browser.close(); } );

	it( 'observes opt-in relative slide offsets before source preparation and sampling', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<style>body { margin: 0; }</style><div id="slide" style="position:relative;left:144px">Slide text</div>
				<script>
				const slide = document.querySelector('#slide');
				let timer;
				addEventListener('resize', () => {
					clearInterval(timer);
					let tick = 0;
					timer = setInterval(() => {
						slide.style.left = ++tick < 8 ? tick + 'px' : innerWidth / 10 + 'px';
						if (tick === 8) clearInterval(timer);
					}, 150);
				});
				</script>` );
			const prepared: number[] = [];
			await learnAndApplyFluidGeometry( page, {
				widths: [ 390, 768, 1440 ], settleMs: 0, learnRelativeOffsets: true,
				prepareViewport: async source => {
					const width = source.viewportSize()!.width;
					expect( await source.locator( '#slide' ).evaluate( element => Number.parseFloat( ( element as HTMLElement ).style.left ) ) ).toBe( width / 10 );
					prepared.push( width );
				},
			} );
			expect( prepared ).toEqual( [ 390, 768, 1440 ] );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.locator( '#slide' ).evaluate( element => element.getBoundingClientRect().x ) ).toBeCloseTo( 144, 0 );
			expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 20_000 );

	it( 'ignores perpetual paint-only writes without spending the rest deadline', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<div id="box" style="width:720px;height:40px">Neutral text</div>
				<div hidden><img loading="lazy" src="https://neutral.test/hidden.svg"></div>
				<script>
				const box = document.querySelector('#box');
				function resize() { box.style.width = innerWidth / 2 + 'px'; }
				addEventListener('resize', resize); resize();
				let tick = 0;
				setInterval(() => { box.style.color = ++tick % 2 ? 'red' : 'blue'; box.style.setProperty('--paint', String(tick)); }, 80);
				</script>` );
			const start = performance.now();
			const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 1200 } );
			const elapsed = performance.now() - start;
			console.info( JSON.stringify( { fixture: 'paint-only', elapsedMs: Math.round( elapsed ), result } ) );
			expect( result.applied ).toBeGreaterThan( 0 );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
			expect( elapsed ).toBeLessThan( 7000 );
			expect( await page.locator( 'img' ).evaluate( image => ( image as HTMLImageElement ).complete ) ).toBe( false );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'retains delayed resize-created lazy content and delayed top-of-page geometry', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 700 } } );
		try {
			await page.route( 'https://neutral.test/*.svg', async route => {
				await new Promise( resolve => setTimeout( resolve, 500 ) );
				await route.fulfill( { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' } );
			} );
			await page.setContent( `<div id="box" style="width:720px;padding-top:20px">Neutral text</div>
				<div style="height:1800px"></div><div id="lazy"></div>
				<script>
				const box = document.querySelector('#box');
				let timer;
				addEventListener('resize', () => {
					clearTimeout(timer);
					timer = setTimeout(() => {
						box.style.width = innerWidth / 2 + 'px';
						if (innerWidth !== 1440) document.querySelector('#lazy').innerHTML = '<img loading="lazy" width="40" height="40" src="https://neutral.test/' + innerWidth + '.svg">';
					}, 450);
				});
				addEventListener('scroll', () => {
					const top = scrollY === 0;
					setTimeout(() => { box.style.paddingTop = top ? '20px' : '80px'; }, 400);
				});
				</script>` );
			const start = performance.now();
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 1200 } );
			console.info( JSON.stringify( { fixture: 'finite-lazy', elapsedMs: Math.round( performance.now() - start ) } ) );
			expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 700 } );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
			expect( await page.locator( '#box' ).evaluate( element => getComputedStyle( element ).paddingTop ) ).toBe( '20px' );
			expect( await page.locator( '#lazy img' ).evaluate( image => ( image as HTMLImageElement ).complete ) ).toBe( true );
			expect( await page.locator( '#lazy img' ).evaluate( image => ( image as HTMLImageElement ).naturalWidth ) ).toBe( 40 );
			expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'waits for genuine delayed transform changes and validates the restored matrix', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( `<div id="box" style="width:100px;transform:matrix(1,0,0,1,144,0)">Transform text</div>
				<script>
				const box = document.querySelector('#box');
				let timer;
				addEventListener('resize', () => {
					clearTimeout(timer);
					timer = setTimeout(() => {
						box.style.transform = innerWidth === 1440
							? 'matrix(2,0,0,2,144,0)'
							: 'matrix(1,0,0,1,' + innerWidth / 10 + ',0)';
					}, 600);
				});
				</script>` );
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768 ], settleMs: 1200 } );
			expect( await page.locator( '#box' ).evaluate( element => getComputedStyle( element ).transform ) ).toBe( 'matrix(2, 0, 0, 2, 144, 0)' );
			expect( await page.locator( '#box' ).getAttribute( 'data-dla-fluid-id' ) ).toBeNull();
		} finally { await page.close(); }
	}, 20_000 );
} );
