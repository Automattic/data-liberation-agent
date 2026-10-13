import { describe, expect, it } from 'vitest';
import { parseDurationMs } from './duration.js';

describe( 'parseDurationMs', () => {
	it( 'parses unit-suffixed and bare-millisecond durations', () => {
		expect( parseDurationMs( '13m' ) ).toBe( 780_000 );
		expect( parseDurationMs( '780s' ) ).toBe( 780_000 );
		expect( parseDurationMs( '1.5h' ) ).toBe( 5_400_000 );
		expect( parseDurationMs( '250ms' ) ).toBe( 250 );
		expect( parseDurationMs( '45000' ) ).toBe( 45_000 );
		expect( parseDurationMs( ' 2M ' ) ).toBe( 120_000 );
	} );

	it( 'rejects text that is not a positive duration', () => {
		for ( const text of [ '', '0', '0s', '-5m', 'm', '10 minutes', '1e3', '0.0001ms' ] ) expect( parseDurationMs( text ) ).toBeUndefined();
	} );
} );
