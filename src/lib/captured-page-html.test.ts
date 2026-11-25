import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { renderedHtml } from './captured-page-html.js';

describe( 'renderedHtml scaffolding removal', () => {
	it.each( [
		[ 'keeps a footer-named row of inline SVG icons', '<div class="footer-payment-icons"><span><svg class="icon"><use href="#visa"></use></svg></span></div>', 1 ],
		[ 'still removes an empty footer-named box', '<div class="footer-payment-icons"><span></span></div>', 0 ],
	] )( '%s', ( _name, markup, kept ) => {
		const $ = cheerio.load( renderedHtml( `<html><body><main><p>Body</p></main>${ markup }</body></html>` ) );
		expect( $( '.footer-payment-icons' ) ).toHaveLength( kept );
	} );
} );
