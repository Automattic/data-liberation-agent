import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { checkSelfConsistency } from '../../lib/fidelity/self-consistency.js';
import { canonicalizeWixCapturedHtml, wixStylesheetNames } from './instance-ids.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

const ORIGIN = 'https://example.com';
const IMPORT = /@import\s*(?:url\(\s*)?["']?([^"')\s;]+)/g;

// One header under a page-specific instance prefix. Two badge instances scope
// the same component, so capture keeps every page as captured. Each page
// stylesheet styles all of the header's components.
const pageStyle = ( instance: string, extra = '' ) => '<style>' +
	`#${ instance }{position:sticky}` +
	`#${ instance }_r_comp-menu{display:flex}` +
	`.${ instance }_r_comp-item{color:rgb(1,2,3)}` +
	`.${ instance }_r_comp-cart{display:none}` +
	'.comp-bbbb2222_r_comp-badge{width:10px}' +
	'.comp-cccc3333_r_comp-badge{width:20px}' +
	`${ extra }</style>`;
const header = ( instance: string ) =>
	`<header id="${ instance }"><div id="bgLayers_${ instance }_r_comp-menu"></div><nav id="${ instance }_r_comp-menu"><a class="${ instance }_r_comp-item" href="/">Home</a> <a class="${ instance }_r_comp-item" href="/blog/">Blog</a></nav></header>`;
const route = ( instance: string, style: string, title: string, head = '', body = '' ) =>
	`<!DOCTYPE html><html><head>${ style }${ head }</head><body>${ header( instance ) }<main><h1>${ title }</h1>${ body }</main></body></html>`;

interface Route { url: string; slug: string; html: string }
interface ExportedRoute { html: string; loadedCss: string }

function exportRoutes( routes: Route[], resources: Record< string, string > = {} ): Record< string, ExportedRoute > {
	const outputDir = mkdtempSync( join( tmpdir(), 'liberation-wix-export-instance-ids-' ) );
	dirs.push( outputDir );
	mkdirSync( join( outputDir, 'html' ), { recursive: true } );
	mkdirSync( join( outputDir, 'screenshots' ), { recursive: true } );
	const entries: Record< string, { slug: string; html: string } > = {};
	for ( const { url, slug, html } of routes ) {
		writeFileSync( join( outputDir, 'html', `${ slug }.html` ), html );
		entries[ url ] = { slug, html: `html/${ slug }.html` };
	}
	writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries } ) );
	if ( Object.keys( resources ).length ) {
		mkdirSync( join( outputDir, 'resources' ), { recursive: true } );
		const manifest: Record< string, { path: string; contentType: string } > = {};
		Object.entries( resources ).forEach( ( [ url, css ], index ) => {
			writeFileSync( join( outputDir, 'resources', `${ index }.css` ), css );
			manifest[ url ] = { path: `resources/${ index }.css`, contentType: 'text/css' };
		} );
		writeFileSync( join( outputDir, 'resources', 'manifest.json' ), JSON.stringify( { version: 1, resources: manifest, failures: [] } ) );
	}
	exportWebsiteCapture( { outputDir, sourceUrl: `${ ORIGIN }/`, platform: 'wix', canonicalizeHtml: canonicalizeWixCapturedHtml, stylesheetNames: wixStylesheetNames, summary: {}, failures: [] } );
	const website = join( outputDir, 'website' );
	const resolveIncludes = ( html: string ) => html.replace( /<!--#include virtual="([^"]+)" -->/g, ( _match, path: string ) => readFileSync( join( website, path ), 'utf8' ) );
	// Every stylesheet the page loads: inline, linked, and imported from either.
	const loaded = ( html: string ): string => {
		const seen = new Set< string >();
		const sheets: string[] = [];
		const visit = ( path: string ) => {
			if ( seen.has( path ) ) return;
			seen.add( path );
			const css = readFileSync( join( website, path ), 'utf8' );
			sheets.push( css );
			for ( const [ , imported ] of css.matchAll( IMPORT ) ) visit( new URL( imported!, `${ ORIGIN }${ path }` ).pathname );
		};
		for ( const [ , css ] of html.matchAll( /<style[^>]*>([\s\S]*?)<\/style>/g ) ) {
			sheets.push( css! );
			for ( const [ , imported ] of css!.matchAll( IMPORT ) ) visit( new URL( imported!, ORIGIN ).pathname );
		}
		for ( const [ , href ] of html.matchAll( /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g ) ) visit( href! );
		return sheets.join( '\n' );
	};
	return Object.fromEntries( routes.map( ( { url } ) => {
		const path = new URL( url ).pathname;
		const html = resolveIncludes( readFileSync( join( website, path, 'index.html' ), 'utf8' ) );
		return [ path, { html, loadedCss: loaded( html ) } ];
	} ) );
}

