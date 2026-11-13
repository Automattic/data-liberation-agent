import { describe, expect, it, vi } from 'vitest';
import { createRouteAdmission, type RouteKind } from './route-admission.js';

describe( 'route admission calibration', () => {
	it.each( [
		{ name: 'reference fallback before plain calibration', mixed: false, plain: false, expected: 200 },
		{ name: 'mixed samples belong to reference routes', mixed: true, plain: false, expected: 300 },
		{ name: 'plain-only samples calibrate independently', mixed: false, plain: true, expected: 50 },
	] )( '$name', ( { mixed, plain, expected } ) => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 900 );
		try {
			let available = 900;
			const references = new Set( [ 'reference' ] );
			const admission = createRouteAdmission( { memoryLimit: 1000, referenceRoutes: references, availableMemory: () => available } );
			expect( admission.kind( 'reference' ) ).toBe( 'reference' );
			expect( admission.kind( 'plain' ) ).toBe( 'plain' );
			references.add( 'alias-target' );
			expect( admission.kind( 'alias-target' ) ).toBe( 'reference' );
			admission.sample(); // 100-byte idle floor is not charged per route.
			expect( admission.estimate( 'reference' ) ).toBeUndefined();
			admission.start( 'reference' );
			available = 700;
			admission.sample();
			expect( admission.estimate( 'plain' ) ).toBeUndefined();
			expect( admission.admit( 'plain', [ 'reference' ], 0 ) ).toBe( false );
			admission.calibrate( 'reference' );
			expect( admission.estimate( 'plain' ) ).toBe( 200 );
			if ( mixed ) {
				admission.start( 'plain' );
				available = 300; // (700 used - 100 idle) / 2 active = 300 reference.
				admission.sample();
				admission.calibrate( 'plain' ); // No plain-only sample yet.
				admission.release( 'plain' );
			}
			admission.release( 'reference' );
			available = 850;
			admission.sample(); // Retained resources move the idle floor to 150.
			if ( plain ) {
				admission.start( 'plain' );
				available = 800;
				admission.calibrate( 'plain' );
				admission.release( 'plain' );
			}
			expect( admission.estimate( 'plain' ) ).toBe( expected );
			expect( admission.diagnostic( 'plain', 1, 'plain' ) ).toMatchObject( {
				limitBytes: 1000,
				availableBytes: available,
				idleFloorBytes: 1000 - available,
				reservedBytes: expected,
				activeRoutes: 1,
				kind: 'plain',
				url: 'plain',
			} );
			const running: RouteKind[] = [ 'reference', 'plain' ];
			const reserved = admission.estimate( 'reference' )! + 2 * expected;
			available = reserved - 1;
			expect( admission.admit( 'plain', running, 1 ) ).toBe( false );
			available = reserved;
			expect( admission.admit( 'plain', running, 1 ) ).toBe( true );
		} finally {
			vi.restoreAllMocks();
		}
	} );

	it( 'runs a route\'s profiles concurrently only after calibration and with room for another share', () => {
		let available = 900;
		const admission = createRouteAdmission( { memoryLimit: 1000, availableMemory: () => available } );
		admission.sample(); // 100-byte idle floor.
		admission.start( 'reference' );
		available = 700; // The running route uses 200 bytes above the idle floor.
		// Uncalibrated: no estimate, so profiles stay sequential whatever is free.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( false );
		admission.calibrate( 'reference' );
		// 700 free covers this route's 200 and another 200-byte share.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( true );
		available = 399; // The route grew to 501 bytes; 399 cannot cover 2 × 501.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( false );
	} );
} );
