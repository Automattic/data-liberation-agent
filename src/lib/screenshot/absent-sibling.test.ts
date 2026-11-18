import { describe, expect, it, vi } from 'vitest';
import { AbsentDocumentProbes, absentDocumentSignature, isAbsentDocumentError } from './absent-document.js';

const page = ( text: string, chrome = 'Site navigation' ) => `<html><body><header>${ chrome }</header><main>${ text }</main><footer>Shared footer</footer></body></html>`;

describe( 'absent sibling corroboration (rendered HTML fixtures)', () => {
	it( 'excludes a localized HTTP-200 fallback, ignoring chrome and the requested slug', async () => {
		const probes = new AbsentDocumentProbes();
		const render = vi.fn( async ( url: string ) => ( {
			status: 200,
			html: page( `<h1>ページがありません</h1><p>${ new URL( url ).pathname.split( '/' ).pop() }</p>`, 'Different shared chrome' ),
		} ) );
		const url = 'https://example.com/events/broken%20link';
		expect( await probes.matches( url, page( '<h1>ページがありません</h1><p>broken link</p>' ), render ) ).toBe( true );
		expect( await probes.matches( 'https://example.com/events/missing', page( '<h1>ページがありません</h1><p>missing</p>' ), render ) ).toBe( true );
		expect( render ).toHaveBeenCalledTimes( 1 );
		expect( render.mock.calls[ 0 ][ 0 ] ).toMatch( /^https:\/\/example.com\/events\/liberation-absent-/ );
		// The capture failure uses the existing absent-route/coverage contract.
		expect( isAbsentDocumentError( 'HTTP 404 (render matches absent nonce sibling)' ) ).toBe( true );
	} );

	it( 'keeps a real thin empty state when the nonce sibling differs', async () => {
		const render = vi.fn( async () => ( { status: 200, html: page( '<h1>Page not found</h1>' ) } ) );
		expect( await new AbsentDocumentProbes().matches( 'https://example.com/events/private', page( '<h1>Access Denied</h1>' ), render ) ).toBe( false );
	} );

	it( 'leaves children untouched when their parent probe returns HTTP 404', async () => {
		const probes = new AbsentDocumentProbes();
		const html = page( '<h1>Access Denied</h1>' );
		const render = vi.fn( async () => ( { status: 404, html } ) );
		const results = await Promise.all( [ 'a', 'b', 'c' ].map( slug => probes.matches( `https://example.com/events/${ slug }`, html, render ) ) );
		expect( results ).toEqual( [ false, false, false ] );
		expect( render ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'never probes substantial pages or empty documents; caches failed probes', async () => {
		const probes = new AbsentDocumentProbes();
		const render = vi.fn( async () => undefined );
		await probes.matches( 'https://example.com/a', page( 'x'.repeat( 601 ) ), render );
		await probes.matches( 'https://example.com/b', page( '' ), render );
		expect( render ).not.toHaveBeenCalled();
		await probes.matches( 'https://example.com/c', page( 'Short' ), render );
		await probes.matches( 'https://example.com/d', page( 'Short' ), render );
		expect( render ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'distinguishes media content on otherwise identical thin pages', () => {
		expect( absentDocumentSignature( page( 'Short<img src="/real.png">' ), 'https://example.com/a' ) ).not.toBe(
			absentDocumentSignature( page( 'Short<img src="/fallback.png">' ), 'https://example.com/b' ),
		);
	} );
} );
