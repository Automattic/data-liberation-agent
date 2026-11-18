import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extractSharedChrome } from './shared-chrome.js';

it( 'counts each source path once when admitting exact shared regions', () => {
	const root = mkdtempSync( join( tmpdir(), 'liberation-chrome-source-paths-' ) );
	try {
		// Two copies cannot pay for this part and two include directives. A
		// duplicate caller path must not invent a third occurrence or replacement.
		const header = `<header><nav>${ 'Source '.repeat( 25 ) }</nav></header>`;
		const html = `<!doctype html><html><body>${ header }<main>Content</main></body></html>`;
		for ( const path of [ 'index.html', 'about.html' ] ) writeFileSync( join( root, path ), html );
		extractSharedChrome( root, [ 'index.html', 'index.html', 'about.html' ] );
		expect( existsSync( join( root, 'parts' ) ) ).toBe( false );
		for ( const path of [ 'index.html', 'about.html' ] ) expect( readFileSync( join( root, path ), 'utf8' ) ).toBe( html );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );

it( 'keeps one landmark structure when route copies differ only in route-local attributes', () => {
	const root = mkdtempSync( join( tmpdir(), 'liberation-chrome-route-local-' ) );
	try {
		// Issue #1949: the current item moves per route and per-document node ids
		// shift. Exact-byte grouping shared different subtrees on each route, and
		// replaced the whole header on routes whose bytes happened to coincide.
		const items = [ 'home', 'about', 'rates', 'contact' ];
		const header = ( current: string, offset: number ) => `<header data-blocks-engine-node-id="n${ offset }"><nav>${ items.map( ( item, index ) =>
			`<div class="item"${ item === current ? ' aria-current="true"' : '' } data-blocks-engine-node-id="n${ offset + index + 1 }"><a href="/${ item }/"${ item === current ? ' aria-selected="true"' : '' }>${ item } ${ 'label '.repeat( 20 ) }</a></div>` ).join( '' ) }</nav></header>`;
		const routes: Record< string, string > = {
			'index.html': header( 'home', 1 ), 'trauma.html': header( 'home', 1 ), 'about.html': header( 'about', 1 ),
			'rates.html': header( 'rates', 1 ), 'privacy.html': header( '', 2 ), 'terms.html': header( '', 2 ),
		};
		for ( const [ path, chrome ] of Object.entries( routes ) ) writeFileSync( join( root, path ), `<!doctype html><html><body>${ chrome }<main>${ path }</main></body></html>` );
		extractSharedChrome( root, Object.keys( routes ) );
		const neutral = Object.keys( routes ).map( path => {
			const html = readFileSync( join( root, path ), 'utf8' );
			const start = html.indexOf( '<header' );
			expect( start, path ).toBeGreaterThanOrEqual( 0 );
			return html.slice( start, html.indexOf( '</header>', start ) ).replace( / (?:data-blocks-engine-node-id|aria-current|aria-selected)="[^"]*"/g, '' );
		} );
		expect( new Set( neutral ).size ).toBe( 1 );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );

const currentStateRoutes = ( activeFor: ( route: string ) => string ) => {
	// Issue #1985: the served item is marked by a class token as well as
	// aria-current, so only the root and its home alias are byte-identical.
	const items = [ 'home', 'services', 'team' ];
	const header = ( current: string ) => `<header class="site-header"><nav class="header-nav">${ items.map( item =>
		`<div class="header-nav-item${ item === current ? ' header-nav-item--active' : '' }"><a href="/${ item }/"${ item === current ? ' aria-current="page"' : '' }>${ item } ${ 'label '.repeat( 20 ) }</a></div>` ).join( '' ) }</nav></header>`;
	const routes: Record< string, string > = {};
	for ( const [ path, route ] of [ [ 'index.html', 'home' ], [ 'home.html', 'home' ], [ 'services.html', 'services' ], [ 'team.html', 'team' ] ] ) {
		routes[ path ] = `<!doctype html><html><body>${ header( activeFor( route ) ) }<main>${ path }</main></body></html>`;
	}
	return routes;
};

it( 'shares no header when route copies differ only in class-marked current state', () => {
	const root = mkdtempSync( join( tmpdir(), 'liberation-chrome-current-class-' ) );
	try {
		const routes = currentStateRoutes( route => route );
		for ( const [ path, html ] of Object.entries( routes ) ) writeFileSync( join( root, path ), html );
		extractSharedChrome( root, Object.keys( routes ) );
		expect( existsSync( join( root, 'parts' ) ) ).toBe( false );
		for ( const [ path, html ] of Object.entries( routes ) ) expect( readFileSync( join( root, path ), 'utf8' ), path ).toBe( html );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );

it( 'still shares a header that is byte-identical on every route', () => {
	const root = mkdtempSync( join( tmpdir(), 'liberation-chrome-identical-' ) );
	try {
		const routes = currentStateRoutes( () => 'home' );
		for ( const [ path, html ] of Object.entries( routes ) ) writeFileSync( join( root, path ), html );
		extractSharedChrome( root, Object.keys( routes ) );
		const parts = readdirSync( join( root, 'parts' ) ).filter( name => /^header-[a-f0-9]+\.html$/.test( name ) );
		expect( parts ).toHaveLength( 1 );
		for ( const path of Object.keys( routes ) ) {
			const html = readFileSync( join( root, path ), 'utf8' );
			expect( html, path ).toContain( `<!--#include virtual="/parts/${ parts[ 0 ] }" -->` );
			expect( html, path ).not.toContain( '<header' );
		}
		expect( readFileSync( join( root, 'parts', parts[ 0 ] ), 'utf8' ) ).toContain( 'header-nav-item--active' );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
