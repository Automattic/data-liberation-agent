import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireHttpDocuments } from './http-acquisition.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import type { HttpAcquisitionProfile } from '../platform/acquisition.js';
import { materializeHttpDocuments } from './http-materialization.js';

const directories: string[] = [];
const source = 'https://acquisition.example/';
const profile: HttpAcquisitionProfile = {
	id: 'neutral-server', variants: [ { id: 'desktop', headers: { 'x-variant': 'desktop' } }, { id: 'mobile', headers: { 'x-variant': 'mobile' } } ],
	prepare: ( html, context ) => /<article(?:\s|>)/.test( html ) ? { html, metadata: { variant: context.variant } } : undefined,
};
function directory() {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'http-acquisition-' ) ); directories.push( root ); return root;
}
afterEach( () => { for ( const root of directories.splice( 0 ) ) rmSync( root, { recursive: true, force: true } ); } );
const dependencies = ( fetchImpl: typeof fetch ) => ( { fetch: ( url: string, options: Parameters<typeof safeFetch>[1] ) => safeFetch( url, { ...options, fetchImpl } ) } );

describe( 'HTTP document acquisition', () => {
	it( 'carries scoped seeds and redirect admission through HTTP export while keeping queries and shared resources', async () => {
		const root = directory();
		const url = `${source}customer`;
		const routeScope = { origin: new URL(source).origin, pathPrefixes: ['/customer'] };
		const fetchImpl = vi.fn<typeof fetch>( async input => {
			const address = String(input);
			if ( address === `${url}/leave` ) return new Response('', {status: 302, headers: {location: '/other/private'}});
			if ( address === `${source}shared/theme.css` ) return new Response('article{color:navy}', {headers: {'content-type': 'text/css'}});
			return new Response(`<link rel="stylesheet" href="/shared/theme.css"><article>${address}</article><a href="/">Platform</a>`, {headers: {'content-type': 'text/html'}});
		} );
		const single = { ...profile, variants: [{id: 'desktop'}] };
		const result = await acquireHttpDocuments( { url, urls: [url, `${url}?view=one`, `${url}?view=two`, `${url}/leave`, source], routeScope, outputDir: root, profile: single, collectAssets: true }, dependencies(fetchImpl) );
		expect( result.coverage ).toEqual( {routes: 4, requiredDocuments: 4, acquired: 3, browserRequired: 0, failed: 1} );
		expect( result.documents.find(document => document.url.endsWith('/leave'))?.error ).toContain('adapter route scope');
		const requested = fetchImpl.mock.calls.map(([input]) => String(input));
		expect( requested ).not.toContain(source);
		expect( requested ).not.toContain(`${source}other/private`);
		expect( requested ).toContain(`${source}shared/theme.css`);
		expect( result.resources ).toMatchObject( {captured: 1, failures: 0} );
		const receipt = JSON.parse( readFileSync( materializeHttpDocuments( {outputDir: root, sourceUrl: url, platform: 'neutral-tenant', routeScope, desktopVariant: 'desktop'} ), 'utf8' ) );
		expect( receipt.source.routeScope ).toEqual(routeScope);
		expect( receipt.routes ).toHaveLength(3);
		expect( new Set(receipt.routes.filter((route: {url: string}) => route.url.includes('?view=')).map((route: {path: string}) => route.path)).size ).toBe(2);
		expect( readFileSync(join(root, 'website/index.html'), 'utf8') ).toContain(`href="${source}"`);
		// HTTP remains an explicitly unverified review candidate, including any failed owned route.
		expect( receipt.summary.complete ).toBe(false);
	} );
	it( 'retains a valid empty stylesheet as a shared no-op dependency', async () => {
		const fetchImpl = vi.fn<typeof fetch>( async input => String( input ).endsWith( '/empty.css' )
			? new Response( '', { headers: { 'content-type': 'text/css' } } )
			: new Response( '<link rel="stylesheet" href="/empty.css"><article>Content</article>', { headers: { 'content-type': 'text/html' } } ) );
		const root = directory();
		const result = await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: root, profile, collectAssets: true }, dependencies( fetchImpl ) );
		expect( result.resources ).toMatchObject( { captured: 1, failures: 0 } );
		const manifest = JSON.parse( readFileSync( join( root, result.resources!.manifestPath ), 'utf8' ) );
		expect( readFileSync( join( root, manifest.resources[ source + 'empty.css' ].path ) ).length ).toBe( 0 );
	} );
	it( 'fetches escaped CSS URLs as actual resources rather than invented local paths', async () => {
		const root = directory();
		const asset = 'https://cdn.example/photo.svg';
		const fetchImpl = vi.fn<typeof fetch>( async input => String( input ) === asset
			? new Response( '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', { headers: { 'content-type': 'image/svg+xml' } } )
			: new Response( String.raw`<article style="background:url(https\:\/\/cdn.example\/photo.svg)">Content</article>`, { headers: { 'content-type': 'text/html' } } ) );
		const result = await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: root, profile, collectAssets: true }, dependencies( fetchImpl ) );
		expect( result.resources ).toMatchObject( { captured: 1, failures: 0 } );
		expect( fetchImpl.mock.calls.filter( ( [ input ] ) => String( input ) === asset ) ).toHaveLength( 1 );
		expect( readFileSync( join( root, result.documents[ 0 ]!.documentPath! ), 'utf8' ) ).toContain( 'https://cdn.example/photo.svg' );
	} );
	it( 'stages shared document dependencies once without inventing a portable-site verdict', async () => {
		const root = directory();
		const fetchImpl = vi.fn<typeof fetch>( async input => String( input ).endsWith( '/shared.svg' )
			? new Response( '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', { headers: { 'content-type': 'image/svg+xml' } } )
			: new Response( '<article><img src="/shared.svg">Content</article>', { headers: { 'content-type': 'text/html' } } ) );
		const result = await acquireHttpDocuments( { url: source, urls: [ source, source + 'other' ], outputDir: root, profile, collectAssets: true }, dependencies( fetchImpl ) );
		expect( result.coverage.acquired ).toBe( 4 );
		expect( result.resources ).toMatchObject( { captured: 1, failures: 0 } );
		expect( fetchImpl.mock.calls.filter( ( [ input ] ) => String( input ).endsWith( '/shared.svg' ) ) ).toHaveLength( 1 );
		expect( result.verification.assets ).toBe( 'not_localized' );
	} );
	it( 'retains actual response bytes and route-specific variants with honest coverage', async () => {
		const root = directory();
		const fetchImpl = vi.fn<typeof fetch>( async ( input, options ) => {
			const url = String( input );
			if ( url.endsWith( '/gone' ) ) return new Response( '<h1>Missing</h1>', { status: 404, headers: { 'content-type': 'text/html' } } );
			const variant = new Headers( options?.headers ).get( 'x-variant' );
			return new Response( url.endsWith( '/app' ) ? '<div id="app"></div>' : `<article>${ url } ${ variant }</article>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } } );
		} );
		const result = await acquireHttpDocuments( { url: source, urls: [ source, source, source + 'app', source + 'gone' ], outputDir: root, profile }, dependencies( fetchImpl ) );
		expect( fetchImpl ).toHaveBeenCalledTimes( 6 );
		expect( result.coverage ).toEqual( { routes: 3, requiredDocuments: 6, acquired: 2, browserRequired: 2, failed: 2 } );
		expect( result.verification ).toEqual( { rendering: 'unverified', assets: 'not_localized', interactions: 'unverified' } );
		for ( const document of result.documents.filter( row => row.status === 'acquired' ) ) {
			const bytes = readFileSync( join( root, document.rawPath! ) );
			expect( document.rawSha256 ).toBe( createHash( 'sha256' ).update( bytes ).digest( 'hex' ) );
			expect( bytes.toString() ).toContain( document.variant );
			expect( readFileSync( join( root, document.documentPath! ), 'utf8' ) ).toBe( bytes.toString() );
		}
		expect( result.documents.filter( row => row.status === 'browser_required' ).every( row => row.rawPath && ! row.documentPath ) ).toBe( true );
		expect( JSON.parse( readFileSync( result.receiptPath, 'utf8' ) ).documents ).toHaveLength( 6 );
	} );

	it( 'bounds concurrent fetches and retries transient statuses without dropping routes', async () => {
		let active = 0, peak = 0, calls = 0;
		const fetchImpl = vi.fn<typeof fetch>( async () => {
			active++; peak = Math.max( peak, active ); const call = ++calls;
			await new Promise( resolve => setTimeout( resolve, 10 ) ); active--;
			return call === 1 ? new Response( '', { status: 503, headers: { 'retry-after': '0' } } ) : new Response( '<article>Content</article>', { headers: { 'content-type': 'text/html' } } );
		} );
		const result = await acquireHttpDocuments( { url: source, urls: [ source, source + 'one', source + 'two' ], outputDir: directory(), profile, concurrency: 2 }, dependencies( fetchImpl ) );
		expect( peak ).toBe( 2 );
		expect( result.coverage.acquired ).toBe( 6 );
		expect( fetchImpl ).toHaveBeenCalledTimes( 7 );
		expect( result.documents.some( row => row.attempts === 2 ) ).toBe( true );
	} );

	it( 'accepts query renditions but records actual redirect drift as browser-required', async () => {
		const fetchImpl = vi.fn<typeof fetch>( async input => {
			const url = String( input );
			if ( url === source ) return new Response( '', { status: 302, headers: { location: source + '?view=phone' } } );
			if ( url === source + 'old' ) return new Response( '', { status: 302, headers: { location: source + 'new' } } );
			return new Response( '<article>Content</article>', { headers: { 'content-type': 'text/html' } } );
		} );
		const result = await acquireHttpDocuments( { url: source, urls: [ source, source + 'old' ], outputDir: directory(), profile }, dependencies( fetchImpl ) );
		expect( result.documents.filter( row => row.url === source ).every( row => row.status === 'acquired' && row.finalUrl === source + '?view=phone' ) ).toBe( true );
		expect( result.documents.filter( row => row.url.endsWith( '/old' ) ).every( row => row.status === 'browser_required' ) ).toBe( true );
	} );

	it( 'never retries a blocked redirect or transfers variant credentials off origin', async () => {
		const fetchImpl = vi.fn<typeof fetch>( async ( input, options ) => {
			if ( String( input ) === source ) return new Response( '', { status: 302, headers: { location: 'https://other.example/' } } );
			expect( new Headers( options?.headers ).get( 'authorization' ) ).toBeNull();
			return new Response( '<article>Other</article>', { headers: { 'content-type': 'text/html' } } );
		} );
		const custom = { ...profile, variants: [ { id: 'desktop', headers: { authorization: 'neutral-fixture-token' } } ] };
		await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: directory(), profile: custom }, dependencies( fetchImpl ) );
		const blocked = vi.fn<typeof fetch>( async () => new Response( '', { status: 302, headers: { location: 'http://127.0.0.1/' } } ) );
		const result = await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: directory(), profile: custom }, dependencies( blocked ) );
		expect( blocked ).toHaveBeenCalledTimes( 1 );
		expect( result.documents[ 0 ] ).toMatchObject( { status: 'failed', attempts: 1 } );
	} );

	it( 'rejects non-HTML, oversized bodies, empty preparation and malformed encoding visibly', async () => {
		const custom: HttpAcquisitionProfile = { ...profile, variants: [ { id: 'desktop' } ], prepare: () => ( { html: '' } ) };
		const empty = await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: directory(), profile: custom }, dependencies( async () => new Response( '<article>Original</article>', { headers: { 'content-type': 'text/html' } } ) ) );
		expect( empty.documents[ 0 ]!.status ).toBe( 'browser_required' );
		for ( const [ contentType, body, maxDocumentBytes ] of [ [ 'application/pdf', 'PDF', 64 ], [ 'text/html', '<article>Too large</article>', 4 ], [ 'text/html;charset=no-such-encoding', '<article>Text</article>', 64 ] ] as const ) {
			const result = await acquireHttpDocuments( { url: source, urls: [ source ], outputDir: directory(), profile: custom, maxDocumentBytes }, dependencies( async () => new Response( body, { headers: { 'content-type': contentType } } ) ) );
			expect( result.documents[ 0 ]!.status ).toBe( 'failed' );
			expect( result.documents[ 0 ]!.error ).toBeTruthy();
		}
	} );
} );
