import { describe, expect, it, vi } from 'vitest';
import { createRouteAdmission, type RouteKind } from './route-admission.js';

const GiB = 1024 ** 3;

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
			expect( admission.estimate( 'reference' ) ).toBe( 2 * GiB ); // Provisional floor.
			admission.start( 'reference' );
			available = 700;
			admission.sample();
			expect( admission.estimate( 'plain' ) ).toBe( 2 * GiB );
			expect( admission.admit( 'plain', [ 'reference' ] ) ).toBe( false ); // The provisional share cannot fit.
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
			expect( admission.admit( 'plain', running ) ).toBe( false );
			available = reserved;
			expect( admission.admit( 'plain', running ) ).toBe( true );
		} finally {
			vi.restoreAllMocks();
		}
	} );

	it( 'admits a second route while the first reference route is still calibrating', () => {
		const limit = 48 * GiB;
		let available = 26 * GiB;
		const admission = createRouteAdmission( { memoryLimit: limit, availableMemory: () => available } );
		expect( admission.admit( 'reference', [] ) ).toBe( true );
		admission.start( 'reference' );
		available = 25 * GiB; // The uncalibrated route has grown 1 GiB so far.
		// Each route reserves the provisional 6 GiB (1/8 of the limit): 25 GiB fits two more.
		expect( admission.admit( 'reference', [ 'reference' ] ) ).toBe( true );
		admission.start( 'reference' );
		expect( admission.admit( 'reference', [ 'reference', 'reference' ] ) ).toBe( true );
		admission.start( 'reference' );
		expect( admission.admit( 'reference', [ 'reference', 'reference', 'reference' ] ) ).toBe( true );
		admission.start( 'reference' );
		// A fifth route's 30 GiB reservation does not fit in 25 GiB.
		expect( admission.admit( 'reference', [ 'reference', 'reference', 'reference', 'reference' ] ) ).toBe( false );
		// Sampled growth above the provisional share raises the reservation.
		available = 6 * GiB; // (42 used - 22 idle) / 4 active = 5 GiB; still provisional 6 GiB.
		admission.sample();
		expect( admission.estimate( 'reference' ) ).toBe( 6 * GiB );
		available = 0.5 * GiB; // (47.5 - 22) / 4 = 6.375 GiB exceeds the provisional share.
		admission.sample();
		expect( admission.estimate( 'reference' ) ).toBeCloseTo( 6.375 * GiB );
	} );

	it( 'admits by the measured plain working set when no route is in the reference sample', () => {
		// A deferred reference samples no route, so no reference route ever
		// completes. 13 GiB available on a 48 GiB machine (provisional 6 GiB).
		const limit = 48 * GiB;
		let available = 13 * GiB;
		const admission = createRouteAdmission( { memoryLimit: limit, referenceRoutes: new Set(), availableMemory: () => available } );
		expect( admission.kind( 'https://example.test/' ) ).toBe( 'plain' );
		admission.sample(); // 35 GiB idle floor.
		expect( admission.admit( 'plain', [] ) ).toBe( true );
		admission.start( 'plain' );
		available = 11.5 * GiB; // The entrypoint peaks 1.5 GiB above the floor.
		admission.sample();
		admission.calibrate( 'plain' );
		admission.release( 'plain' );
		available = 13 * GiB;
		admission.sample();
		expect( admission.estimate( 'plain' ) ).toBe( 1.5 * GiB );
		// Five running plain routes plus the admitted one reserve 9 GiB, not 36 GiB.
		const running: RouteKind[] = [ 'plain', 'plain', 'plain', 'plain', 'plain' ];
		expect( admission.admit( 'plain', running ) ).toBe( true );
		expect( admission.diagnostic( 'plain', 6, 'https://example.test/next' ) ).toMatchObject( { reservedBytes: 1.5 * GiB, calibrated: { reference: false, plain: true } } );
	} );

	it( 'runs a route\'s profiles concurrently only with room for another share', () => {
		let available = 900;
		const admission = createRouteAdmission( { memoryLimit: 1000, availableMemory: () => available } );
		admission.sample(); // 100-byte idle floor.
		admission.start( 'reference' );
		available = 700; // The running route uses 200 bytes above the idle floor.
		// Uncalibrated: the 2 GiB provisional share cannot fit twice in 700 bytes.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( false );
		admission.calibrate( 'reference' );
		// 700 free covers this route's 200 and another 200-byte share.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( true );
		available = 399; // The route grew to 501 bytes; 399 cannot cover 2 × 501.
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( false );
	} );

	it( 'runs the first route\'s profiles concurrently under the provisional estimate', () => {
		let available = 25 * GiB;
		const admission = createRouteAdmission( { memoryLimit: 48 * GiB, availableMemory: () => available } );
		admission.sample();
		admission.start( 'reference' );
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( true ); // 25 GiB ≥ 2 × 6 GiB.
		available = 11 * GiB;
		expect( admission.roomForParallelProfiles( 'reference' ) ).toBe( false );
	} );
} );
