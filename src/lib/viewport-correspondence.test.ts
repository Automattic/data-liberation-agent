import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { wireCapturedDialogs } from './static-dialogs.js';
import { describe, expect, it } from 'vitest';
import { resolveDocumentReferences } from './document-resource-base.js';
import { assembleResponsiveCapture } from './responsive-assembly.js';
import { correspondenceMerge, RESPONSIVE_MOBILE_ONLY_CLASS } from './viewport-correspondence.js';

describe( 'viewport URL correspondence', () => {
	it( 'does not let stable ids collapse different browser-base destinations', () => {
		const html = '<html><head></head><body><main id="main"><h1>Shared</h1><a id="next" href="next">Next</a></main></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop, rawMobileHtml: mobile,
			portableDesktopHtml: desktop, portableMobileHtml: mobile,
		} );
		const $ = cheerio.load( assembly.html );
		expect( $( 'a' ).map( ( _, node ) => $( node ).attr( 'href' ) ).get() ).toEqual( [
			'https://source.test/assets/next', 'https://source.test/phone-assets/next',
		] );
		// Only the component that differs ships per viewport; the page stays one document.
		expect( assembly.hasMobileDocument ).toBe( false );
		expect( assembly.evidence ).toMatchObject( { outcome: 'collapsed-identity-subset', divergedComponents: 1 } );
	} );

	it.each( [ '#', 'https://source.test/#' ] )( 'pairs a javascript:void(0) trigger with its %s phone spelling', ( phoneHref ) => {
		const page = ( href: string ) => `<html><body><main id="main"><h1>Shared</h1><a id="menu" href="${ href }">Menu</a></main></body></html>`;
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: page( 'javascript:void(0)' ), rawMobileHtml: page( phoneHref ),
			portableDesktopHtml: page( 'javascript:void(0)' ), portableMobileHtml: page( phoneHref ),
		} );
		expect( assembly.hasMobileDocument ).toBe( false );
		expect( cheerio.load( assembly.html )( 'a' ).length ).toBe( 1 );
	} );

	it( 'keeps destinations resolved against distinct browser bases unique, even when children match', () => {
		const html = '<html><body><h1>Shared</h1><a href="next"><span>Next</span></a></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		// A wrapper holding matched content cannot safely merge different destinations.
		expect( correspondenceMerge( desktop, mobile, 767 ) ).toBeUndefined();
	} );

	it( 'does not positionally pair links with different resolved destinations', () => {
		const html = '<html><body><h1>Shared</h1><a href="next">Next</a></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		const merged = correspondenceMerge( desktop, mobile, 767 );
		expect( merged ).toBeDefined();
		const $ = cheerio.load( merged!.body );
		expect( $( 'a' ).map( ( _, node ) => $( node ).attr( 'href' ) ).get() ).toEqual( [
			'https://source.test/assets/next', 'https://source.test/phone-assets/next',
		] );
		expect( $( `a.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).length ).toBe( 1 );
	} );

	it( 'collapses repeated source ids and phone body state while adopting a phone-only captured panel', async () => {
		const css = '<style>body{margin:0}body.wide .toggle,body.wide .clone{display:none!important}body.closed .clone{display:none!important}body.phone .toggle{display:block}.clone{position:fixed;top:0;transform:translateY(-200px);display:none}body.open .clone{transform:translateY(0)}body.phone main{padding-top:40px}</style>';
		const content = '<header><nav><ul id="links"><li>Desktop menu</li></ul></nav><button id="toggle" class="toggle">Open Menu</button></header><main><h1>Home</h1><ul id="links"><li>Content</li></ul></main>';
		const desktop = `<html><head>${ css }</head><body class="wide"><div>${ content }</div><script>/* inert */</script><footer>Footer</footer></body></html>`;
		const mobile = `<html><head>${ css }</head><body class="phone closed"><div>${ content }</div><div><nav class="clone"><ul id="links"><li><a href="#home">Home</a></li><li><a href="#services">Services</a></li></ul></nav></div><footer>Footer</footer></body></html>`;
		const assembly = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		expect( assembly.evidence ).toMatchObject( { variants: 1, outcome: 'collapsed-identity-subset' } );
		const html = wireCapturedDialogs( assembly.html, [ {
			status: 'captured',
			trigger: { selector: '#toggle', tag: 'button', ariaHaspopup: '', label: 'Open Menu', dataBindings: {} },
			dialog: { selector: 'body > div:nth-of-type(3) > nav', tag: 'nav', presentation: 'dropdown', ariaModal: false,
				html: '<nav class="clone" style="display:block !important"><ul id="links"><li><a href="#home">Home</a></li><li><a href="#services">Services</a></li></ul></nav>',
				htmlBytes: 200, htmlTruncated: false, rootClassState: [ { root: 'body', removed: [ 'closed' ], added: [ 'open' ] } ] },
		} ] );
		const $ = cheerio.load( html );
		expect( $( 'nav.clone' ).length ).toBe( 1 );
		expect( $( 'nav.clone' ).attr( 'data-blocks-engine-capture-existing-panel' ) ).toBeDefined();
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await page.setContent( html );
			expect( await page.locator( 'main' ).evaluate( node => getComputedStyle( node ).paddingTop ) ).toBe( '40px' );
			await page.locator( '#toggle' ).click();
			expect( await page.locator( 'nav.clone' ).evaluate( node => node.getBoundingClientRect().top ) ).toBe( 0 );
			expect( await page.locator( 'nav.clone a:visible' ).allTextContents() ).toEqual( [ 'Home', 'Services' ] );
			await page.locator( '#toggle' ).evaluate( node => ( node as HTMLButtonElement ).click() );
			expect( await page.locator( 'nav.clone' ).isVisible() ).toBe( false );
			await page.locator( '#toggle' ).click();
			expect( await page.locator( 'nav.clone' ).evaluate( node => node.getBoundingClientRect().top ) ).toBe( 0 );
			await page.setViewportSize( { width: 1440, height: 844 } );
			expect( await page.locator( 'main' ).evaluate( node => getComputedStyle( node ).paddingTop ) ).toBe( '0px' );
		} finally { await browser.close(); }
	} );

	it( 'exports closed trigger and ancestor bindings after correspondence retains desktop opened classes', async () => {
		const page = ( open: boolean ) => `<html><head><style>.icon{display:inline-block;width:20px;height:20px;background:green}.icon.expanded{background:red}</style></head><body><header id="chrome" class="chrome ${ open ? 'expanded' : 'collapsed' }"><button id="toggle" class="control ${ open ? 'active' : 'idle' }" aria-label="Menu"><span class="icon ${ open ? 'expanded' : '' }"></span></button></header><main><h1>Home</h1></main>${ open ? '' : '<nav id="panel">Menu links</nav>' }</body></html>`;
		const desktop = page( true ), mobile = page( false );
		const assembly = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		expect( assembly.evidence ).toMatchObject( { variants: 1, outcome: 'collapsed-identity-subset' } );
		expect( cheerio.load( assembly.html )( '#toggle span' ).hasClass( 'expanded' ) ).toBe( true );
		const html = wireCapturedDialogs( assembly.html, [ {
			status: 'captured',
			trigger: { selector: '#toggle', tag: 'button', ariaHaspopup: '', label: 'Menu', dataBindings: {} },
			dialog: { selector: '#panel', tag: 'nav', ariaModal: false,
				html: '<nav id="panel">Menu links</nav>', htmlBytes: 37, htmlTruncated: false,
				ancestorState: { status: 'verified', ancestors: [ {
					selector: '#chrome', tag: 'header', depth: 1,
					closed: { class: 'collapsed' }, opened: { class: 'expanded' }, classTokensOnly: true,
				} ], trigger: [
					{ selector: '', tag: 'button', closed: { class: 'idle' }, opened: { class: 'active' }, classTokensOnly: true },
					{ selector: ':scope > :nth-child(1)', tag: 'span', closed: { class: '' }, opened: { class: 'expanded' }, classTokensOnly: true },
				] },
			},
		} ] );
		// Parse bytes without executing the load-time normalizer.
		const $ = cheerio.load( html );
		expect( $( '#chrome' ).attr( 'class' )?.split( /\s+/ ) ).toEqual( expect.arrayContaining( [ 'chrome', 'collapsed' ] ) );
		expect( $( '#chrome' ).hasClass( 'expanded' ) ).toBe( false );
		expect( $( '#toggle' ).hasClass( 'idle' ) ).toBe( true );
		expect( $( '#toggle' ).hasClass( 'active' ) ).toBe( false );
		expect( $( '#toggle span' ).hasClass( 'icon' ) ).toBe( true );
		expect( $( '#toggle span' ).hasClass( 'expanded' ) ).toBe( false );
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await page.setContent( html );
			await page.locator( '#toggle' ).click();
			expect( await page.locator( '#toggle span' ).getAttribute( 'class' ) ).toContain( 'expanded' );
			expect( await page.locator( '#chrome' ).getAttribute( 'class' ) ).toContain( 'expanded' );
			await page.locator( '#toggle' ).evaluate( node => ( node as HTMLButtonElement ).click() );
			expect( await page.locator( '#toggle span' ).getAttribute( 'class' ) ).not.toContain( 'expanded' );
			expect( await page.locator( '#chrome' ).getAttribute( 'class' ) ).toContain( 'collapsed' );
		} finally { await browser.close(); }
	} );

	it( 'refuses a mobile-only insertion that introduces a unique source id conflict', () => {
		const desktop = '<body><h1>Home</h1><div id="unique">Desktop</div></body>';
		const mobile = '<body><h1>Home</h1><nav id="unique">Phone</nav></body>';
		expect( correspondenceMerge( desktop, mobile, 767 ) ).toBeUndefined();
	} );

	it( 'places phone-only siblings after matching chrome, ignoring inert source scripts', () => {
		const desktop = '<body><h1>Home</h1><a href="/second/">Second</a><script>/* source runtime */</script><footer><a href="/footer/">Footer</a></footer></body>';
		const mobile = desktop.replace( '</body>', '<a href="/phone/">Phone</a></body>' );
		const merged = correspondenceMerge( desktop, mobile, 767 );
		expect( merged ).toBeDefined();
		const $ = cheerio.load( merged!.body );
		expect( $( 'body' ).children().map( ( _, node ) => node.tagName ).get() ).toEqual( [ 'h1', 'a', 'script', 'footer', 'a' ] );
		expect( $( 'footer' ).next().attr( 'href' ) ).toBe( '/phone/' );
	} );
} );
