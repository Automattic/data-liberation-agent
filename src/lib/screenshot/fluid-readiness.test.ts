import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { COARSE_SWEEP_WIDTHS, DEFAULT_SWEEP_WIDTHS, learnAndApplyFluidGeometry } from './fluid-capture.js';
import { waitForImages } from './page-helpers.js';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';

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
			expect( await page.locator( '[data-blocks-engine-capture-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 20_000 );

	it.each( [ 'source', 'node' ] )( 'revisits a pending native-lazy image after a delayed %s replacement', async replacement => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 500 } } );
		try {
			await page.route( 'https://neutral.test/replacement.svg', async route => {
				await new Promise( resolve => setTimeout( resolve, 1500 ) );
				await route.fulfill( { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' } );
			} );
			await page.setContent( `<style>body{margin:0}</style>
				<div id="box" style="width:720px;height:40px">Neutral text</div>
				<div style="height:3500px"></div>
				<img id="image" loading="lazy" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E">
				<script>
				window.positions = [];
				const scroll = window.scrollTo.bind(window);
				window.scrollTo = options => { if (options.top > 0) positions.push(options.top); scroll(options); };
				addEventListener('resize', () => {
					document.querySelector('#box').style.width = innerWidth / 2 + 'px';
					if (innerWidth !== 768) return;
					setTimeout(() => {
						const image = document.querySelector('#image');
						${ replacement === 'node' ? "const next = image.cloneNode(); next.src = 'https://neutral.test/replacement.svg'; image.replaceWith(next);" : "image.src = 'https://neutral.test/replacement.svg';" }
					}, 100);
				});
				</script>` );
			await learnAndApplyFluidGeometry( page, {
				widths: [ 768 ], settleMs: 1200,
				prepareViewport: async source => {
					const observed = await source.evaluate( () => ({
						positions: (window as unknown as {positions: number[]}).positions,
						height: document.documentElement.scrollHeight,
						viewport: innerHeight,
						ready: [...document.images].every(image => image.complete && image.naturalWidth === 40),
						top: scrollY,
					}) );
					expect( observed.ready ).toBe( true );
					expect( observed.top ).toBe( 0 );
					expect( observed.positions.length ).toBeGreaterThanOrEqual( 2 * (Math.ceil( observed.height / observed.viewport ) - 1) );
				},
			} );
			expect( await page.locator( '#image' ).getAttribute( 'src' ) ).toBe( 'https://neutral.test/replacement.svg' );
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
			const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 200 } );
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
			// The 450ms resize callback and delayed image complete inside this budget.
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 700 } );
			console.info( JSON.stringify( { fixture: 'finite-lazy', elapsedMs: Math.round( performance.now() - start ) } ) );
			expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 700 } );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
			expect( await page.locator( '#box' ).evaluate( element => getComputedStyle( element ).paddingTop ) ).toBe( '20px' );
			expect( await page.locator( '#lazy img' ).evaluate( image => ( image as HTMLImageElement ).complete ) ).toBe( true );
			expect( await page.locator( '#lazy img' ).evaluate( image => ( image as HTMLImageElement ).naturalWidth ) ).toBe( 40 );
			expect( await page.locator( '[data-blocks-engine-capture-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'does not repeat a completed sweep solely because an existing image finished changing rendition', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 500 } } );
		try {
			await page.setContent( `<style>body{margin:0}</style>
				<div id="box" style="width:720px;height:40px">Neutral text <a href="#tail">Tail</a></div>
				<img id="image" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E">
				<div id="tail" style="height:3500px"></div>
				<script>
				window.positions = [];
				const scroll = window.scrollTo.bind(window);
				window.scrollTo = options => { if (options.top > 0) positions.push(options.top); scroll(options); };
				addEventListener('resize', () => {
					document.querySelector('#box').style.width = innerWidth / 2 + 'px';
					setTimeout(() => { document.querySelector('#image').src += '#loaded-' + innerWidth; }, 100);
				});
				</script>` );
			await waitForImages( page );
			await learnAndApplyFluidGeometry( page, {
				widths: [ 768 ], settleMs: 1200,
				prepareViewport: async source => {
					const observed = await source.evaluate( () => ({
						positions: (window as unknown as {positions: number[]}).positions,
						height: document.documentElement.scrollHeight,
						viewport: innerHeight,
						ready: [...document.images].every(image => image.complete && image.naturalWidth > 0),
						top: scrollY,
					}) );
					expect( observed.ready ).toBe( true );
					expect( observed.top ).toBe( 0 );
					// Every viewport is still visited; a completed rendition is not a
					// newly unreachable lazy target requiring the same visits twice.
					expect( observed.positions ).toEqual( Array.from(
						{ length: Math.ceil( observed.height / observed.viewport ) - 1 },
						(_, index) => (index + 1) * observed.viewport,
					) );
				},
			} );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
			expect( await page.locator( 'a' ).getAttribute( 'href' ) ).toBe( '#tail' );
		} finally { await page.close(); }
	}, 20_000 );

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
			// The 600ms transform write must settle before the restored matrix is checked.
			await learnAndApplyFluidGeometry( page, { widths: [ 390, 768 ], settleMs: 700 } );
			expect( await page.locator( '#box' ).evaluate( element => getComputedStyle( element ).transform ) ).toBe( 'matrix(2, 0, 0, 2, 144, 0)' );
			expect( await page.locator( '#box' ).getAttribute( 'data-blocks-engine-capture-fluid-id' ) ).toBeNull();
		} finally { await page.close(); }
	}, 20_000 );
	const railFixture = ( reachableDelayMs: number | null ) => `<style>body{margin:0}.rail{display:flex;overflow-x:scroll;overflow-y:hidden;width:100%}.rail img{flex:none;width:100px;height:100px}</style>
		<div id="box" style="width:720px;height:40px">Neutral text</div>
		${ reachableDelayMs === null ? '' : '<img id="reachable" loading="lazy" width="40" height="40" src="https://neutral.test/slow.svg">' }
		<ul class="rail">${ Array.from( { length: 40 }, ( _, index ) => `<li><img loading="lazy" src="https://neutral.test/rail-${ index }.svg"></li>` ).join( '' ) }</ul>
		<script>
		const box = document.querySelector('#box');
		function resize() { box.style.width = innerWidth / 2 + 'px'; }
		addEventListener('resize', resize); resize();
		</script>`;
	const routeImages = async ( page: import( 'playwright' ).Page, slowMs: number ) => {
		await page.route( 'https://neutral.test/*.svg', async route => {
			if ( route.request().url().endsWith( '/slow.svg' ) ) await new Promise( resolve => setTimeout( resolve, slowMs ) );
			await route.fulfill( { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' } );
		} );
	};

	it( 'does not wait for native-lazy images clipped out of view by an overflow rail', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await routeImages( page, 0 );
			await page.setContent( railFixture( null ) );
			const pending = await page.evaluate( () => [ ...document.images ].filter( image => ! image.complete ).length );
			expect( pending ).toBeGreaterThan( 0 );
			const start = performance.now();
			const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 1200 } );
			const sweepMs = performance.now() - start;
			const imageStart = performance.now();
			await waitForImages( page );
			const imageMs = performance.now() - imageStart;
			console.info( JSON.stringify( { fixture: 'clipped-lazy-rail', sweepMs: Math.round( sweepMs ), imageMs: Math.round( imageMs ), pending, result } ) );
			expect( result.applied ).toBeGreaterThan( 0 );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
			// Three widths at rest take ~1.25s each; the old deadline was settleMs + 3.5s per width.
			expect( sweepMs ).toBeLessThan( 7000 );
			expect( imageMs ).toBeLessThan( 1000 );
			expect( await page.evaluate( () => [ ...document.images ].filter( image => ! image.complete ).length ) ).toBeGreaterThan( 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'still waits for a reachable pending native-lazy image', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await routeImages( page, 1500 );
			await page.setContent( railFixture( 1500 ) );
			const start = performance.now();
			await waitForImages( page );
			expect( performance.now() - start ).toBeGreaterThan( 1000 );
			expect( await page.locator( '#reachable' ).evaluate( image => ( image as HTMLImageElement ).complete ) ).toBe( true );
		} finally { await page.close(); }
	}, 30_000 );
	it( 'does not resweep for a perpetual rotator that toggles already-loaded images within the swept extent', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.route( 'https://neutral.test/*.svg', route => route.fulfill( { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' } ) );
			await page.setContent( `<style>body{margin:0}.slot img{width:40px;height:40px}</style>
				<div id="box" style="width:720px;height:40px">Neutral text</div><div style="height:2400px"></div>
				<div style="height:200px;overflow:hidden"><div class="slot">${ Array.from( { length: 12 }, ( _, index ) => `<img src="https://neutral.test/a${ index }.svg">` ).join( '' ) }</div><ul id="log"></ul></div>
				<script>
				const box = document.querySelector('#box');
				function resize() { box.style.width = innerWidth / 2 + 'px'; }
				addEventListener('resize', resize); resize();
				const images = [ ...document.querySelectorAll('.slot img') ];
				let tick = 0;
				setInterval(() => {
					tick++;
					images.forEach((image, index) => { image.style.display = (index + tick) % 3 ? '' : 'none'; });
					document.querySelector('#log').append(document.createElement('li'));
				}, 200);
				</script>` );
			await page.waitForFunction( () => [ ...document.images ].every( image => image.complete ) );
			const start = performance.now();
			const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 768, 1440 ], settleMs: 800 } );
			const elapsed = performance.now() - start;
			console.info( JSON.stringify( { fixture: 'perpetual-rotator', elapsedMs: Math.round( elapsed ), result } ) );
			expect( result.applied ).toBeGreaterThan( 0 );
			// Each width rests in ~1.3 s; a resweep every rotation spends the 4.3 s deadline.
			expect( elapsed ).toBeLessThan( 9_000 );
		} finally { await page.close(); }
	}, 40_000 );
	const writer = ( rule: string ) => `<style>body{margin:0}</style><div id="box" style="width:720px;height:40px">Neutral text</div>
		<script>const box = document.querySelector('#box'); function resize() { box.style.width = (${ rule }) + 'px'; } addEventListener('resize', resize); resize();</script>`;

	it( 'samples only the coarse widths when every series is one line across them', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( writer( 'innerWidth / 2' ) );
			const widths: number[] = [];
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 0, onProgress: width => widths.push( width ) } );
			expect( widths ).toEqual( [ 390, 768, 1920, 600, 1024, 1440 ] );
			expect( result.sampledWidths ).toEqual( COARSE_SWEEP_WIDTHS );
			expect( result.applied ).toBeGreaterThan( 0 );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
		} finally { await page.close(); }
	}, 60_000 );

	it( 'stops after the probe widths when script-written geometry is the same at each', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( writer( '640' ) );
			const widths: number[] = [];
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 0, onProgress: width => widths.push( width ) } );
			expect( widths ).toEqual( [ 390, 768, 1920 ] );
			expect( result.sampledWidths ).toEqual( [ 390, 768, 1920 ] );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 640, 0 );
		} finally { await page.close(); }
	}, 60_000 );

	it( 'bisects toward a switch inside the tablet band and learns it at the full ladder\'s width', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( writer( 'innerWidth >= 783 ? 600 : 300' ) );
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 0 } );
			// 801 bisects 768–1024, 783 bisects 768–801, 775 bisects 768–783;
			// 775–783 holds no ladder width, so the switch is located exactly.
			expect( result.sampledWidths ).toEqual( [ 390, 600, 768, 775, 783, 801, 1024, 1440, 1920 ] );
			expect( result.breakpoints ).toContain( 783 );
		} finally { await page.close(); }
	}, 60_000 );

	it( 'samples the exact widths it is given', async () => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.setContent( writer( 'innerWidth >= 783 ? 600 : 300' ) );
			const widths: number[] = [];
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 0, widths: [ 1440, 390, 1024 ], onProgress: width => widths.push( width ) } );
			expect( widths ).toEqual( [ 1440, 390, 1024 ] );
			expect( result.sampledWidths ).toEqual( [ 390, 1024, 1440 ] );
		} finally { await page.close(); }
	}, 60_000 );

	// One box per rule shape, each with its own parent, learned in one page so a
	// single full and a single adaptive sweep cover every kind. Refinement is
	// global, so this also proves one shape's samples do not disturb another's.
	const shapes = [
		[ 'smooth', 'innerWidth / 2', '' ],
		[ 'mobile switch at 768', 'innerWidth < 768 ? innerWidth - 20 : innerWidth / 2', '' ],
		[ 'tablet-only regime', 'innerWidth >= 768 && innerWidth <= 800 ? 500 : innerWidth / 2', '' ],
		[ 'segmented affine past a desktop switch', 'innerWidth < 992 ? innerWidth * 0.9 : innerWidth * 0.5 + 40', '' ],
		[ 'clamped outside the band', 'Math.min( 600, innerWidth * 0.6 )', '' ],
		[ 'capped on the desktop', 'Math.min( 900, innerWidth * 0.75 )', '' ],
		[ 'container with its own breakpoint', 'parent.clientWidth / 2', 'width:90vw' ],
		[ 'no relationship', 'Math.round( 400000 / innerWidth )', '' ],
	] as const;
	const shapesSource = `<style>body{margin:0}@media (min-width:1100px){#parent-6{width:1000px!important}}</style>
		${ shapes.map( ( [ , , parent ], index ) => `<div id="parent-${ index }" style="${ parent }"><div id="box-${ index }" style="width:720px;height:40px">Neutral text</div></div>` ).join( '' ) }
		<script>
		const rules = [ ${ shapes.map( ( [ , rule ] ) => `parent => ${ rule }` ).join( ', ' ) } ];
		function resize() { rules.forEach( ( rule, index ) => { document.querySelector( '#box-' + index ).style.width = rule( document.querySelector( '#parent-' + index ) ) + 'px'; } ); }
		addEventListener( 'resize', resize ); resize();
		</script>`;

	it( 'learns the same copy from the adaptive and full ladders', async () => {
		const copyGeometry = async ( widths?: number[] ) => {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			try {
				await page.setContent( shapesSource );
				const result = await learnAndApplyFluidGeometry( page, { settleMs: 0, ...( widths ? { widths } : {} ) } );
				await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
				await copy.setContent( await page.content() );
				const geometry: Record< string, number[] > = {};
				// Widths neither ladder samples, across every regime.
				for ( const width of [ 500, 700, 772, 786, 795, 900, 1100, 1300, 1700 ] ) {
					await copy.setViewportSize( { width, height: 900 } );
					const boxes = await copy.locator( '[id^=box-]' ).evaluateAll( nodes => nodes.map( node => Math.round( node.getBoundingClientRect().width ) ) );
					boxes.forEach( ( box, index ) => ( geometry[ shapes[ index ]![ 0 ] ] ??= [] ).push( box ) );
				}
				return { result, geometry, css: await copy.locator( 'style[data-blocks-engine-capture-fluid-rules]' ).allTextContents() };
			} finally { await page.close(); await copy.close(); }
		};
		const full = await copyGeometry( DEFAULT_SWEEP_WIDTHS );
		const adaptive = await copyGeometry();
		// Every rule kind the issue names is learned by the full ladder.
		for ( const kind of [ 'segmented', 'capped', 'container', 'breakpoint' ] ) expect( full.result.byKind[ kind ], kind ).toBeGreaterThan( 0 );
		expect( adaptive.result.byKind ).toEqual( full.result.byKind );
		expect( adaptive.css ).toEqual( full.css );
		expect( adaptive.geometry ).toEqual( full.geometry );
		// One page sweeps for every shape's evidence at once, so only 769 is
		// interpolated here; each shape's own cost is pinned without a browser in
		// fluid-capture.test.ts.
		expect( adaptive.result.sampledWidths ).toEqual( DEFAULT_SWEEP_WIDTHS.filter( width => width !== 769 ) );
	}, 120_000 );

	// A breakpoint-owned subtree is remounted whenever the viewport crosses its
	// media query, so the copy at the capture width is a fresh one. Its text
	// reveal starts once the text intersects the viewport and then runs a
	// timed, script-driven gradient: transparent until the solid stop has grown
	// to 100%. The capture already scrolled it into view before width learning.
	const revealSource = ( box: string ) => `<style>body{margin:0}</style>
		<div id="box" style="width:720px;height:40px">Neutral text</div>
		<div style="height:2400px"></div><p id="slot"></p><div style="height:600px"></div>
		<script>
		const box = document.querySelector('#box');
		${ box }
		const slot = document.querySelector('#slot');
		const gradient = progress => 'linear-gradient(90deg, rgb(200, 160, 80) ' + progress + '%, rgba(0, 0, 0, 0) ' + progress + '%)';
		window.mounts = 0;
		function mount() {
			window.mounts++;
			const text = document.createElement('span');
			text.id = 'reveal';
			text.textContent = 'Neutral reveal';
			text.style.cssText = 'display:inline-block;color:transparent;background-clip:text;-webkit-background-clip:text';
			text.style.backgroundImage = gradient(0);
			slot.replaceChildren(text);
			const observer = new IntersectionObserver(entries => {
				if (!entries.some(entry => entry.isIntersecting)) return;
				observer.disconnect();
				const start = performance.now();
				const frame = now => {
					const progress = Math.min(100, Math.round((now - start) / 15));
					text.style.backgroundImage = gradient(progress);
					if (progress < 100) requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
			}, { threshold: 0.1 });
			observer.observe(text);
		}
		mount();
		matchMedia('(min-width: 1000px)').addEventListener('change', mount);
		</script>`;
	const revealed = 'linear-gradient(90deg, rgb(200, 160, 80) 100%, rgba(0, 0, 0, 0) 100%)';

	it.each< [ string, string, { widths?: number[] } ] >( [
		[ 'learned', "function resize() { box.style.width = innerWidth / 2 + 'px'; } addEventListener('resize', resize); resize();", { widths: [ 1440, 768 ] } ],
		[ 'constant', "addEventListener('resize', () => {});", {} ],
	] )( 'leaves a text reveal remounted by the return to the capture width revealed (%s geometry)', async ( _, box, options ) => {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await page.addInitScript( observeRuntimeStyleWrites );
			await page.route( 'https://reveal.test/**', route => route.fulfill( { contentType: 'text/html', body: `<!doctype html><html><body>${ revealSource( box ) }</body></html>` } ) );
			await page.goto( 'https://reveal.test/' );
			const reveal = page.locator( '#reveal' );
			await reveal.scrollIntoViewIfNeeded();
			await page.waitForFunction( value => document.querySelector< HTMLElement >( '#reveal' )!.style.backgroundImage === value, revealed );
			await page.evaluate( () => window.scrollTo( { top: 0, left: 0, behavior: 'instant' } ) );
			await learnAndApplyFluidGeometry( page, { settleMs: 0, ...options } );
			// Crossing the breakpoint replaced the copy the capture had revealed.
			expect( await page.evaluate( () => ( window as unknown as { mounts: number } ).mounts ) ).toBeGreaterThan( 1 );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.evaluate( () => window.scrollY ) ).toBe( 0 );
			expect( await reveal.evaluate( element => ( element as HTMLElement ).style.backgroundImage ) ).toBe( revealed );
		} finally { await page.close(); }
	}, 60_000 );
} );
