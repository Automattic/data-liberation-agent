import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { assembleResponsiveCapture, DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS } from './responsive-assembly.js';

// Legacy popup helpers write a whole document from a string, so the page's own
// script text carries `<body …>` and `</body>`. Only the real tags bound the
// document; the copies in the script are text.
const POPUP_SCRIPT =
	'<script>function preview(link) { var w = window.open("#", "preview", "width=600");' +
	' w.document.write(\'<head><title>Preview</title></head><body leftmargin="0"><img src="\' + link + \'"></body>\'); }' +
	' function after() { for (var i = 0; i<items.length; i++) run(items[i]); }</script>';

function page( body: string, head = '', bodyAttributes = '' ): string {
	return `<html><head>${ head }</head><body${ bodyAttributes }>${ body }</body></html>`;
}

/** Body text outside scripts and styles, as a browser would show it. */
function visibleText( $: cheerio.CheerioAPI, selector: string ): string {
	const copy = $( selector ).clone();
	copy.find( 'script,style' ).remove();
	const words: string[] = [];
	copy.find( '*' ).addBack().contents().each( ( _index, node ) => {
		if ( node.type === 'text' ) words.push( $( node ).text() );
	} );
	return words.join( ' ' ).replace( /\s+/g, ' ' ).trim();
}

function expectIntactDocument( html: string ): cheerio.CheerioAPI {
	const $ = cheerio.load( html );
	expect( $( 'body' ) ).toHaveLength( 1 );
	// The source script survives as one script, with its document.write string and the code after it.
	const scripts = $( 'script' ).toArray().map( ( node ) => $( node ).text() ).filter( ( text ) => text.includes( 'preview' ) );
	expect( scripts.length ).toBeGreaterThan( 0 );
	for ( const script of scripts ) expect( script ).toContain( 'function after()' );
	// No script code leaks into the rendered text.
	expect( visibleText( $, 'body' ) ).not.toContain( 'function after' );
	expect( visibleText( $, 'body' ) ).not.toContain( 'items.length' );
	return $;
}

describe( 'responsive assembly with document markup inside script text', () => {
	it( 'keeps the content after the script when both documents ship', () => {
		const desktop = page( `<main><h1>Desktop title</h1>${ POPUP_SCRIPT }<p id="after">Content after the script</p></main><footer>Footer</footer>` );
		const mobile = page( '<main><h1>Phone title</h1><aside>Phone menu</aside><p id="after">Content after the script</p></main><footer>Footer</footer>', '', ' class="phone"' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			rawMobileHtml: mobile,
			portableDesktopHtml: desktop,
			portableMobileHtml: mobile,
		} );
		expect( assembly.evidence?.outcome ).toBe( 'dual-structural' );
		const $ = expectIntactDocument( assembly.html );
		expect( visibleText( $, `.${ DESKTOP_DOCUMENT_CLASS }` ) ).toBe( 'Desktop title Content after the script Footer' );
		expect( visibleText( $, `.${ MOBILE_DOCUMENT_CLASS }` ) ).toBe( 'Phone title Phone menu Content after the script Footer' );
		// Nothing of the source document is left outside the two copies.
		const children = $( 'body' ).children().toArray().map( ( node ) => $( node ) );
		expect( children ).toHaveLength( 2 );
		expect( children[ 0 ]!.hasClass( DESKTOP_DOCUMENT_CLASS ) ).toBe( true );
		expect( children[ 1 ]!.hasClass( MOBILE_DOCUMENT_CLASS ) ).toBe( true );
	} );

	it( 'keeps the content after the script when equivalent documents collapse with projected inline styles', () => {
		const desktop = page( `<main><div class="wrap" style="width:940px"><h1>About</h1></div>${ POPUP_SCRIPT }<p>Content after the script</p></main>` );
		const mobile = page( `<main><div class="wrap" style="width:100%"><h1>About</h1></div>${ POPUP_SCRIPT }<p>Content after the script</p></main>` );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			rawMobileHtml: mobile,
			portableDesktopHtml: desktop,
			portableMobileHtml: mobile,
		} );
		expect( assembly.evidence ).toMatchObject( { outcome: 'collapsed-equivalent', projectedInlineStyles: 1 } );
		const $ = expectIntactDocument( assembly.html );
		expect( visibleText( $, 'body' ) ).toBe( 'About Content after the script' );
		expect( $( 'main' ) ).toHaveLength( 1 );
	} );

	it( 'keeps the content after the script when an identity subset collapses', () => {
		const desktop = page( `<div id="comp-root"><p id="comp-copy">Shared</p>${ POPUP_SCRIPT }<p id="comp-after">Content after the script</p></div>` );
		const mobile = page( `<div id="comp-root"><p id="comp-copy">Shared</p>${ POPUP_SCRIPT }<p id="comp-after">Content after the script</p><span id="comp-phone">Phone</span></div>` );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			rawMobileHtml: mobile,
			portableDesktopHtml: desktop,
			portableMobileHtml: mobile,
		} );
		expect( assembly.evidence ).toMatchObject( { outcome: 'collapsed-identity-subset', mobileOnlyElements: 1 } );
		const $ = expectIntactDocument( assembly.html );
		expect( visibleText( $, 'body' ) ).toBe( 'Shared Content after the script Phone' );
		expect( $( '#comp-root' ) ).toHaveLength( 1 );
	} );

	it( 'compares the whole bodies, not the part before a body string in a script', () => {
		const desktop = page( `<main><h1>Title</h1>${ POPUP_SCRIPT }<p>Desktop only paragraph</p><p>Second</p></main>` );
		const mobile = page( `<main><h1>Title</h1>${ POPUP_SCRIPT }<section><p>Phone layout</p></section></main>` );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			rawMobileHtml: mobile,
			portableDesktopHtml: desktop,
			portableMobileHtml: mobile,
		} );
		// Truncated at the script string, both bodies look the same and the phone layout is dropped.
		expect( assembly.evidence?.outcome ).not.toBe( 'collapsed-equivalent' );
		expect( assembly.html ).toContain( 'Phone layout' );
	} );

	it( 'inserts responsive styles before the real </head>, not inside a head script string', () => {
		const head = `<style>.wrap{margin:0}</style>${ POPUP_SCRIPT }`;
		const desktop = page( '<main><h1>Desktop</h1></main>', head );
		const mobile = page( '<main><h1>Phone</h1><aside>Menu</aside></main>', '<style>.wrap{margin:1px}</style>' + POPUP_SCRIPT, ' class="phone"' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			rawMobileHtml: mobile,
			portableDesktopHtml: desktop,
			portableMobileHtml: mobile,
		} );
		expect( assembly.evidence?.outcome ).toBe( 'dual-structural' );
		const $ = expectIntactDocument( assembly.html );
		// The document switch rules are real style elements in the head.
		const headStyles = $( 'head style' ).toArray().map( ( node ) => $( node ).text() ).join( '\n' );
		expect( headStyles ).toContain( `.${ MOBILE_DOCUMENT_CLASS }` );
		for ( const script of $( 'script' ).toArray() ) expect( $( script ).text() ).not.toContain( MOBILE_DOCUMENT_CLASS );
	} );
} );
