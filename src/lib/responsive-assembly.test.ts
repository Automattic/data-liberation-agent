import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { learnAndApplyFluidGeometry } from './screenshot/fluid-capture.js';
import {
	assembleResponsiveCapture,
	DESKTOP_DOCUMENT_CLASS,
	documentsDiffer,
	MOBILE_DOCUMENT_CLASS,
	projectResponsiveIdentityCss,
	type ResponsiveAssembly,
	routePhoneDocumentFragments,
} from './responsive-assembly.js';
import { scopeCss } from './replicate/css-scope.js';

const dirs: string[] = [];

describe( 'responsive identity CSS recovery', () => {
	it( 'preserves browser-recovered declarations and priorities through projection and scoping', async () => {
		const css = '#target { display: none; !important } #next { color: red; !important; opacity: .5; color: green !important; content: "!important" } #next { color: blue }';
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage();
			await source.setContent( page( '<div id="target"></div><div id="next"></div>', `<style>${ css }</style>` ) );
			const styles = async ( browserPage: typeof source, ids: string[] ) => browserPage.evaluate( ( targets ) => targets.map( id => {
				const style = getComputedStyle( document.getElementById( id )! );
				return { display: style.display, color: style.color, opacity: style.opacity, content: style.content };
			} ), ids );
			const expected = await styles( source, [ 'target', 'next' ] );
			expect( expected[ 0 ].display ).toBe( 'none' );
			expect( expected[ 1 ] ).toMatchObject( { color: 'rgb(0, 128, 0)', opacity: '0.5', content: '"!important"' } );
			const projected = projectResponsiveIdentityCss( css, new Map( [ [ 'target', 'phone-target' ], [ 'next', 'phone-next' ] ] ), false );
			const scoped = scopeCss( projected, { scope: '.copy' } );
			const copy = await browser.newPage();
			await copy.setContent( page( '<div class="copy"><div id="phone-target"></div><div id="phone-next"></div></div><div id="next"></div>', `<style>${ scoped }</style>` ) );
			expect( await styles( copy, [ 'phone-target', 'phone-next' ] ) ).toEqual( expected );
			expect( ( await styles( copy, [ 'next' ] ) )[ 0 ].opacity ).toBe( '1' );
		} finally {
			await browser.close();
		}
	} );

	// An invalid selector list makes the browser drop the whole rule. Projection
	// leaves that rule inert as authored and still projects every other rule.
	it( 'leaves a browser-dropped rule with an invalid selector list as authored', async () => {
		const invalid = '.form input:not:[type="submit"], .form textarea { color: red }';
		const css = `#target { color: green } ${ invalid }`;
		const projected = projectResponsiveIdentityCss( css, new Map( [ [ 'target', 'phone-target' ] ] ), false );
		expect( projected ).toContain( ':is(#target,#phone-target)' );
		expect( projected ).toContain( invalid );
		const browser = await chromium.launch();
		try {
			const color = async ( styles: string, body: string ) => {
				const browserPage = await browser.newPage();
				await browserPage.setContent( page( body, `<style>${ styles }</style>` ) );
				return browserPage.evaluate( () => [ 'phone-target', 'field' ].map( id => getComputedStyle( document.getElementById( id )! ).color ) );
			};
			const markup = '<div id="phone-target"></div><form class="form"><textarea id="field"></textarea></form>';
			const source = await color( css.replace( '#target', '#phone-target' ), markup );
			expect( source[ 1 ] ).not.toBe( 'rgb(255, 0, 0)' );
			expect( await color( projected, markup ) ).toEqual( source );
		} finally {
			await browser.close();
		}
	} );

	it( 'uses the shared stray delimiter recovery during identity projection', () => {
		const projected = projectResponsiveIdentityCss( '#target { --shadow: 0px;); --width: 1px; ]; color: red }', new Map( [ [ 'target', 'phone-target' ] ] ), false );
		expect( projected ).toContain( ':is(#target,#phone-target)' );
		expect( projected ).toContain( '--width: 1px' );
		expect( projected ).toContain( 'color: red' );
	} );

	it( 'preserves identity-free CSS and rejects unsupported syntax requiring identity projection', () => {
		const css = '.x { color: red !important; content: "!important" }';
		expect( projectResponsiveIdentityCss( css, new Map(), false ) ).toBe( css );
		const unrelated = '.x { color: red; broken; opacity: .5 }';
		expect( projectResponsiveIdentityCss( unrelated, new Map(), false ) ).toBe( unrelated );
		expect( () => projectResponsiveIdentityCss( '#target { color: red; broken; opacity: .5 }', new Map( [ [ 'target', 'phone-target' ] ] ), false ) ).toThrow();
	} );
} );

afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function page( body: string, head = '', bodyAttributes = '' ): string {
	return `<html><head>${ head }</head><body${ bodyAttributes }>${ body }</body></html>`;
}

describe( 'moved body class selectors', () => {
	it.each( [ true, false ] )( 'rewrites moved compounds with shared styles=%s', shared => {
		const css = 'body.desk .grid{display:flex} body.mob .grid{display:block} body.page{margin:0} body.desk > .grid{gap:2px} body.page.desk[data-layout]:hover > .grid{gap:3px}';
		const desktop = page( '<div class="grid"><div>a</div><div>b</div></div>', `<style>${ css }</style>`, ' class="page desk"' );
		const mobile = page( '<section class="grid">a</section>', `<style>${ css }${ shared ? '' : '.grid{color:red}' }</style>`, ' class="page mob"' );
		const assembly = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const $ = cheerio.load( assembly.html );
		const styles = $( 'style' ).map( ( _, node ) => $( node ).text() ).get().join( '\n' );
		expect( assembly.hasMobileDocument ).toBe( true );
		expect( styles ).toContain( `.${ DESKTOP_DOCUMENT_CLASS }.desk .grid` );
		expect( styles ).toContain( `.${ MOBILE_DOCUMENT_CLASS }.mob .grid` );
		expect( styles ).toContain( 'body.page{margin:0}' );
		expect( styles ).toContain( `.${ DESKTOP_DOCUMENT_CLASS }.desk > .grid` );
		expect( styles ).toContain( `.${ DESKTOP_DOCUMENT_CLASS }.page.desk[data-layout]:hover > .grid` );
		expect( styles ).not.toContain( 'body.desk' );
	} );
} );

function wrappers( html: string ): { desktop: number; mobile: number } {
	const $ = cheerio.load( html );
	return {
		desktop: $( `.${ DESKTOP_DOCUMENT_CLASS }` ).length,
		mobile: $( `.${ MOBILE_DOCUMENT_CLASS }` ).length,
	};
}

function evidenceMatchesTree( assembly: ResponsiveAssembly ): void {
	const shipped = wrappers( assembly.html );
	if ( assembly.evidence === undefined ) {
		expect( assembly.hasMobileDocument ).toBe( false );
		expect( shipped.desktop + shipped.mobile ).toBe( 0 );
		return;
	}
	expect( assembly.hasMobileDocument ).toBe( assembly.evidence.outcome === 'dual-structural' );
	expect( assembly.evidence.variants ).toBe( assembly.hasMobileDocument ? 2 : 1 );
	if ( assembly.hasMobileDocument ) {
		expect( shipped.desktop ).toBe( 1 );
		expect( shipped.mobile ).toBe( 1 );
	} else {
		expect( shipped.desktop ).toBe( 0 );
		expect( shipped.mobile ).toBe( 0 );
	}
}

