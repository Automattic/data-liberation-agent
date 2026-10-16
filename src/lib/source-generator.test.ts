import { describe, expect, it } from 'vitest';
import { sourceGenerator } from './source-generator.js';

describe( 'sourceGenerator', () => {
	it( 'reads the declared generator, matching the name case-insensitively', () => {
		expect( sourceGenerator( '<html><head><meta name="generator" content="v0.app"/></head></html>' ) ).toBe( 'v0.app' );
		expect( sourceGenerator( '<meta name="Generator" content=" Astro v4.0.0 ">' ) ).toBe( 'Astro v4.0.0' );
	} );

	it( 'reports nothing when the document declares no generator', () => {
		expect( sourceGenerator( '<meta name="description" content="v0.app"><meta name="generator" content="">' ) ).toBeUndefined();
	} );
} );
