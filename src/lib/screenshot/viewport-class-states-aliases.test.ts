import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { aliasRules, projectViewportClassRules } from './viewport-class-states.js';

const fixture = readFileSync( new URL( './fixtures/alias-fixture.html', import.meta.url ), 'utf8' );

// One browser pass (~1s): projection, not another capture pipeline run.
it( 'projects ten wearers of one token without multiplying their states', async () => {
	const $ = cheerio.load( fixture );
	const contracts = $( '[data-bp]' ).toArray().map( ( element, index ) => {
		const alias = `width-${ index }`;
		$( element ).attr( 'class', alias );
		return { token: 'tok', alias, media: `(min-width:${ $( element ).attr( 'data-bp' ) }px)` };
	} );
	$( 'script' ).remove();
	$( 'body' ).attr( 'data-blocks-engine-capture-width-class-contracts', JSON.stringify( contracts ) );
	const projected = projectViewportClassRules( $.html() );
	const css = cheerio.load( projected )( 'style' ).text();
	// Trunk emits 165,910 bytes with these short aliases (391,190 after capture).
	expect( Buffer.byteLength( css ) ).toBeLessThan( contracts.length * 500 );
	expect( ( css.match( /@media/g ) ?? [] ).length ).toBeLessThanOrEqual( contracts.length * 2 );
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( projected );
		for ( const width of [ 390, 400, 650, 999, 1000, 1300, 1440 ] ) {
			await page.setViewportSize( { width, height: 900 } );
			const actual = await page.locator( '[data-bp]' ).evaluateAll( elements => elements.map( element => ( {
				breakpoint: Number( element.getAttribute( 'data-bp' ) ),
				color: getComputedStyle( element ).color,
				weight: getComputedStyle( element ).fontWeight,
			} ) ) );
			for ( const item of actual ) {
				expect( item.color, `${ item.breakpoint } at ${ width }` ).toBe( width >= item.breakpoint ? 'rgb(170, 0, 0)' : 'rgb(0, 0, 0)' );
				expect( item.weight ).toBe( width >= item.breakpoint ? '700' : '400' );
			}
		}
	} finally {
		await browser.close();
	}
} );

it( 'omits impossible intersections of different token states and enclosing media', () => {
	const rules = aliasRules( [ '@media (max-width:700px){.x.y{color:red}}' ], [
		{ token: 'x', alias: 'a', media: '(min-width:900px)' },
		{ token: 'y', alias: 'b', media: '(max-width:500px)' },
	] ).join( '' );
	expect( rules ).not.toContain( '@media (min-width:900px)' );
	expect( rules ).toContain( ':is(.y,.b)' );
} );

it( 'scopes negation to each wearer and composes different toggled tokens', async () => {
	const contracts = [
		{ token: 'tok', alias: 'a', media: '(min-width:500px)' },
		{ token: 'tok', alias: 'b', media: '(min-width:900px)' },
		{ token: 'other', alias: 'c', media: '(max-width:700px)' },
	];
	const html = `<style>.item:not(.tok){color:red}.item.tok{color:blue}.item.tok.other{font-weight:700}.tok > .tok{background:red}</style><body data-blocks-engine-capture-width-class-contracts='${ JSON.stringify( contracts ) }'><div class="item a c"><span class="b child"></span></div><div class="item b c"></div><div class="item"></div><div class="item tok other"></div></body>`;
	const projected = projectViewportClassRules( html );
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( projected );
		for ( const width of [ 390, 500, 700, 701, 900 ] ) {
			await page.setViewportSize( { width, height: 900 } );
			const styles = await page.locator( '.item' ).evaluateAll( nodes => nodes.map( node => [ getComputedStyle( node ).color, getComputedStyle( node ).fontWeight ] ) );
			expect( await page.locator( '.child' ).evaluate( node => getComputedStyle( node ).backgroundColor ) ).toBe( width >= 900 ? 'rgb(255, 0, 0)' : 'rgba(0, 0, 0, 0)' );
			expect( styles ).toEqual( [
				[ width >= 500 ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)', width >= 500 && width <= 700 ? '700' : '400' ],
				[ width >= 900 ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)', '400' ],
				[ 'rgb(255, 0, 0)', '400' ],
				[ 'rgb(0, 0, 255)', '700' ],
			] );
		}
	} finally { await browser.close(); }
} );
