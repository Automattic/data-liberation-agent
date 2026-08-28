import { describe, expect, it } from 'vitest';
import { scoreReport, scoreViewport, type LayoutObservation } from './score.js';

const at = ( viewport: number, extra: Partial< LayoutObservation > = {} ): LayoutObservation => ( {
	viewport,
	title: 'Home',
	textChars: 336,
	widestImage: viewport,
	docWidth: viewport,
	overflow: false,
	externalHosts: [],
	hashTargets: [],
	internalMissing: [],
	...extra,
} );

describe( 'scoreViewport', () => {
	it( 'passes when the copy matches the source at an unsampled width', () => {
		const score = scoreViewport( at( 1600 ), at( 1600 ) );
		expect( score.pass ).toBe( true );
		expect( score.failures ).toEqual( [] );
	} );

	it( 'fails when the copy is frozen at the capture width', () => {
		// The Roeeby freeze: source is 1600, copy stuck at 1440.
		const score = scoreViewport( at( 1600 ), at( 1600, { widestImage: 1440 } ) );
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /widest image 1440px !== source 1600px/ );
	} );

	it( 'fails when the copy overflows and the source does not', () => {
		const score = scoreViewport(
			at( 900, { docWidth: 900 } ),
			at( 900, { docWidth: 980, overflow: true } )
		);
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /horizontal overflow/ );
	} );

	it( 'allows overflow only when the source also overflows', () => {
		const score = scoreViewport(
			at( 390, { docWidth: 980, overflow: true, widestImage: 980 } ),
			at( 390, { docWidth: 980, overflow: true, widestImage: 980 } )
		);
		expect( score.pass ).toBe( true );
	} );

	it( 'fails when a same-page hash has no target in the copy', () => {
		const score = scoreViewport(
			at( 1440, { hashTargets: [ { fragment: 'team', resolved: true, targets: 1 } ] } ),
			at( 1440, { hashTargets: [ { fragment: 'team', resolved: false, targets: 0 } ] } )
		);
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /#team/ );
	} );

	it( 'fails when a hash resolves in the copy but to more places than the source', () => {
		const score = scoreViewport(
			at( 1440, { hashTargets: [ { fragment: 'about', resolved: true, targets: 1 } ] } ),
			at( 1440, { hashTargets: [ { fragment: 'about', resolved: true, targets: 2 } ] } )
		);
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /more than one target: #about/ );
	} );

	it( 'accepts a duplicate the source ships too', () => {
		const score = scoreViewport(
			at( 1440, { hashTargets: [ { fragment: 'about', resolved: true, targets: 2 } ] } ),
			at( 1440, { hashTargets: [ { fragment: 'about', resolved: true, targets: 2 } ] } )
		);
		expect( score.pass ).toBe( true );
	} );

	it( 'fails when the source hash worked and the copy dropped it', () => {
		const score = scoreViewport(
			at( 1440, { hashTargets: [ { fragment: 'features', resolved: true, targets: 1 } ] } ),
			at( 1440 )
		);
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /#features/ );
	} );

	it( 'fails when an internal path 404s in the copy', () => {
		const score = scoreViewport( at( 1440 ), at( 1440, { internalMissing: [ '/about/' ] } ) );
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /\/about\// );
	} );

	it( 'fails when the copy still talks to the source CDN', () => {
		const score = scoreViewport(
			at( 1440 ),
			at( 1440, { externalHosts: [ 'siteassets.parastorage.com' ] } )
		);
		expect( score.pass ).toBe( false );
		expect( score.failures[ 0 ] ).toMatch( /parastorage/ );
	} );

	it( 'fails on text or title drift', () => {
		expect( scoreViewport( at( 1440 ), at( 1440, { textChars: 300 } ) ).pass ).toBe( false );
		expect( scoreViewport( at( 1440 ), at( 1440, { title: 'Other' } ) ).pass ).toBe( false );
	} );

	it( 'tolerates one pixel of image rounding', () => {
		expect( scoreViewport( at( 1440, { widestImage: 1440 } ), at( 1440, { widestImage: 1441 } ) ).pass ).toBe(
			true
		);
	} );

	it( 'refuses to score mismatched viewports', () => {
		expect( () => scoreViewport( at( 1440 ), at( 1600 ) ) ).toThrow( /mismatched viewports/ );
	} );
} );

describe( 'scoreReport', () => {
	it( 'passes only when every viewport passes', () => {
		const ok = scoreViewport( at( 1600 ), at( 1600 ) );
		const bad = scoreViewport( at( 1728 ), at( 1728, { widestImage: 1440 } ) );
		expect( scoreReport( [ ok ] ) ).toEqual( { pass: true, failed: 0, passed: 1 } );
		expect( scoreReport( [ ok, bad ] ) ).toEqual( { pass: false, failed: 1, passed: 1 } );
	} );
} );
