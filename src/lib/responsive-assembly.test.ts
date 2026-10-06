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

	it( 'uses the shared stray delimiter recovery during identity projection', () => {
		const projected = projectResponsiveIdentityCss( '#target { --shadow: 0px;); --width: 1px; ]; color: red }', new Map( [ [ 'target', 'phone-target' ] ] ), false );
		expect( projected ).toContain( ':is(#target,#phone-target)' );
		expect( projected ).toContain( '--width: 1px' );
		expect( projected ).toContain( 'color: red' );
	} );

	it( 'preserves valid CSS exactly and rejects unsupported syntax', () => {
		const css = '.x { color: red !important; content: "!important" }';
		expect( projectResponsiveIdentityCss( css, new Map(), false ) ).toBe( css );
		expect( () => projectResponsiveIdentityCss( '.x { color: red; broken; opacity: .5 }', new Map(), false ) ).toThrow();
	} );
} );

afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function page( body: string, head = '', bodyAttributes = '' ): string {
	return `<html><head>${ head }</head><body${ bodyAttributes }>${ body }</body></html>`;
}

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
			expect( capturedDesktop ).toContain( 'data-dla-fluid-rules' );
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
		expect( $( '#comp-phone.data-liberation-mobile-only' ) ).toHaveLength( 1 );
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
	function exportPair( desktop: string, mobile?: string ): { html: string; receipt: { routes: Array< { responsiveVariants?: { outcome: string; variants: number } } > }; profile: { variants: string; documentsPerRoute: number } } {
		const outputDir = mkdtempSync( join( tmpdir(), 'dla-responsive-assembly-' ) );
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