describe( 'assembleResponsiveCapture', () => {
	it( 'ships one island when captures differ only in equivalent absolute link spellings (#968)', () => {
		// The provider evidence had identical island state, but hydration had
		// canonicalized links in only one viewport. Assembly created the hidden
		// second page; no duplicate existed in either source document.
		const body = ( href: string ) => `<astro-island uid="same" client="load" await-children><main class="page"><header>Header</header><a href="${ href }">Reference</a><details><summary>Menu</summary><a href="/contact">Contact</a></details><dialog id="dialog">Closed dialog</dialog><section hidden id="tab">Hidden tab</section><footer>Footer</footer></main></astro-island>`;
		const desktop = page( body( 'http://example.org/' ) );
		const mobile = page( body( 'http://EXAMPLE.org' ) );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const $ = cheerio.load( result.html );
		expect( result.evidence?.outcome ).toBe( 'collapsed-equivalent' );
		expect( $( 'astro-island' ) ).toHaveLength( 1 );
		expect( $( '.page' ) ).toHaveLength( 1 );
		expect( $( `.${ MOBILE_DOCUMENT_CLASS }` ) ).toHaveLength( 0 );
		// Hidden, reachable content is not a duplicate page and must survive.
		expect( $( 'details a' ).text() ).toBe( 'Contact' );
		expect( $( '#dialog' ).text() ).toBe( 'Closed dialog' );
		expect( $( '#tab[hidden]' ).text() ).toBe( 'Hidden tab' );
		expect( $( 'a' ).first().attr( 'href' ) ).toBe( 'http://example.org/' );
	} );

	it.each( [
		[ 'https://example.org/path', 'https://example.org/path/' ],
		[ 'https://example.org/Path', 'https://example.org/path' ],
		[ 'https://example.org/?a=1', 'https://example.org/?a=2' ],
		[ 'https://example.org/#one', 'https://example.org/#two' ],
		[ '/path', 'https://example.org/path' ],
		[ '//example.org/', 'https://example.org/' ],
	] )( 'keeps distinct navigation identities: %s vs %s', ( desktopHref, mobileHref ) => {
		expect( documentsDiffer( page( `<a href="${ desktopHref }">Link</a>` ), page( `<a href="${ mobileHref }">Link</a>` ) ) ).toBe( true );
	} );
	it.each( [
		{ name: 'padding shorthand', important: 'padding:6px!important', desktop: 'padding-top:40px', mobile: 'padding-top:80px', padding: '6px', display: 'block' },
		{ name: 'all reset', important: 'all:initial!important', desktop: 'display:block;width:220px;padding:40px', mobile: 'display:block;width:160px;padding:80px', padding: '0px', display: 'inline' },
	] )( 'preserves source layout when $name overrides normal inline state', async fixture => {
		const css = `<style>body{margin:0}main{font:16px/20px Arial}#box{${ fixture.important }}</style>`;
		const desktop = page( `<main id="owner"><div id="box" style="${ fixture.desktop }">Source-owned caption</div></main>`, css );
		const mobile = page( `<main id="owner"><div id="box" style="${ fixture.mobile }">Source-owned caption</div></main>`, css );
		const assembled = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const html = routePhoneDocumentFragments( assembled.html, '/index.html' );
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage();
			const copy = await browser.newPage();
			const measure = ( browserPage: typeof source ) => browserPage.locator( 'main:visible' ).evaluate( main => {
				const node = main.querySelector( 'div' )!, box = node.getBoundingClientRect(), style = getComputedStyle( node );
				return { x: box.x, y: box.y, width: box.width, height: box.height, mainHeight: main.getBoundingClientRect().height, padding: style.padding, display: style.display };
			} );
			for ( const width of [ 390, 768, 1440 ] ) {
				await source.setViewportSize( { width, height: 900 } );
				await copy.setViewportSize( { width, height: 900 } );
				await source.setContent( width < 768 ? mobile : desktop );
				const expected = await measure( source );
				expect( expected ).toMatchObject( { padding: fixture.padding, display: fixture.display } );
				await copy.setContent( html );
				expect( await measure( copy ), `native cascade at ${ width }px` ).toEqual( expected );
			}
			expect( assembled.hasMobileDocument ).toBe( true );
		} finally { await browser.close(); }
	} );
	it.each( [ false, true ] )( 'preserves authored important visibility over normal inline state (%s structural subset)', async subset => {
		const css = '<style>body{margin:0}h1,p{margin:0}#stage{height:80px}.adapt{display:none!important}@media(max-width:767px){.adapt{display:block!important}}</style>';
		const unrelatedCss = '<style>/* license: https://example.test/#license */@font-face{font-family:unused;src:url(data:font/woff2;base64,AA==);url(data:font/woff;base64,AA==)}.icon{font-style:normal;color:#fff;border:solid #f1f1f1}</style>';
		const desktop = page( '<main id="owner"><div id="stage"><h1>Actual active slide</h1></div><div class="adapt" style="display:block;padding:20px"><p>Responsive caption</p></div></main>', css + unrelatedCss );
		const mobile = page( `<main id="owner"><div id="stage"><h1>Actual active slide</h1></div><div class="adapt" style="padding:10px"><p>Responsive caption</p></div>${ subset ? '<aside id="phone">Phone content</aside>' : '' }</main>`, css + unrelatedCss );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const reconciled = routePhoneDocumentFragments( result.html, '/index.html' );
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage();
			const copy = await browser.newPage();
			for ( const width of [ 390, 768, 1440 ] ) {
				await source.setViewportSize( { width, height: 900 } );
				await copy.setViewportSize( { width, height: 900 } );
				await source.setContent( width < 768 ? mobile : desktop );
				await copy.setContent( reconciled );
				expect( await copy.locator( 'main:visible' ).innerText() ).toBe( await source.locator( 'main' ).innerText() );
				expect( ( await copy.locator( 'main:visible' ).boundingBox() )!.height ).toBe( ( await source.locator( 'main' ).boundingBox() )!.height );
			}
		} finally { await browser.close(); }
	} );
	it( 'keeps the learned runtime slide phase authoritative over mobile counterpart projection', async () => {
		const body = '<main><div id="track" style="position:relative;width:calc(100vw - 31px);height:180px;overflow:hidden"><div id="active" style="position:absolute;width:320px;height:150px">Active</div><div id="inactive" style="position:absolute;width:320px;height:150px;transform:translate3d(0px,0px,0px)">Inactive testimonial</div></div></main>';
		const runtime = `<script>const update=()=>{const w=innerWidth,x=w<768?w-16:w<800?w-11:w-38;document.querySelector('#inactive').style.transform='translate3d('+x+'px,0px,0px)'};addEventListener('resize',update);update()</script>`;
		const desktop = page( body + runtime, '<style>body{margin:0}</style>' );
		const mobile = page( body + runtime, '<style>body{margin:0}</style>' );
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage( { viewport: { width: 402, height: 681 } } );
			await source.setContent( mobile );
			const sourcePhoneX = ( await source.locator( '#inactive' ).boundingBox() )!.x;
			await source.setViewportSize( { width: 768, height: 900 } );
			await source.waitForTimeout( 30 );
			const sourceTabletX = ( await source.locator( '#inactive' ).boundingBox() )!.x;
			await source.setViewportSize( { width: 402, height: 681 } );
			await source.waitForTimeout( 30 );
			const capturedMobile = await source.evaluate( () => { document.querySelectorAll( 'script' ).forEach( script => script.remove() ); return document.documentElement.outerHTML; } );
			const desktopSource = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await desktopSource.setContent( desktop );
			const widths = [ 390, 402, 600, 767, 768, 799, 800, 1024, 1280, 1440 ];
			const sourcePhase = new Map<number, number>();
			for ( const width of [ 390, 402, 768, 1440 ] ) {
				await desktopSource.setViewportSize( { width, height: 900 } );
				await desktopSource.waitForTimeout( 20 );
				sourcePhase.set( width, ( await desktopSource.locator( '#inactive' ).boundingBox() )!.x );
			}
			for ( const width of widths ) {
				await desktopSource.setViewportSize( { width, height: 900 } );
				await desktopSource.waitForTimeout( 10 );
			}
			await learnAndApplyFluidGeometry( desktopSource, { widths, settleMs: 10 } );
			const capturedDesktop = await desktopSource.evaluate( () => { document.querySelectorAll( 'script' ).forEach( script => script.remove() ); return document.documentElement.outerHTML; } );
			const capturedAssembly = assembleResponsiveCapture( {
				rawDesktopHtml: capturedDesktop,
				rawMobileHtml: capturedMobile,
				portableDesktopHtml: capturedDesktop,
				portableMobileHtml: capturedMobile,
				switchWidth: 799,
			} );
			const copy = await browser.newPage( { viewport: { width: 768, height: 900 } } );
			await copy.setContent( capturedAssembly.html );
			expect( sourcePhoneX ).toBe( 386 );
			// The source's tablet pose is observed from the live responsive runtime,
			// not extrapolated from the phone and desktop endpoint snapshots.
			expect( sourceTabletX ).toBe( 757 );
			expect( capturedDesktop ).toContain( 'data-blocks-engine-capture-fluid-rules' );
			for ( const width of [ 390, 402, 768, 1440 ] ) {
				await copy.setViewportSize( { width, height: 900 } );
				const copyBox = ( await copy.locator( '#inactive' ).boundingBox() )!;
				const holder = ( await copy.locator( '#track' ).boundingBox() )!;
				expect( Math.abs( copyBox.x - sourcePhase.get( width )! ), `source/copy phase at ${ width }` ).toBeLessThanOrEqual( 2 );
				if ( width === 768 ) expect( copyBox.x ).toBeGreaterThanOrEqual( holder.x + holder.width );
			}
			await source.close();
			await desktopSource.close();
			await copy.close();
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'returns the portable desktop document when mobile was not captured', () => {
		const desktop = page( '<main><h1>Only</h1></main>' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop,
			portableDesktopHtml: desktop.replace( 'Only', 'Portable' ),
		} );
		expect( assembly.html ).toContain( 'Portable' );
		expect( assembly.evidence ).toBeUndefined();
		expect( assembly.portableNormalization ).toBe( 'absent' );
		evidenceMatchesTree( assembly );
	} );

	it( 'collapses equivalent documents and projects inline presentation into the same result', () => {
		const head = '<style>.wrap{margin:0}</style>';
		const rawDesktop = page( '<main><div class="wrap" style="width:940px"><h1>About</h1></div></main>', head );
		const rawMobile = page( '<main><div class="wrap" style="width:100%"><h1>About</h1></div></main>', head, ' class="mobile"' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence ).toMatchObject( {
			variants: 1,
			outcome: 'collapsed-equivalent',
			css: 'shared',
			projectedInlineStyles: 1,
		} );
		expect( assembly.html ).toContain( 'width:100%!important' );
		expect( assembly.html ).toContain( 'style="width:940px"' );
		expect( assembly.portableNormalization ).toBe( 'pending' );
	} );

	it( 'collapses an identity subset and records the inserted mobile-only element', () => {
		const rawDesktop = page( '<div id="comp-root"><p id="comp-copy">Desktop</p></div>' );
		const rawMobile = page( '<div id="comp-root"><p id="comp-copy">Desktop</p><span id="comp-phone">Phone</span></div>' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence ).toMatchObject( {
			outcome: 'collapsed-identity-subset',
			mobileOnlyElements: 1,
		} );
		const $ = cheerio.load( assembly.html );
		expect( $( '#comp-phone.data-blocks-engine-capture-mobile-only' ) ).toHaveLength( 1 );
		expect( assembly.portableNormalization ).toBe( 'pending' );
	} );

	it( 'ships both documents when the mobile tree does not reconcile', () => {
		const rawDesktop = page( '<main><h1>Desktop</h1></main>' );
		const rawMobile = page( '<main><h1>Phone</h1><aside>Menu</aside></main>', '', ' class="phone"' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence ).toMatchObject( {
			variants: 2,
			outcome: 'dual-structural',
			reason: 'mobile document differs structurally from desktop; both variants shipped',
		} );
		expect( assembly.portableNormalization ).toBe( 'applied' );
	} );

	it( 'records a single desktop document when a binding gate has no portable body to wrap', () => {
		const css = '<style>body:not(.phone) main{width:980px}</style>';
		const rawDesktop = page( '<main><h1>Shared</h1></main>', css );
		const rawMobile = page( '<main><h1>Shared</h1></main>', css, ' class="phone"' );
		const portableDesktop = page( '<main><h1>Portable</h1></main>', css );
		const portableMobile = `<html><head>${ css }</head><body class="phone"><main><h1>Broken</h1></main>`;
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: portableDesktop,
			portableMobileHtml: portableMobile,
		} );
		expect( wrappers( assembly.html ) ).toEqual( { desktop: 0, mobile: 0 } );
		expect( assembly.html ).toContain( 'Portable' );
		expect( assembly.html ).not.toContain( DESKTOP_DOCUMENT_CLASS );
		expect( assembly.hasMobileDocument ).toBe( false );
		expect( assembly.portableNormalization ).toBe( 'applied' );
		expect( assembly.evidence ).toEqual( {
			variants: 1,
			outcome: 'collapsed-equivalent',
			reason: 'a captured document is missing its body, so assembly shipped the desktop document alone',
		} );
		// Invalid input correction: the raw gate would previously have recorded
		// variants:2 / dual-structural while the emitted file had one document.
		expect( assembly.evidence?.variants ).not.toBe( 2 );
		expect( assembly.evidence?.outcome ).not.toBe( 'dual-structural' );
		evidenceMatchesTree( assembly );
	} );

	it( 'follows the portable collapse when raw documents differ only before normalization', () => {
		const rawDesktop = page( '<main><h1>Home</h1><aside><a href="/signup">Sign up</a></aside></main>' );
		const rawMobile = page( '<main><h1>Home</h1></main>' );
		const portable = page( '<main><h1>Home</h1></main>' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: portable,
			portableMobileHtml: portable,
		} );
		expect( documentsDiffer( rawDesktop, rawMobile ) ).toBe( true );
		expect( wrappers( assembly.html ) ).toEqual( { desktop: 0, mobile: 0 } );
		expect( assembly.hasMobileDocument ).toBe( false );
		expect( assembly.portableNormalization ).toBe( 'applied' );
		expect( assembly.evidence ).toMatchObject( {
			variants: 1,
			outcome: 'collapsed-equivalent',
		} );
		// The source pair is structurally dual. The previous receipt classifier
		// recorded dual-structural for that raw pair while assembly of the
		// normalized pair emitted one document. The receipt now follows the tree.
		expect( assembly.evidence?.outcome ).not.toBe( 'dual-structural' );
		evidenceMatchesTree( assembly );
	} );

	it( 'keeps a phone-only body-class gate even when portable documents no longer show it', () => {
		const css = '<style>body:not(.phone) main{width:980px}</style>';
		const rawDesktop = page( '<main><h1>Shared</h1></main>', css );
		const rawMobile = page( '<main><h1>Shared</h1></main>', css, ' class="phone"' );
		const portable = page( '<main><h1>Shared</h1></main>' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: portable,
			portableMobileHtml: portable.replace( '<body>', '<body class="phone">' ),
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence?.reason ).toContain( 'body:not(.phone)' );
		expect( assembly.html ).toContain( DESKTOP_DOCUMENT_CLASS );
		expect( assembly.html ).toContain( MOBILE_DOCUMENT_CLASS );
		expect( assembly.portableNormalization ).toBe( 'applied' );
	} );
} );

