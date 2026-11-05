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

async function expectStylesheetParity( desktop: string, mobile: string, assembled: string, properties: string[], expectedPhone?: string[], selector = 'main' ): Promise<void> {
	const browser = await chromium.launch();
	try {
		const tab = await browser.newPage();
		await tab.route( 'https://fixture.test/**', route => route.fulfill( { contentType: 'text/css', body: '.target{font-size:18px}' } ) );
		for ( const width of [ 390, 768, 1440 ] ) {
			await tab.setViewportSize( { width, height: 900 } );
			const measure = async ( html: string ) => {
				await tab.setContent( html );
				return tab.locator( selector ).evaluate( ( node, names ) => {
					const css = getComputedStyle( node );
					return names.map( name => css.getPropertyValue( name ) );
				}, properties );
			};
			const expected = await measure( width < 1200 ? mobile : desktop );
			if ( width < 1200 && expectedPhone ) expect( expected ).toEqual( expectedPhone );
			expect( await measure( assembled ), `computed styles at ${ width }px` ).toEqual( expected );
		}
	} finally { await browser.close(); }
}

it( 'keeps body styles single-owned and width-local in dual assembly (#1312)', async () => {
	const desktop = page( '<style>.frame{width:1440px}</style><div class="frame"><p>Desktop</p><nav>a</nav></div>' );
	const mobile = page( '<style>.frame{width:402px}</style><div class="frame"><p>Phone</p><button>menu</button></div>' );
	const assembled = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
	expect( assembled.evidence?.outcome ).toBe( 'dual-structural' );
	const $ = cheerio.load( assembled.html );
	expect( $( 'style' ).filter( ( _, node ) => $( node ).text().includes( 'width:1440px' ) ) ).toHaveLength( 1 );
	expect( $( 'style' ).filter( ( _, node ) => $( node ).text().includes( 'width:402px' ) ) ).toHaveLength( 1 );
	const browser = await chromium.launch();
	try {
		const tab = await browser.newPage();
		await tab.setContent( assembled.html );
		for ( const [ width, expected ] of [ [ 1440, '1440px' ], [ 390, '402px' ] ] as const ) {
			await tab.setViewportSize( { width, height: 900 } );
			expect( await tab.locator( '.frame:visible' ).evaluate( node => getComputedStyle( node ).width ) ).toBe( expected );
		}
	} finally { await browser.close(); }
} );

it.each( [ false, true ] )( 'scopes body styles after single-document projection (subset=%s)', subset => {
	const desktop = page( '<style>.frame{width:1440px}</style><main id="frame" class="frame" style="height:40px">Content</main>' );
	const mobile = page( `<style>.frame{width:402px}</style><main id="frame" class="frame" style="height:20px">Content</main>${ subset ? '<aside id="phone">Phone</aside>' : '' }` );
	const assembled = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
	expect( assembled.evidence?.outcome ).toBe( subset ? 'collapsed-identity-subset' : 'collapsed-equivalent' );
	const $ = cheerio.load( assembled.html );
	const desktopStyles = $( 'style' ).filter( ( _, node ) => $( node ).text().includes( 'width:1440px' ) );
	expect( desktopStyles ).toHaveLength( 1 );
	expect( desktopStyles.attr( 'media' ) ).toBe( '(min-width:768px)' );
} );

