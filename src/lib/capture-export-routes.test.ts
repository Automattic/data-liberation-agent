import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allocateCaptureRoutes, type RouteEntry } from './capture-export-routes.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function entry( dir: string, filename: string, url: string, html: string ): RouteEntry {
	const htmlPath = join( dir, filename );
	writeFileSync( htmlPath, html );
	return { url, htmlPath, jsonLd: [] };
}

describe( 'capture export route stage', () => {
	it( 'allocates distinct query routes deterministically without claiming authored filenames', () => {
		mkdirSync( '.tmp-test', { recursive: true } );
		const dir = mkdtempSync( join( '.tmp-test', 'dla-query-routes-' ) );
		dirs.push( dir );
		const home = entry( dir, 'home.html', 'https://example.com/', '<h1>Home</h1>' );
		const base = entry( dir, 'base.html', 'https://example.com/catalog/', '<h1>All</h1>' );
		const red = entry( dir, 'red.html', 'https://example.com/catalog/?color=red', '<h1>Red</h1>' );
		const blue = entry( dir, 'blue.html', 'https://example.com/catalog/?color=blue%26green', '<h1>Blue</h1>' );
		const authored = entry( dir, 'authored.html', 'https://example.com/catalog/index-query-1.html', '<h1>Authored</h1>' );
		const entries = [ home, red, blue, base, authored ];
		const first = allocateCaptureRoutes( entries, home.url, [
			{ url: 'https://example.com/catalog/?old=red', target: red.url },
		] );
		const second = allocateCaptureRoutes( [ ...entries ].reverse(), home.url, [] );
		const paths = entries.map( ( { url } ) => first.routePathOf( url ) );
		expect( paths ).toEqual( entries.map( ( { url } ) => second.routePathOf( url ) ) );
		expect( new Set( paths ).size ).toBe( entries.length );
		expect( first.routePathOf( base.url ) ).toBe( 'catalog/index.html' );
		expect( first.routePathOf( authored.url ) ).toBe( 'catalog/index-query-1.html' );
		expect( first.canonicalRouteAliases.get( 'https://example.com/catalog?old=red' ) ).toBe( first.routePathOf( red.url ) );
		expect( first.portableRedirects ).toEqual( [] );
	} );

	it( 'selects a query entrypoint without confusing it with other root query pages', () => {
		mkdirSync( '.tmp-test', { recursive: true } );
		const dir = mkdtempSync( join( '.tmp-test', 'dla-query-home-' ) );
		dirs.push( dir );
		const en = entry( dir, 'en.html', 'https://example.com/?lang=en', '<h1>English</h1>' );
		const fr = entry( dir, 'fr.html', 'https://example.com/?lang=fr', '<h1>French</h1>' );
		const routes = allocateCaptureRoutes( [ fr, en ], en.url, [] );
		expect( routes.entrypointEntry ).toBe( en );
		expect( routes.routePathOf( en.url ) ).toBe( 'index.html' );
		expect( routes.routePathOf( fr.url ) ).not.toBe( 'index.html' );
		const base = entry( dir, 'base.html', 'https://example.com/', '<h1>Default language</h1>' );
		const withBase = allocateCaptureRoutes( [ fr, base, en ], en.url, [] );
		expect( withBase.routePathOf( en.url ) ).toBe( 'index.html' );
		expect( withBase.routePathOf( base.url ) ).not.toBe( 'index.html' );
	} );

	it( 'collapses canonical aliases of a query rendition onto its allocated path', () => {
		mkdirSync( '.tmp-test', { recursive: true } );
		const dir = mkdtempSync( join( '.tmp-test', 'dla-query-canonical-' ) );
		dirs.push( dir );
		const home = entry( dir, 'home.html', 'https://example.com/', '<h1>Home</h1>' );
		const base = entry( dir, 'base.html', 'https://example.com/catalog/', '<h1>All</h1>' );
		const red = entry( dir, 'red.html', 'https://example.com/catalog/?tag=red', '<h1>Red</h1>' );
		const alias = { ...entry( dir, 'alias.html', `${ red.url }&ref=nav`, '<h1>Red</h1>' ), canonicalUrl: red.url };
		const routes = allocateCaptureRoutes( [ home, base, red, alias ], home.url, [] );
		expect( routes.routePathOf( alias.url ) ).toBe( routes.routePathOf( red.url ) );
		expect( routes.retainedEntries ).toEqual( [ home, base, red ] );
		expect( routes.duplicateRoutes ).toEqual( [ { url: alias.url, canonicalUrl: red.url, path: `website/${ routes.routePathOf( red.url ) }` } ] );
	} );

	it( 'retains a canonical query alias when it is the selected entrypoint', () => {
		mkdirSync( '.tmp-test', { recursive: true } );
		const dir = mkdtempSync( join( '.tmp-test', 'dla-query-alias-' ) );
		dirs.push( dir );
		const base = entry( dir, 'base.html', 'https://example.com/', '<h1>Home</h1>' );
		const alias = { ...entry( dir, 'alias.html', 'https://example.com/?ref=nav', '<h1>Home</h1>' ), canonicalUrl: base.url };
		const routes = allocateCaptureRoutes( [ base, alias ], alias.url, [] );
		expect( routes.retainedEntries ).toEqual( [ alias ] );
		expect( routes.duplicateRoutes ).toEqual( [ { url: base.url, canonicalUrl: alias.url, path: 'website/index.html' } ] );
	} );

	it( 'returns the selected entrypoint document for later media selection and preserves redirects to allocated pages', () => {
		mkdirSync( '.tmp-test', { recursive: true } );
		const dir = mkdtempSync( join( '.tmp-test', 'dla-route-stage-' ) );
		dirs.push( dir );
		const root = entry( dir, 'root.html', 'https://example.com/', '<h1>Home</h1>' );
		const defaultDocument = entry( dir, 'default.html', 'https://example.com/index.html', '<h1>Different</h1>' );
		const routes = allocateCaptureRoutes( [ defaultDocument, root ], root.url, [
			{ url: 'https://example.com/old', target: defaultDocument.url },
		] );
		expect( routes.entrypointEntry ).toBe( root );
		expect( routes.entrypointUrl ).toBe( root.url );
		expect( routes.retainedEntries ).toEqual( [ root, defaultDocument ] );
		expect( routes.routePathOf( root.url ) ).toBe( 'index.html' );
		expect( routes.routePathOf( defaultDocument.url ) ).toBe( 'index-2.html' );
		expect( routes.canonicalRouteAliases.get( 'https://example.com/old' ) ).toBe( 'index-2.html' );
		expect( routes.portableRedirects ).toEqual( [ { from: '/old', to: '/index-2.html' } ] );
		expect( routes.duplicateRoutes ).toEqual( [
			{ url: 'https://example.com/old', canonicalUrl: defaultDocument.url, path: 'website/index-2.html' },
		] );
	} );
} );
