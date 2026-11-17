import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { expect, it } from 'vitest';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';
import { captureViewportClassStates, projectViewportClassRules, type ViewportClassMemo } from './viewport-class-states.js';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';
import { observeViewportEntrances } from '../viewport-entrances.js';
import { triggerLazyLoad } from './page-helpers.js';

// A sidebar script pins the menu open at wide widths and draws its toggle open
// with it (the Google Sites pattern); narrower widths show the closed icon.
const source = `<!doctype html><html><head><style>
.bar{display:block;width:20px;height:2px;transform:none}
.open .bar{transform:rotate(45deg)}
@media (min-width:600px){.open .bar{background:red}}
</style></head><body><button><span class="icon"><i class="bar"></i></span></button><script>
const sync=()=>document.querySelector('.icon').setAttribute('class',innerWidth>=1280?'icon open':'icon');
addEventListener('resize',sync);sync();
</script></body></html>`;

it( 'serves script-toggled class state at the widths the source applied it', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeRuntimeStyleWrites );
		await page.setContent( source );
		await markInitialDocument( page );
		const initial = await page.content();
		const result = await captureViewportClassStates( page, { settleMs: 0 } );
		expect( result.aliased ).toBe( 1 );

		// The serialized copy is the pre-sweep document plus what the sweep learned;
		// the source script rewrites classes on later resizes, and the copy runs no script.
		await page.setViewportSize( { width: 1024, height: 900 } );
		await page.setViewportSize( { width: 1440, height: 900 } );
		const copy = projectInitialDocument( initial, await page.content() ).replace( /<script\b[\s\S]*?<\/script>/gi, '' );
		const exported = await browser.newPage();
		await exported.setContent( copy );
		const bar = async ( width: number ) => {
			await exported.setViewportSize( { width, height: 900 } );
			return exported.evaluate( () => {
				const style = getComputedStyle( document.querySelector( '.bar' )! );
				return { open: style.transform !== 'none', red: style.backgroundColor === 'rgb(255, 0, 0)' };
			} );
		};
		expect( await bar( 1440 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1280 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1279 ) ).toEqual( { open: false, red: false } );
		expect( await bar( 1024 ) ).toEqual( { open: false, red: false } );
	} finally {
		await browser.close();
	}
}, 60_000 );

// One browser pass (~3s): scroll proves the entrance before the width sweep.
it( 'excludes entrance pose tokens per element but keeps genuine width tokens', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeViewportEntrances );
		await page.goto( `data:text/html,${ encodeURIComponent( `<!doctype html><style>
			body{margin:0}.hero{height:1200px}@media(max-width:767px){.hero{height:200px}}
			.reveal{width:200px;height:120px;opacity:0;transition:opacity .3s}
			.shown{opacity:1}.spacer{height:1600px}.compact{color:red}
		</style><nav id="nav">Menu</nav><div class="hero"></div>
		<div id="reveal" class="reveal hidden">Reveal</div><div class="spacer"></div><script>
		const reveal=document.getElementById('reveal');
		function update(){
			const r=reveal.getBoundingClientRect();
			if(r.top<innerHeight && r.bottom>0){reveal.classList.add('shown');reveal.classList.remove('hidden');}
			else if(r.top>=innerHeight){reveal.classList.remove('shown');reveal.classList.add('hidden');}
		}
		function width(){
			for(const el of [reveal,document.getElementById('nav')]) el.classList.toggle('compact',innerWidth<768);
			update();
		}
		addEventListener('scroll',update,{passive:true});addEventListener('resize',width);width();
		</script>` ) }` );
		await triggerLazyLoad( page );
		await page.evaluate( () => scrollTo( 0, 0 ) );
		await page.waitForTimeout( 350 );
		const result = await captureViewportClassStates( page, { widths: [ 390, 768, 1440 ], settleMs: 0 } );
		expect( result.aliased ).toBe( 2 );
		const carried = await page.locator( '[data-blocks-engine-capture-width-classes]' ).evaluateAll( elements => elements.map( element => ( {
			id: element.id,
			tokens: ( JSON.parse( element.getAttribute( 'data-blocks-engine-capture-width-classes' )! ) as Array<[string, string, boolean]> ).map( pair => pair[ 0 ] ),
		} ) ) );
		expect( carried ).toEqual( [ { id: 'nav', tokens: [ 'compact' ] }, { id: 'reveal', tokens: [ 'compact' ] } ] );
	} finally {
		await browser.close();
	}
}, 30_000 );