describe( 'counterpart stylesheet deltas (#1286)', () => {
	it( 'replays only alias-changed nodes from byte-identical Framer SSR sheets', async () => {
		const common = '.framer-84zrh{display:flex;gap:40px;width:900px;height:90px}.framer-1vf3dh3{width:1px}';
		const variant = '.framer-84zrh.framer-v-13gjlia{gap:24px;width:390px;height:76px}' +
			'.framer-84zrh.framer-v-13gjlia .framer-1vf3dh3{flex:0 0 auto;width:100%}' +
			'@supports (display:flex){.framer-84zrh.framer-v-13gjlia{align-items:center}}' +
			'.framer-84zrh.framer-v-13gjlia .logo{height:20px}';
		// Common nodes after the aliased rules must not inflate the replay.
		const tail = '@media (min-width:300px){.unrelated{color:green}}.unrelated{padding:4px}';
		const head = `<style data-framer-css-ssr-minified>${ common + variant + tail }</style>`;
		const markup = ( classes: string ) => `<main id="header" class="framer-84zrh ${ classes }"><a id="logo" class="framer-1vf3dh3 logo">Logo</a></main>`;
		const desktop = page( markup( 'framer-v-desktop' ), head );
		const mobile = page( markup( 'framer-v-13gjlia' ).replace( '</main>', '<span id="phone-only">Phone menu</span></main>' ), head );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile, switchWidth: 1199 } );
		expect( result.hasMobileDocument ).toBe( false );
		const $ = cheerio.load( result.html );
		const alias = $( '#header' ).attr( 'class' )!.split( /\s+/ ).find( token => token.startsWith( 'data-blocks-engine-capture-responsive-class-' ) );
		expect( alias ).toBeDefined();
		expect( $( 'style[media="(max-width:1199px)"]' ).text() ).toBe( variant.replaceAll( 'framer-v-13gjlia', alias! ) );
		expect( $( 'style:not([media])' ).text() ).toContain( common + variant + tail );
		await expectStylesheetParity( desktop, mobile, result.html, [ 'gap', 'width', 'height' ], [ '24px', '390px', '76px' ] );
		await expectStylesheetParity( desktop, mobile, result.html, [ 'width' ], [ '390px' ], '#logo' );
	} );
	it.each( [
		{ name: 'desktop duplicate keys', desktop: '.a{margin:0}.a{margin:0}', mobile: '.a{margin:0}', attributes: '' },
		{ name: 'phone duplicate keys', desktop: '.a{margin:0}', mobile: '.a{margin:0}.a{margin:0}', attributes: '' },
		{ name: 'reordered common nodes', desktop: '.a{margin:0}@media (min-width:300px){.b{padding:0}}', mobile: '@media (min-width:300px){.b{padding:0}}.a{margin:0}', attributes: '' },
		{ name: 'unaligned sheet layout', desktop: '.a{margin:0}', mobile: '.a{margin:0}', attributes: ' data-other' },
		... [ '@import "a.css";', '@layer base;', '@layer base{.b{padding:0}}', '@charset "UTF-8";' ].map( rule => ( {
			name: rule, desktop: `${ rule }.a{margin:0}`, mobile: `${ rule }.a{margin:0}`, attributes: '',
		} ) ),
	] )( 'retains full replay for $name', ( { desktop: base, mobile: phone, attributes } ) => {
		const desktop = page( '<main>Hello</main>', `<style>${ base }.target{color:red}</style>` );
		const mobileCss = `${ phone }.target{color:blue}`;
		const mobile = page( '<main>Hello</main>', `<style${ attributes }>${ mobileCss }</style>` );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const $ = cheerio.load( result.html );
		expect( $( 'style[media="(max-width:767px)"]' ).text() ).toBe( mobileCss );
	} );

	it( 'keeps later common rules after a mobile delta, including overlapping selectors', () => {
		const desktopCss = '.common{margin:0}.target{color:red}.target.special{color:green}';
		const mobileCss = '.common{margin:0}.target{color:blue}.target.special{color:green}';
		const desktop = page( '<main class="target special common">Hello</main>', `<style>${ desktopCss }</style>` );
		const mobile = page( '<main class="target special common">Hello</main>', `<style>${ mobileCss }</style>` );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile } );
		const $ = cheerio.load( result.html );
		expect( $( 'style[media="(max-width:767px)"]' ).text() ).toBe( '.target{color:blue}.target.special{color:green}' );
	} );

	it( 'measures the Framer SSR replay and preserves computed styles', async () => {
		const common = Array.from( { length: 9 }, ( _, i ) => [
			`.rule-${ i }{margin-left:${ i }px}`,
			`@supports not (color:color(display-p3 1 1 1)){.rule-${ i }{color:rgb(1,2,3)}}`,
			`@media (min-width:${ 200 + i * 10 }px){.rule-${ i }{border-left-width:${ i }px}}`,
		].join( '' ) ).join( '' ) + '@font-face{font-family:fixture;src:local(Arial)}@keyframes fixture{from{opacity:0}to{opacity:1}}';
		const desktopCss = `${ common }.target{color:red}.added{padding:3px}@media (min-width:300px){.target{letter-spacing:1px}}`;
		const delta = '.target{color:blue}.added{padding:7px}@media (min-width:300px){.target{letter-spacing:2px}}';
		const mobileCss = common + delta;
		const links = '<link rel="stylesheet" href="https://fixture.test/a.css"><link rel="stylesheet" href="https://fixture.test/b.css">';
		const markup = '<main class="target added rule-4">Hello</main>';
		const desktop = page( markup, `${ links }<style data-framer-css-ssr-minified>${ desktopCss }</style>` );
		const mobile = page( markup, `${ links }<style data-framer-css-ssr-minified>${ mobileCss }</style>` );
		const result = assembleResponsiveCapture( { rawDesktopHtml: desktop, rawMobileHtml: mobile, portableDesktopHtml: desktop, portableMobileHtml: mobile, switchWidth: 1199 } );
		const $ = cheerio.load( result.html );
		const phoneCss = $( 'style[media="(max-width:1199px)"]' ).text();
		// Only the two changed flat rules and changed media block replay;
		// identical conditional blocks, font faces and keyframes stay common.
		expect( phoneCss ).toBe( delta );
		expect( Buffer.byteLength( phoneCss ) ).toBeLessThan( Buffer.byteLength( mobileCss ) / 10 );
		expect( $( 'link' ) ).toHaveLength( 2 );
		await expectStylesheetParity( desktop, mobile, result.html, [ 'color', 'padding', 'margin-left', 'font-size', 'letter-spacing' ], [ 'rgb(0, 0, 255)', '7px', '4px', '18px', '2px' ] );
	} );
} );

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

	it.each( [
		{ matching: true, outcome: 'collapsed-identity-subset' },
		{ matching: false, outcome: 'dual-structural' },
	] )( 'discovers position identities only when values overlap ($matching)', ( { matching, outcome } ) => {
		const rawDesktop = page( '<main data-position="0"><div class="wide"><h1 data-position="1">Shared heading</h1><p data-position="2">Shared paragraph</p></div></main>' );
		const rawMobile = page( `<main data-position="${ matching ? 0 : 10 }"><section class="narrow"><h1 data-position="${ matching ? 1 : 11 }">Shared heading</h1><p data-position="${ matching ? 2 : 12 }">Shared paragraph</p></section></main>` );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence?.outcome ).toBe( outcome );
		if ( matching ) {
			expect( assembly.evidence ).toMatchObject( { matchedNodes: 3, desktopOnlyElements: 0, mobileOnlyElements: 0 } );
			const $ = cheerio.load( assembly.html );
			expect( $( 'body' ).text().match( /Shared heading/g ) ).toHaveLength( 1 );
			expect( $( 'body' ).text().match( /Shared paragraph/g ) ).toHaveLength( 1 );
		}
	} );

	it( 'swaps id-less chrome per device and pairs components by attribute when an id is one-sided', () => {
		const card = ( id: string, text: string, own = '' ) =>
			`<section data-card-id="${ id }"${ own }><div class="frame"><p data-pos="${ id }">${ text }</p></div></section>`;
		// Cards carry most of the text, so their attributes are discovered identities.
		const cards = 'bcdefghijk'.split( '' ).map( id => card( id, `Card ${ id }` ) ).join( '' );
		const rawDesktop = page(
			'<nav><img class="logo" src="/logo.png" alt=""><div class="links"><a href="#a">News</a></div></nav>' +
			card( 'a', 'First card', ' id="card-a"' ) + cards + '<div></div>'
		);
		const rawMobile = page(
			'<div><div class="doc-background"></div></div>' +
			'<nav><img class="logo" src="/logo.png" alt=""><button class="toggle" aria-label="Menu"></button></nav>' +
			card( 'a', 'First card' ) + cards + '<div></div>'
		);
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		evidenceMatchesTree( assembly );
		expect( assembly.evidence?.outcome ).toBe( 'collapsed-identity-subset' );
		const $ = cheerio.load( assembly.html );
		expect( $( 'body' ).text().match( /First card/g ) ).toHaveLength( 1 );
		expect( $( 'nav' ) ).toHaveLength( 1 );
		expect( $( 'nav > .links.data-blocks-engine-capture-desktop-only' ) ).toHaveLength( 1 );
		expect( $( 'nav > .toggle.data-blocks-engine-capture-mobile-only' ) ).toHaveLength( 1 );
		// The phone's leading background stays ahead of the content, not at
		// the later desktop position that happens to share its shape.
		expect( $( 'body > .data-blocks-engine-capture-mobile-only:has(> .doc-background) + nav' ) ).toHaveLength( 1 );
	} );

	it( 'keeps class tokens only one rendering of a shared element carries width-local', async () => {
		// The phone rendering adds `shown`, which desktop also uses elsewhere;
		// only the desktop rendering carries the styled `wide`.
		const styles = '<style>.wide{width:300px}.shown{color:rgb(0, 128, 0)}</style>';
		const cards = 'bcdefghijk'.split( '' ).map( id => `<section data-card-id="${ id }"><p data-pos="${ id }" class="${ id === 'b' ? 'shown' : '' }">Card ${ id }</p></section>` ).join( '' );
		const target = ( classes: string ) => `<section data-card-id="a"><p data-pos="a" class="${ classes }">Target</p></section>`;
		const rawDesktop = page( '<nav class="links"></nav>' + target( 'copy wide' ) + cards, styles );
		const rawMobile = page( target( 'copy shown' ) + cards, styles );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: rawDesktop,
			rawMobileHtml: rawMobile,
			portableDesktopHtml: rawDesktop,
			portableMobileHtml: rawMobile,
		} );
		expect( assembly.evidence?.outcome ).toBe( 'collapsed-identity-subset' );
		const browser = await chromium.launch();
		try {
			const tab = await browser.newPage();
			for ( const [ width, source ] of [ [ 390, rawMobile ], [ 1440, rawDesktop ] ] as const ) {
				await tab.setViewportSize( { width, height: 900 } );
				const measure = async ( html: string ) => {
					await tab.setContent( html );
					return Promise.all( [ '[data-pos="a"]', '[data-pos="b"]' ].map( selector =>
						tab.locator( selector ).evaluate( node => [ getComputedStyle( node ).width, getComputedStyle( node ).color ] ) ) );
				};
				expect( await measure( assembly.html ), `computed styles at ${ width }px` ).toEqual( await measure( source ) );
			}
		} finally { await browser.close(); }
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

	it( 'keeps phone navigation visible when body negates a relocated device class', async () => {
		const css = '.toggle{display:flex} body:not(.phone-nav) .toggle{display:none}' +
			'body.page:not(.phone-nav,.unused) .listed{display:none}' +
			'body.phone-nav:not(.desktop-nav) .mixed{color:rgb(0,128,0)} body.page{--shared:kept}';
		const markup = '<nav><button class="toggle listed mixed">Menu</button></nav>';
		const inlineHead = `<style>${ css }</style>`;
		const linkedHead = '<link rel="stylesheet" href="https://example.com/layout.css">';
		const exports = [
			exportPair( page( markup, inlineHead, ' class="page"' ), page( markup, inlineHead, ' class="page phone-nav"' ) ),
			exportPair( page( markup, linkedHead, ' class="page"' ), page( `<section>${ markup }</section>`, linkedHead, ' class="page phone-nav"' ), css ),
		];
		const browser = await chromium.launch();
		try {
			const copy = await browser.newPage();
			for ( const exported of exports ) {
				const $ = cheerio.load( exported.html );
				const href = $( 'link[rel="stylesheet"]' ).attr( 'href' );
				if ( href ) {
					const emittedCss = readFileSync( join( dirs[ dirs.length - 1 ], 'website', href.replace( /^\//, '' ) ), 'utf8' );
					$( 'link[rel="stylesheet"]' ).replaceWith( `<style>${ emittedCss }</style>` );
					expect( emittedCss ).toContain( 'body.page{--shared:kept}' );
				}
				await copy.setContent( $.html() );
				await copy.setViewportSize( { width: 390, height: 800 } );
				const phone = copy.locator( `.${ MOBILE_DOCUMENT_CLASS } .toggle` );
				expect( await phone.isVisible() ).toBe( true );
				expect( await phone.evaluate( node => ( { display: getComputedStyle( node ).display, color: getComputedStyle( node ).color } ) ) ).toEqual( { display: 'flex', color: 'rgb(0, 128, 0)' } );
				await copy.setViewportSize( { width: 1440, height: 900 } );
				expect( await copy.locator( `.${ DESKTOP_DOCUMENT_CLASS } .toggle` ).evaluate( node => getComputedStyle( node ).display ) ).toBe( 'none' );
			}
		} finally {
			await browser.close();
		}
	} );

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