function headerOf( html: string ): string {
	return /<header[\s\S]*?<\/header>/.exec( html )?.[ 0 ] ?? '';
}

/** The header's instance-scoped ids, each selected by a rule the page loads. */
function expectStyledHeader( { html, loadedCss }: ExportedRoute ): void {
	const menu = /<nav id="([^"]+)"/.exec( headerOf( html ) )?.[ 1 ];
	const item = /<a class="([^"]+)"/.exec( headerOf( html ) )?.[ 1 ];
	expect( loadedCss ).toContain( `#${ menu }{display:flex}` );
	expect( loadedCss ).toContain( `.${ item }{color:rgb(1,2,3)}` );
}

describe( 'Wix export canonicalization with linked page stylesheets', () => {
	it( 'keeps every route on the names the stylesheets it loads use', () => {
		// The blog index and a tag page share one page stylesheet, which export
		// hoists into one linked file; the home page keeps its own inline.
		const blogStyle = pageStyle( 'comp-blog0001', '.blog-feed{gap:1px}' );
		const home = route( 'comp-home0001', pageStyle( 'comp-home0001', '.hero{gap:2px}' ), 'Home' );
		expect( canonicalizeWixCapturedHtml( home ) ).toBe( home );
		const exported = exportRoutes( [
			{ url: `${ ORIGIN }/`, slug: 'homepage', html: home },
			{ url: `${ ORIGIN }/blog/`, slug: 'blog', html: route( 'comp-blog0001', blogStyle, 'Blog' ) },
			{ url: `${ ORIGIN }/blog/tags/news/`, slug: 'blog--tags--news', html: route( 'comp-blog0001', blogStyle, 'News' ) },
		] );
		for ( const page of Object.values( exported ) ) expectStyledHeader( page );
		expect( exported[ '/blog/' ]!.html ).toMatch( /<link[^>]*rel="stylesheet"[^>]*href="\/assets\/css\/capture-[0-9a-f]+\.css"/ );
		expect( headerOf( exported[ '/blog/' ]!.html ) ).toBe( headerOf( exported[ '/blog/tags/news/' ]!.html ) );
		expect( exported[ '/blog/' ]!.loadedCss ).toContain( '.comp-bbbb2222_r_comp-badge{width:10px}' );
	} );

	it( 'keeps an id a stylesheet selects on every route, so fragment links into it resolve', () => {
		// Both routes hold the same section instance. Only the target loads a
		// stylesheet that selects it; the other route links to it by fragment.
		const style = '<style>#comp-aaaa1111_r_comp-menu{display:flex}.comp-aaaa1111_r_comp-item{color:rgb(1,2,3)}</style>';
		const section = '<section id="comp-bbbb2222"><p class="comp-bbbb2222_r_comp-text">Offer</p></section>';
		const exported = exportRoutes( [
			{ url: `${ ORIGIN }/`, slug: 'homepage', html: route( 'comp-aaaa1111', style, 'Home', '', `${ section }<a href="/target/#comp-bbbb2222">See the offer</a>` ) },
			{ url: `${ ORIGIN }/target/`, slug: 'target', html: route( 'comp-aaaa1111', style, 'Target', '<link rel="stylesheet" href="https://example.com/offer.css">', section ) },
		], { [ `${ ORIGIN }/offer.css` ]: '#comp-bbbb2222{border:1px solid}' } );
		expect( exported[ '/target/' ]!.html ).toContain( '<section id="comp-bbbb2222">' );
		expect( exported[ '/target/' ]!.loadedCss ).toContain( '#comp-bbbb2222{border:1px solid}' );
		expect( exported[ '/' ]!.html ).toContain( '#comp-bbbb2222"' );
		const report = checkSelfConsistency( join( dirs.at( -1 )!, 'website' ), new Map( [ [ '/', 'index.html' ], [ '/target/', 'target/index.html' ] ] ) );
		expect( report.findings.filter( finding => finding.kind === 'anchor-missing' ) ).toEqual( [] );
	} );

	it( 'renames the other instances when one new name is taken, so fragment links into them resolve', () => {
		// The home page's second instance would take a name a stylesheet on the
		// target already selects. Only that instance keeps its captured name; the
		// shared section is renamed the same way on both routes.
		const style = '<style>#comp-aaaa1111_r_comp-menu{display:flex}.comp-aaaa1111_r_comp-item{color:rgb(1,2,3)}</style>';
		const section = '<section id="comp-bbbb2222"><nav class="comp-bbbb2222_r_comp-nav">Offer</nav></section>';
		const taken = canonicalizeWixCapturedHtml( '<p class="comp-other_r_comp-other"></p>' ).match( /comp-dla[0-9a-f]{8}/ )![ 0 ];
		const exported = exportRoutes( [
			{ url: `${ ORIGIN }/`, slug: 'homepage', html: route( 'comp-aaaa1111', style, 'Home', '', `${ section }<p class="comp-other_r_comp-other">Other</p><a href="/target/#comp-bbbb2222">See the offer</a>` ) },
			{ url: `${ ORIGIN }/target/`, slug: 'target', html: route( 'comp-aaaa1111', style, 'Target', '<link rel="stylesheet" href="https://example.com/offer.css">', section ) },
		], { [ `${ ORIGIN }/offer.css` ]: `.${ taken }{color:rgb(9,9,9)}` } );
		expect( exported[ '/' ]!.html ).toContain( 'class="comp-other_r_comp-other"' );
		const target = /<section id="(comp-dla[0-9a-f]{8})">/.exec( exported[ '/target/' ]!.html )?.[ 1 ];
		expect( target ).toBeDefined();
		expect( exported[ '/' ]!.html ).toContain( `#${ target }"` );
		const report = checkSelfConsistency( join( dirs.at( -1 )!, 'website' ), new Map( [ [ '/', 'index.html' ], [ '/target/', 'target/index.html' ] ] ) );
		expect( report.findings.filter( finding => finding.kind === 'anchor-missing' ) ).toEqual( [] );
	} );

	it( 'keeps the names of instances that imported stylesheets select', () => {
		const style = pageStyle( 'comp-aaaa1111' );
		const imports = '<link rel="stylesheet" href="https://example.com/theme.css">' +
			'<style media="all">@import url("https://example.com/narrow.css") (max-width: 760px);</style>';
		const body = '<section class="comp-eeee5555_r_comp-hero">Hero</section><aside class="comp-ffff6666_r_comp-note">Note</aside><b class="comp-gggg7777_r_comp-tag">Tag</b>';
		const exported = exportRoutes( [
			{ url: `${ ORIGIN }/`, slug: 'homepage', html: route( 'comp-aaaa1111', style, 'Home', imports, body ) },
			{ url: `${ ORIGIN }/about/`, slug: 'about', html: route( 'comp-aaaa1111', style, 'About', imports, body ) },
		], {
			[ `${ ORIGIN }/theme.css` ]: '@import url("parts/hero.css");@import"/compact.css";',
			[ `${ ORIGIN }/compact.css` ]: '.comp-gggg7777_r_comp-tag{color:rgb(1,1,1)}',
			[ `${ ORIGIN }/parts/hero.css` ]: '.comp-eeee5555_r_comp-hero{color:rgb(4,5,6)}',
			[ `${ ORIGIN }/narrow.css` ]: '.comp-ffff6666_r_comp-note{color:rgb(7,8,9)}',
		} );
		for ( const page of Object.values( exported ) ) {
			expectStyledHeader( page );
			expect( page.html ).toContain( 'class="comp-eeee5555_r_comp-hero"' );
			expect( page.loadedCss ).toContain( '.comp-eeee5555_r_comp-hero{color:rgb(4,5,6)}' );
			expect( page.html ).toContain( 'class="comp-ffff6666_r_comp-note"' );
			expect( page.loadedCss ).toContain( '.comp-ffff6666_r_comp-note{color:rgb(7,8,9)}' );
			expect( page.html ).toContain( 'class="comp-gggg7777_r_comp-tag"' );
			expect( page.loadedCss ).toContain( '.comp-gggg7777_r_comp-tag{color:rgb(1,1,1)}' );
		}
	} );
} );