describe( 'exportWebsiteCapture responsive assembly', () => {
	function exportPair( desktop: string, mobile?: string, linkedCss?: string ): { html: string; receipt: { routes: Array< { responsiveVariants?: { outcome: string; variants: number } } > }; profile: { variants: string; documentsPerRoute: number } } {
		const outputDir = mkdtempSync( join( tmpdir(), 'liberation-responsive-assembly-' ) );
		dirs.push( outputDir );
		mkdirSync( join( outputDir, 'html' ), { recursive: true } );
		mkdirSync( join( outputDir, 'screenshots' ), { recursive: true } );
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), desktop );
		if ( mobile !== undefined ) {
			mkdirSync( join( outputDir, 'html-mobile' ), { recursive: true } );
			writeFileSync( join( outputDir, 'html-mobile', 'homepage.html' ), mobile );
		}
		writeFileSync(
			join( outputDir, 'screenshots', 'manifest.json' ),
			JSON.stringify( { version: 1, entries: { 'https://example.com/': { slug: 'homepage', html: 'html/homepage.html' } } } )
		);
		if ( linkedCss !== undefined ) {
			mkdirSync( join( outputDir, 'resources' ), { recursive: true } );
			writeFileSync( join( outputDir, 'resources', 'layout.css' ), linkedCss );
			writeFileSync( join( outputDir, 'resources', 'manifest.json' ), JSON.stringify( { version: 1, resources: { 'https://example.com/layout.css': { path: 'resources/layout.css', contentType: 'text/css' } }, failures: [] } ) );
		}
		exportWebsiteCapture( { outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] } );
		return {
			html: readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ),
			receipt: JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ),
			profile: JSON.parse( readFileSync( join( outputDir, 'source-profile.json' ), 'utf8' ) ),
		};
	}

	function receiptMatchesTree( html: string, outcome: string | undefined, profile: { documentsPerRoute: number } ): void {
		const shipped = wrappers( html );
		const dual = shipped.desktop === 1 && shipped.mobile === 1;
		expect( shipped.desktop ).toBe( dual ? 1 : 0 );
		expect( shipped.mobile ).toBe( dual ? 1 : 0 );
		expect( outcome === 'dual-structural' ).toBe( dual );
		expect( profile.documentsPerRoute ).toBe( dual ? 2 : 1 );
	}

	it( 'projects captured linked CSS through the export stylesheet path', () => {
		const link = '<link rel="stylesheet" href="https://example.com/layout.css">';
		const exported = exportPair(
			page( '<div class="grid">Desktop</div>', link, ' class="page desk"' ),
			page( '<section class="grid">Mobile</section>', link, ' class="page mob"' ),
			'body.desk > .grid{display:flex} body.page.mob:hover .grid{display:block} body.page{margin:0}'
		);
		const $ = cheerio.load( exported.html );
		const href = $( 'link[rel="stylesheet"]' ).attr( 'href' )!;
		const css = readFileSync( join( dirs[ dirs.length - 1 ], 'website', href.replace( /^\//, '' ) ), 'utf8' );
		expect( css ).toContain( `.${ DESKTOP_DOCUMENT_CLASS }.desk > .grid` );
		expect( css ).toContain( 'body.desk > .grid' );
		expect( css ).toContain( `.${ MOBILE_DOCUMENT_CLASS }.page.mob:hover .grid` );
		expect( css ).toContain( 'body.page{margin:0}' );
	} );

	it( 'records the same disposition the emitted tree shows for absent, equivalent, identity-subset, and gated pairs', () => {
		const absent = exportPair( page( '<main><h1>Only</h1></main>' ) );
		expect( absent.receipt.routes[ 0 ].responsiveVariants ).toBeUndefined();
		receiptMatchesTree( absent.html, undefined, absent.profile );

		const equivalent = exportPair(
			page( '<main><div style="width:940px"><h1>About</h1></div></main>', '<style>.a{color:red}</style>' ),
			page( '<main><div style="width:100%"><h1>About</h1></div></main>', '<style>.a{color:red}</style>' )
		);
		expect( equivalent.receipt.routes[ 0 ].responsiveVariants ).toMatchObject( {
			outcome: 'collapsed-equivalent',
			projectedInlineStyles: 1,
		} );
		receiptMatchesTree( equivalent.html, equivalent.receipt.routes[ 0 ].responsiveVariants?.outcome, equivalent.profile );

		const subset = exportPair(
			page( '<div id="comp-root"><p id="comp-copy">Desktop</p></div>' ),
			page( '<div id="comp-root"><p id="comp-copy">Desktop</p><span id="comp-phone">Phone</span></div>' )
		);
		expect( subset.receipt.routes[ 0 ].responsiveVariants?.outcome ).toBe( 'collapsed-identity-subset' );
		receiptMatchesTree( subset.html, subset.receipt.routes[ 0 ].responsiveVariants?.outcome, subset.profile );
		expect( cheerio.load( subset.html )( '#comp-phone' ) ).toHaveLength( 1 );

		const gated = exportPair(
			page( '<main><h1>Shared</h1></main>', '<style>body:not(.phone) main{width:980px}</style>' ),
			page( '<main><h1>Shared</h1></main>', '<style>body:not(.phone) main{width:980px}</style>', ' class="phone"' )
		);
		expect( gated.receipt.routes[ 0 ].responsiveVariants ).toMatchObject( { variants: 2, outcome: 'dual-structural' } );
		receiptMatchesTree( gated.html, gated.receipt.routes[ 0 ].responsiveVariants?.outcome, gated.profile );
	} );

	it( 'exports one full page for a hydrated/unhydrated link pair instead of a hidden mobile duplicate (#968)', () => {
		const island = ( hydrated: boolean ) => `<astro-island uid="same" client="load" await-children><main class="page"><header>Header</header><a href="${ hydrated ? 'https://reference.test/' : 'https://reference.test' }">Reference</a><a href="${ hydrated ? 'http://example.org/' : 'http://EXAMPLE.org' }">Article</a><details><summary>Menu</summary>Reachable menu</details><dialog>Reachable dialog</dialog><footer>Footer</footer></main></astro-island>`;
		const exported = exportPair( page( island( true ) ), page( island( false ) ) );
		const $ = cheerio.load( exported.html );
		expect( $( 'astro-island:has(.page)' ) ).toHaveLength( 1 );
		expect( $( 'header' ) ).toHaveLength( 1 );
		expect( $( 'footer' ) ).toHaveLength( 1 );
		expect( $( 'details' ).text() ).toContain( 'Reachable menu' );
		expect( $( 'dialog' ).text() ).toBe( 'Reachable dialog' );
		expect( exported.receipt.routes[ 0 ].responsiveVariants?.outcome ).toBe( 'collapsed-equivalent' );
		receiptMatchesTree( exported.html, 'collapsed-equivalent', exported.profile );
	} );

	it( 'records the collapsed portable tree when rendering removes the only raw structural difference', () => {
		const promo = '<div style="position:fixed!important"><a href="/signup">Sign up</a> Create your own website</div>';
		const mobile = page( '<main><h1>Home</h1></main>' );
		const desktop = page( `<main><h1>Home</h1></main>${ promo }` );
		const exported = exportPair( desktop, mobile );
		expect( documentsDiffer( desktop, mobile ) ).toBe( true );
		expect( exported.html ).not.toContain( 'Create your own website' );
		expect( exported.html ).not.toContain( DESKTOP_DOCUMENT_CLASS );
		expect( exported.receipt.routes[ 0 ].responsiveVariants ).toMatchObject( {
			variants: 1,
			outcome: 'collapsed-equivalent',
		} );
		expect( exported.profile ).toMatchObject( { variants: 'single', documentsPerRoute: 1 } );
		receiptMatchesTree(
			exported.html,
			exported.receipt.routes[ 0 ].responsiveVariants?.outcome,
			exported.profile
		);
		// Before this slice the raw classifier recorded dual-structural and
		// documentsPerRoute 2 for this pair, while the normalized assembly
		// emitted one document. Metadata now matches that emitted tree.
		expect( exported.receipt.routes[ 0 ].responsiveVariants?.outcome ).not.toBe( 'dual-structural' );
		expect( exported.profile.documentsPerRoute ).not.toBe( 2 );
	} );
} );
