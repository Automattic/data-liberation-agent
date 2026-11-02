import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { assembleResponsiveCapture } from '../responsive-assembly.js';
import { scopeCss } from '../replicate/css-scope.js';
import { projectRootClassContracts, rootClassContracts, sampleRootClasses } from './root-class-contracts.js';

describe( 'root class width contracts', () => {
	it( 'rejects disjoint observations and flags present at the wide capture', () => {
		const sample = ( width: number, body: string[] ) => ( { width, body, html: [] } );
		expect( rootClassContracts( [ sample( 768, [ 'a', 'wide' ] ), sample( 1024, [ 'wide' ] ), sample( 1280, [ 'a', 'wide' ] ), sample( 1440, [ 'wide' ] ) ] ) ).toEqual( [] );
		expect( rootClassContracts( [ sample( 768, [] ), sample( 1024, [ 'middle' ] ), sample( 1280, [] ), sample( 1440, [] ) ] )[ 0 ] ).toMatchObject( { class: 'middle', minWidth: 1024, maxWidth: 1279 } );
	} );

	it( 'keeps linked sheets shared and emits only contextual width-gated aliases after them', () => {
		const contracts = rootClassContracts( [
			{ width: 768, html: [], body: [ 'c' ] },
			{ width: 1280, html: [], body: [] },
			{ width: 1440, html: [], body: [] },
		] );
		const link = '<link rel="stylesheet" href="https://fixture.test/css/theme.css" media="screen">';
		const desktop = `<html><head>${ link }</head><body><main class="x">Desktop</main></body></html>`;
		const mobile = `<html><head>${ link }</head><body><nav>Phone menu</nav><main>Mobile</main></body></html>`;
		const projected = projectRootClassContracts( desktop, contracts, () => ( {
			css: '.unrelated{color:red}@media (max-width:1279px){.c .x{background:url(./texture.png)}}',
			url: 'https://fixture.test/css/theme.css',
		} ) );
		const $ = cheerio.load( projected );
		expect( $( 'link' ).toString() ).toBe( link );
		expect( $( 'style' ) ).toHaveLength( 1 );
		expect( $( 'link' ).next().is( 'style' ) ).toBe( true );
		expect( $( 'style' ).attr( 'media' ) ).toBe( 'screen' );
		const css = postcss.parse( $( 'style' ).text() );
		expect( css.nodes ).toHaveLength( 1 );
		expect( css.first ).toMatchObject( { type: 'atrule', name: 'media', params: '(max-width:1279px)' } );
		expect( $( 'style' ).text() ).toBe( '@media (max-width:1279px){@media (min-width:768px) and (max-width:1279px){body:is(*,.c) .x{background:url("https://fixture.test/css/texture.png")}}}' );
		expect( $( 'html' ).attr( 'data-blocks-engine-capture-root-class-contracts' ) ).toBe( JSON.stringify( contracts ) );
		const assembled = assembleResponsiveCapture( {
			rawDesktopHtml: projected, rawMobileHtml: mobile,
			portableDesktopHtml: projected, portableMobileHtml: mobile,
		} );
		expect( assembled.hasMobileDocument ).toBe( true );
		const result = cheerio.load( assembled.html );
		expect( result( 'link[rel="stylesheet"]' ) ).toHaveLength( 1 );
		expect( result( 'link' ).toString() ).toBe( link );
		expect( assembled.html ).not.toContain( '@import' );
		expect( assembled.html ).not.toContain( '.unrelated' );
	} );

	// Local browser fixture: about five seconds, no network or platform knowledge.
	it( 'proves width contracts through recurring main-thread long tasks', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.setContent( `<div>Local width contract fixture</div><script>
				function measure(){document.body.classList.toggle('measured-wrap',innerWidth<1280)}
				addEventListener('resize',measure);measure();
				setInterval(()=>{const end=performance.now()+200;while(performance.now()<end){}},240);
			</script>` );
			const unproven: string[] = [];
			expect( await sampleRootClasses( page, undefined, reason => unproven.push( reason ) ) ).toEqual( [ {
				root: 'body', class: 'measured-wrap', minWidth: 768, maxWidth: 1279,
				evidence: [
					{ width: 768, html: [], body: [ 'measured-wrap' ] },
					{ width: 1024, html: [], body: [ 'measured-wrap' ] },
					{ width: 1280, html: [], body: [] },
					{ width: 1440, html: [], body: [] },
				],
			} ] );
			expect( unproven ).toEqual( [] );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( '' );
		} finally { await browser.close(); }
	}, 15_000 );

	// One browser pass: about ten seconds including unstable-width coverage.
	it( 'exports measurement-gated author CSS that survives responsive document scoping', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.setContent( `<style>
				.layout{display:flex;flex-direction:row}
				@supports(display:flex){body.measured-wrap .layout{flex-direction:column}}
				.measured-wrap .label{color:rgb(1,2,3)}
				html.measured-root .label{font-weight:700}
				.descendant.measured-wrap{padding:17px}
			</style><div class="layout"><span class="label">Neutral fixture</span></div>
			<script>let timer;function measure(){document.body.classList.toggle('measured-wrap',innerWidth<1280);document.documentElement.classList.toggle('measured-root',innerWidth<1280)}addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(measure,300)});measure()</script>` );
			const contracts = await sampleRootClasses( page );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( '' );
			expect( contracts ).toEqual( expect.arrayContaining( [ expect.objectContaining( { root: 'body', class: 'measured-wrap', minWidth: 768, maxWidth: 1279,
				evidence: [
					{ width: 768, html: [ 'measured-root' ], body: [ 'measured-wrap' ] },
					{ width: 1024, html: [ 'measured-root' ], body: [ 'measured-wrap' ] },
					{ width: 1280, html: [], body: [] },
					{ width: 1440, html: [], body: [] },
				],
			} ) ] ) );
			// Restoration must also wait for a debounce, not merely set the viewport.
			await page.setViewportSize( { width: 1024, height: 900 } );
			await page.waitForTimeout( 600 );
			await sampleRootClasses( page, [ 768 ] );
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( 'measured-wrap' );
			await page.setViewportSize( { width: 1440, height: 900 } );
			await page.waitForTimeout( 600 );
			await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
			const markup = ( await page.content() ).replace( '</head>', '<link rel="stylesheet" href="/theme.css"></head>' );
			const exported = projectRootClassContracts( markup, contracts, href => href === '/theme.css' ? {
				css: '.measured-wrap .label{letter-spacing:3px;background-image:url(./texture.png)}', url: 'https://fixture.test/css/theme.css',
			} : undefined );
			const $ = cheerio.load( exported );
			expect( JSON.parse( $( 'html' ).attr( 'data-blocks-engine-capture-root-class-contracts' )! ) ).toEqual( contracts );
			const css = $( 'style' ).text();
			expect( $( 'link' ) ).toHaveLength( 1 );
			expect( css ).toContain( 'https://fixture.test/css/texture.png' );
			expect( css ).not.toContain( ':is(*,.measured-wrap){padding' );
			for ( const scoped of [ false, true ] ) {
				await page.setContent( scoped ? `<style>${ scopeCss( css, { scope: '#desktop' } ) }</style><div id="desktop">${ $( 'body' ).html() }</div>` : exported );
				for ( const width of [ 768, 1024, 1440 ] ) {
					await page.setViewportSize( { width, height: 900 } );
					expect( await page.locator( '.layout' ).evaluate( node => getComputedStyle( node ).flexDirection ) ).toBe( width < 1280 ? 'column' : 'row' );
					expect( await page.locator( '.label' ).evaluate( node => getComputedStyle( node ).fontWeight ) ).toBe( width < 1280 ? '700' : '400' );
					expect( await page.locator( '.label' ).evaluate( node => getComputedStyle( node ).letterSpacing ) ).toBe( width < 1280 ? '3px' : 'normal' );
				}
			}
			// One unstable width cannot be skipped to infer a range over the gap.
			await page.setContent( `<script>
				setInterval(()=>{if(innerWidth===1024)document.body.classList.toggle('noisy')},80);
				addEventListener('resize',()=>document.body.classList.toggle('measured',innerWidth<1280));
			</script>` );
			const unproven: string[] = [];
			expect( await sampleRootClasses( page, undefined, reason => unproven.push( reason ) ) ).toEqual( [] );
			expect( unproven ).toEqual( [ expect.stringContaining( 'unproven at 1024px' ) ] );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
		} finally { await browser.close(); }
	}, 20_000 );
} );
