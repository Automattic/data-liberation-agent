import { describe, expect, it } from 'vitest';
import { IntegrityError, orElse } from './failure-class.js';

describe( 'orElse', () => {
	it( 'returns the unchanged fallback for operational failures', async () => {
		for ( const fallback of [ undefined, null, false, 0, '', [], {} ] ) {
			expect( await Promise.reject( new Error( 'page closed' ) ).catch( orElse( fallback ) ) ).toBe( fallback );
		}
	} );

	it( 'rethrows integrity and programmer failures unchanged, including non-Error throws', async () => {
		for ( const error of [ new IntegrityError( 'boundary' ), new TypeError( 'bug' ), new ReferenceError( 'bug' ), new RangeError( 'bug' ), new SyntaxError( 'bug' ), new EvalError( 'bug' ), 'unexpected', null, undefined ] ) {
			await expect( Promise.reject( error ).catch( orElse( false ) ) ).rejects.toBe( error );
		}
	} );
} );
