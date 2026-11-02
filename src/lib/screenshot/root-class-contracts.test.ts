import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { scopeCss } from '../replicate/css-scope.js';
import { projectRootClassContracts, rootClassContracts, sampleRootClasses } from './root-class-contracts.js';

describe( 'root class width contracts', () => {
	it( 'rejects disjoint observations and flags present at the wide capture', () => {
		const sample = ( width: number, body: string[] ) => ( { width, body, html: [] } );
		expect( rootClassContracts( [ sample( 768, [ 'a', 'wide' ] ), sample( 1024, [ 'wide' ] ), sample( 1280, [ 'a', 'wide' ] ), sample( 1440, [ 'wide' ] ) ] ) ).toEqual( [] );
		expect( rootClassContracts( [ sample( 768, [] ), sample( 1024, [ 'middle' ] ), sample( 1280, [] ), sample( 1440, [] ) ] )[ 0 ] ).toMatchObject( { class: 'middle', minWidth: 1024, maxWidth: 1279 } );
	} );

	// One source page, no navigation: about one second of resize settling.
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
			<script>function measure(){document.body.classList.toggle('measured-wrap',innerWidth<1280);document.documentElement.classList.toggle('measured-root',innerWidth<1280)}addEventListener('resize',measure);measure()</script>` );
			const contracts = await sampleRootClasses( page );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( '' );
			expect( contracts ).toEqual( expect.arrayContaining( [ expect.objectContaining( { root: 'body', class: 'measured-wrap', minWidth: 768, maxWidth: 1279 } ) ] ) );
			await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
			const markup = ( await page.content() ).replace( '</head>', '<link rel="stylesheet" href="/theme.css"></head>' );
			const exported = projectRootClassContracts( markup, contracts, href => href === '/theme.css' ? {
				css: '.measured-wrap .label{letter-spacing:3px;background-image:url(./texture.png)}', url: 'https://fixture.test/css/theme.css',
			} : undefined );
			const $ = cheerio.load( exported );
			expect( JSON.parse( $( 'html' ).attr( 'data-blocks-engine-capture-root-class-contracts' )! ) ).toEqual( contracts );
			const css = $( 'style' ).text();
			expect( $( 'link' ) ).toHaveLength( 0 );
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
		} finally { await browser.close(); }
	}, 20_000 );
} );
