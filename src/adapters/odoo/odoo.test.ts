import { describe, expect, it } from 'vitest';
import { detectFromResponse } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../platform/registry.js';
import { routeInScope, validateRouteScope } from '../../lib/url/route-scope.js';
import { LinkedFrontier } from '../../lib/screenshot/linked-frontier.js';
import { odooAdapter } from './index.js';

describe( 'Odoo', () => {
	it.each( [
		'<meta name="generator" content="Odoo">',
		"<meta content='Odoo' name='generator' />",
		'<script src="/web/assets/123/web.assets_frontend.min.js"></script>',
		'<link rel="stylesheet" href="https://site.test/web/assets/123/web.assets_frontend.min.css">',
	] )( 'detects neutral platform markup: %s', html => {
		expect( detectFromResponse( new Headers(), html ).platform ).toBe( 'odoo' );
	} );

	it.each( [
		'<meta name="generator" content="Another Builder">',
		'<p>Odoo integrations</p><a href="/web/login">Sign in</a>',
		'<img src="/web/image/123">',
		'<script src="/web/assets-other/app.js"></script>',
	] )( 'does not detect unrelated markup: %s', html => {
		expect( detectFromResponse( new Headers(), html ).platform ).toBe( 'unknown' );
	} );

	it( 'registers a document-only scope that excludes application routes before frontier admission', () => {
		expect( resolvePlatform( 'odoo' ) ).toBe( odooAdapter );
		const scope = odooAdapter.routeScope!( 'https://site.test/' );
		validateRouteScope( scope );
		const frontier = new LinkedFrontier( { maxPages: 20 }, Date.now(), scope );
		for ( const path of [ '/web', '/web/', '/web/login', '/web/login/?redirect=%2Fshop', '/web/signup', '/web/reset_password', '/web/application' ] ) {
			const url = `https://site.test${path}`;
			expect( routeInScope( url, scope ) ).toBe( false );
			expect( frontier.admit( url, 0 ) ).toBe( false );
		}
		for ( const path of [ '/', '/shop', '/contactus', '/shop/some-product-1', '/webinar' ] ) {
			expect( routeInScope( `https://site.test${path}`, scope ) ).toBe( true );
		}
		expect( routeInScope( 'https://elsewhere.test/shop', scope ) ).toBe( false );
	} );
} );
