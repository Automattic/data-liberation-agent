import { describe, expect, it } from 'vitest';
import { isSecurityServiceRejection, rejectedNavigationReason } from './navigation-rejection.js';

const blockPage = '<div id="cf-error-details"><h1 data-translate="block_headline">Sorry, you have been blocked</h1></div>';

describe( 'rejectedNavigationReason', () => {
	it( 'labels a Cloudflare block page that sends no challenge header', () => {
		const reason = rejectedNavigationReason( 403, { server: 'cloudflare' }, blockPage );
		expect( reason ).toBe( 'HTTP 403; blocked: cloudflare' );
		expect( isSecurityServiceRejection( reason ) ).toBe( true );
	} );

	it( 'keeps reporting a challenge header', () => {
		const reason = rejectedNavigationReason( 403, { 'cf-mitigated': 'challenge' } );
		expect( reason ).toBe( 'HTTP 403; challenge: cf-mitigated=challenge' );
		expect( isSecurityServiceRejection( reason ) ).toBe( true );
	} );

	it( 'leaves an ordinary 403 unlabeled, even served through Cloudflare', () => {
		const reason = rejectedNavigationReason( 403, { server: 'cloudflare' }, '<h1>Forbidden</h1><p>you have been blocked</p>' );
		expect( reason ).toBe( 'HTTP 403' );
		expect( isSecurityServiceRejection( reason ) ).toBe( false );
	} );

	it( 'never copies the response body into the reason', () => {
		expect( rejectedNavigationReason( 403, {}, `${ blockPage }<p>private visitor detail</p>` ) ).not.toContain( 'private visitor detail' );
	} );
} );