// Two routes (~2s) load the same CSS; only the first has resize-driven dots.
it( 'serializes shared header rules identically when only one route has width-toggled dots', async () => {
	const browser = await chromium.launch();
	const css = '.nav>li.active>a{color:red}.dots>li.active{color:blue}';
	try {
		const headers: string[] = [];
		for ( const dots of [ true, false ] ) {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.route( 'https://fixture.test/shared.css', route => route.fulfill( { contentType: 'text/css', body: css } ) );
			await page.route( 'https://fixture.test/route', route => route.fulfill( { contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="https://fixture.test/shared.css"></head><body>
				<ul class="nav"><li class="active"><a>Shared header</a></li></ul>
				${ dots ? `<ul class="dots"><li>Dot</li></ul><script>
				const sync=()=>document.querySelector('.dots>li').classList.toggle('active',innerWidth>=1280);
				addEventListener('resize',sync);sync();</script>` : '' }</body></html>` } ) );
			await page.goto( 'https://fixture.test/route' );
			await markInitialDocument( page );
			const initial = await page.content();
			const result = await captureViewportClassStates( page, { widths: [ 390, 1440 ], settleMs: 0 } );
			expect( result.aliased ).toBe( dots ? 1 : 0 );
			const portable = projectInitialDocument( initial, await page.content(), () => ( { css, url: 'https://fixture.test/shared.css' } ) );
			// Resolve a still-linked sheet as the serializer would, without
			// confusing a retained link with a missing header rule.
			const serializedCss = portable.includes( '<link' ) ? css : portable.match( /<style[^>]*>([\s\S]*?)<\/style>/ )![ 1 ]!;
			headers.push( serializedCss.match( /\.nav[^{}]*\{[^{}]*\}/ )![ 0 ] );
			expect( serializedCss ).not.toContain( '.nav>li:is(' );
			if ( dots ) expect( serializedCss ).toContain( '.dots>li:is(.active,.data-blocks-engine-capture-width-class-' );
			await page.close();
		}
		expect( headers ).toEqual( [ '.nav>li.active>a{color:red}', '.nav>li.active>a{color:red}' ] );
	} finally {
		await browser.close();
	}
}, 30_000 );

// Controlled timer ticks put the same timer rotator in opposite phases without
// wall-clock races. Returning to the initial width also returns to its phase,
// so checking only the restored class would incorrectly accept both captures.
it( 'does not project timer-rotated classes as width contracts in either phase', async () => {
	const browser = await chromium.launch();
	try {
		const heads: string[] = [];
		const css = '@media(min-width:600px){.rotating{opacity:0}}';
		for ( const active of [ false, true ] ) {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.setContent( `<!doctype html><html><head><link rel="stylesheet" media="all" href="data:text/css,${ encodeURIComponent( css ) }"></head><body>
				<div class="slide${ active ? ' rotating' : '' }">Announcement</div><script>
				window.tick=0;window.rotated=0;
				setInterval(()=>{if(window.rotated<window.tick){
					document.querySelector('.slide').classList.toggle('rotating');window.rotated++;
				}},10);
				</script></body></html>` );
			const resize = page.setViewportSize.bind( page );
			page.setViewportSize = async size => {
				await resize( size );
				await page.evaluate( () => { ( window as unknown as { tick: number } ).tick++; } );
				await page.waitForFunction( () => {
					const state = window as unknown as { tick: number; rotated: number };
					return state.tick === state.rotated;
				} );
			};
			const result = await captureViewportClassStates( page, { widths: [ 1439, 1440 ], settleMs: 0 } );
			const html = projectViewportClassRules( await page.content(), () => ( { css, url: 'https://fixture.test/base.css' } ) );
			expect( result.aliased ).toBe( 0 );
			expect( html ).not.toContain( 'capture-width-class' );
			heads.push( html.match( /<head>[\s\S]*?<\/head>/ )![ 0 ] );
			await page.close();
		}
		expect( heads[ 0 ] ).toBe( heads[ 1 ] );
		expect( heads[ 0 ] ).toContain( '<link' );
	} finally {
		await browser.close();
	}
}, 30_000 );

// One real capture/export (~20s): both sweeps run against a resize-driven runtime.
it( 'keeps learned transforms through the viewport class sweep', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'viewport-class-fluid-' ) );
	let portable: string | undefined;
	const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
	<style>body{margin:0}#frame{width:100px;height:100px}.open{background:red}</style></head>
	<body><main><div id="frame">Moving frame</div></main><script>
	const fit=()=>{
		const frame=document.querySelector('#frame');
		frame.style.transform='translate('+((innerWidth>=1200?innerWidth*.9-96:innerWidth*.96-186))+'px, 0px)';
		frame.className=innerWidth>=1281?'open':'';
		// The class sweep bisects this boundary (the fluid ladder does not).
		// Like a runtime's lazy reveal, the ancestor state remains once reached.
		if(innerWidth===1281)document.querySelector('main').classList.add('revealed');
	};addEventListener('resize',fit);fit();
	</script></body></html>`;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' ? portable : fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const sourceUrl = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch();
	try {
		const capture = await captureScreenshots( {
			urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0,
			deviceMode: 'auto', learnFluid: true,
		} );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const sourcePage = await browser.newPage();
		const copy = await browser.newPage();
		await sourcePage.goto( sourceUrl );
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 1440, 1024, 768 ] ) {
			await sourcePage.setViewportSize( { width, height: 900 } );
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => sourcePage.locator( '#frame' ).evaluate( element => element.getBoundingClientRect().left ) ).toBeCloseTo( width >= 1200 ? width * .9 - 96 : width * .96 - 186, 1 );
			const expected = await sourcePage.locator( '#frame' ).boundingBox();
			const actual = await copy.locator( '#frame' ).boundingBox();
			expect( Math.abs( actual!.x - expected!.x ), `frame left at ${ width }px` ).toBeLessThanOrEqual( 1 );
			expect( await copy.locator( '#frame' ).evaluate( element => getComputedStyle( element ).backgroundColor ) ).toBe( width >= 1281 ? 'rgb(255, 0, 0)' : 'rgba(0, 0, 0, 0)' );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );

// A class-only resize probe should not pay a document-wide quiet window at
// every bisection width. Keep a delayed resize handler and unrelated mutations
// alive so the timing bound cannot be met by sampling before source work runs.
it( 'bounds class probing before fluid learning without losing delayed geometry', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeRuntimeStyleWrites );
		await page.setContent( `<!doctype html><style>.open{color:red}#frame{height:20px}</style>
			<div id="noise"></div><div id="frame">Frame</div><script>
			const sync=()=>{const frame=document.querySelector('#frame');frame.className=innerWidth>=1281?'open':'';frame.style.width=innerWidth*.5+'px'};
			let timer;addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(sync,80)});sync();
			setInterval(()=>document.querySelector('#noise').textContent=String(Date.now()),40);
			</script>` );
		const started = performance.now();
		const classes = await captureViewportClassStates( page, { settleMs: 0 } );
		expect( classes.aliased ).toBe( 1 );
		expect( performance.now() - started ).toBeLessThan( 4_000 );
		const fluid = await learnAndApplyFluidGeometry( page, { settleMs: 0 } );
		expect( fluid.applied ).toBeGreaterThan( 0 );
		const html = ( await page.content() ).replace( /<script\b[\s\S]*?<\/script>/gi, '' );
		const copy = await browser.newPage();
		await copy.setContent( html );
		for ( const width of [ 1440, 1024, 768 ] ) {
			await copy.setViewportSize( { width, height: 900 } );
			expect( ( await copy.locator( '#frame' ).boundingBox() )!.width ).toBeCloseTo( width * .5, 0 );
		}
	} finally {
		await browser.close();
	}
}, 60_000 );

// Three routes have the same nav, but bold current labels shift its overflow widths.
// One browser pass per route; approximately 10 seconds total.
it( 'names shared nav width evidence independently of route-current geometry (#1949)', async () => {
	const browser = await chromium.launch();
	try {
		const headers: string[] = [];
		const contracts: string[] = [];
		for ( const current of [ 0, 1, 2 ] ) {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.setContent( `<style>nav{font:20px serif}li{display:inline-block}a[aria-current]{font-weight:bold}.overflow{visibility:hidden}</style><header><nav><ul>${ [ 'Home', 'Meet the therapist', 'Rates' ].map( ( label, index ) => `<li><a href="/${ index }"${ index === current ? ' aria-current="page"' : '' }>${ label }</a></li>` ).join( '' ) }</ul></nav></header><script>
			const items=[...document.querySelectorAll('li')];
			const total=items.reduce((n,item)=>n+item.getBoundingClientRect().width,0);
			const sync=()=>items.forEach((item,i)=>item.classList.toggle('overflow',innerWidth<500+total+i*40));
			addEventListener('resize',sync);sync();</script>` );
			await markInitialDocument( page );
			const result = await captureViewportClassStates( page, { widths: [ 390, 1440 ], settleMs: 0 } );
			expect( result.aliased ).toBe( 3 );
			const html = projectInitialDocument( await page.content(), await page.content() );
			headers.push( html.match( /<header>[\s\S]*?<\/header>/ )![ 0 ].replace( / aria-current="page"/g, '' ) );
			contracts.push( await page.locator( 'body' ).getAttribute( 'data-blocks-engine-capture-width-class-contracts' ) ?? '' );
			await page.close();
		}
		expect( new Set( contracts ).size ).toBeGreaterThan( 1 ); // Width evidence genuinely differs.
		expect( headers[ 1 ] ).toBe( headers[ 0 ] );
		expect( headers[ 2 ] ).toBe( headers[ 0 ] );
	} finally {
		await browser.close();
	}
}, 60_000 );

// Two routes share a header whose script toggles a class at a width breakpoint.
it.each( [
	{ name: 'reuses a breakpoint proven either side of its flip', second: 768, sampled: [ 390, 767, 768, 1920 ], media: '(max-width:767px)' },
	{ name: 'sweeps when the breakpoint moved inside the range', second: 1000, sampled: null, media: '(max-width:999px)' },
] )( 'shared header class memo $name', async ( { second, sampled, media } ) => {
	const browser = await chromium.launch();
	try {
		const memo: ViewportClassMemo = new Map();
		const route = ( breakpoint: number ) => `<!doctype html><html><head><style>.header{color:black}.header.is-mobile{color:red}</style></head><body><header class="header">Shared</header><script>const sync=()=>document.querySelector('.header').classList.toggle('is-mobile',innerWidth<${ breakpoint });addEventListener('resize',sync);sync()</script></body></html>`;
		let result: Awaited< ReturnType< typeof captureViewportClassStates > > | undefined;
		let css = '';
		for ( const breakpoint of [ 768, second ] ) {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.addInitScript( observeRuntimeStyleWrites );
			await page.setContent( route( breakpoint ) );
			await markInitialDocument( page );
			result = await captureViewportClassStates( page, { settleMs: 0, memo } );
			css = projectInitialDocument( await page.content(), await page.content() );
			await page.close();
		}
		if ( sampled ) expect( [ ...result!.sampledWidths ].sort( ( a, b ) => a - b ) ).toEqual( sampled );
		else expect( result!.sampledWidths.length ).toBeGreaterThan( 4 );
		expect( result!.aliased ).toBe( 1 );
		expect( css ).toContain( media );
	} finally {
		await browser.close();
	}
}, 60_000 );
