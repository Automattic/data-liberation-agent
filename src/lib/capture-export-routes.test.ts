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
