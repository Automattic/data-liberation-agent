import { describe, expect, it } from 'vitest';
import { declaredSiteName, siteNameFromRouteTitles } from './site-name.js';

describe( 'siteNameFromRouteTitles', () => {
	it( 'trims the discovered title to the segment every route repeats, wherever the site puts it', () => {
		expect( siteNameFromRouteTitles( 'Acme Auto | Auto Repair in Springfield', [ 'Acme Auto | Auto Repair in Springfield', 'Privacy Policy | Acme Auto' ] ) ).toBe( 'Acme Auto' );
		expect( siteNameFromRouteTitles( 'Home — Acme', [ 'Home — Acme', 'About – Acme', 'Contact - Acme' ] ) ).toBe( 'Acme' );
	} );

	it( 'names the site from the routes when discovery found no title', () => {
		expect( siteNameFromRouteTitles( undefined, [ 'Home | Acme', 'About | Acme' ] ) ).toBe( 'Acme' );
	} );

	it( 'keeps the discovered title without evidence that would trim it', () => {
		const title = 'Acme | Hand-made widgets';
		expect( siteNameFromRouteTitles( title, [ title ] ), 'one route' ).toBe( title );
		expect( siteNameFromRouteTitles( title, [ title, title ] ), 'every route repeats every segment' ).toBe( title );
		expect( siteNameFromRouteTitles( title, [ title, 'About' ] ), 'no shared segment' ).toBe( title );
		expect( siteNameFromRouteTitles( 'Acme', [ 'Home | Acme Inc', 'About | Acme Inc' ] ), 'a site name meta the routes spell differently' ).toBe( 'Acme' );
		expect( siteNameFromRouteTitles( 'Smith-Jones Law', [ 'Home | Smith-Jones Law', 'Team | Smith-Jones Law' ] ), 'hyphens inside a name are not separators' ).toBe( 'Smith-Jones Law' );
	} );
} );

describe( 'declaredSiteName', () => {
	it( 'reads the name a WebSite JSON-LD node declares, and nothing else', () => {
		const ld = ( json: string ) => `<head><script type="application/ld+json">${ json }</script></head>`;
		expect( declaredSiteName( ld( '{"@type":"WebSite","name":" Acme "}' ) ) ).toBe( 'Acme' );
		expect( declaredSiteName( ld( '{"@graph":[{"@type":"Person","name":"Jo"},{"@type":["WebSite"],"name":"Acme"}]}' ) ) ).toBe( 'Acme' );
		expect( declaredSiteName( ld( '{"@type":"Person","name":"Jo"}' ) + ld( '{bad' ) ), 'a person is not the site' ).toBeUndefined();
		expect( declaredSiteName( '<title>Acme</title>' ) ).toBeUndefined();
	} );
} );
