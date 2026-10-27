import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_BUDGET_DRAIN_MS, CAPTURE_BUDGET_MAX_GRACE_MS, captureTimeBudgetWindow, deriveRouteDeadlineMs, ROUTE_DEADLINE_MIN_MS, RouteDeadlines, RouteTimeBudget, routeTimeoutDiagnostic, validateRouteDeadlineMs, validateTimeBudgetMs } from './capture-time-budget.js';
import { isUsableCapture, missingRoutes } from './capture-usability.js';

describe( 'capture time budget window', () => {
	it( 'closes admission a grace window before the budget: 25% of it, at most 60s', () => {
		expect( captureTimeBudgetWindow( 1_000, 40_000 ) ).toEqual( { timeBudgetMs: 40_000, admitUntil: 31_000, abandonAt: 41_000 } );
		expect( captureTimeBudgetWindow( 0, 900_000 ) ).toEqual( { timeBudgetMs: 900_000, admitUntil: 900_000 - CAPTURE_BUDGET_MAX_GRACE_MS, abandonAt: 900_000 } );
		expect( captureTimeBudgetWindow( 0, 1 ) ).toEqual( { timeBudgetMs: 1, admitUntil: 1, abandonAt: 1 } );
	} );

	it( 'accepts only a positive integer number of milliseconds', () => {
		expect( () => validateTimeBudgetMs( undefined ) ).not.toThrow();
		expect( () => validateTimeBudgetMs( 1 ) ).not.toThrow();
		for ( const invalid of [ 0, -5, 1.5, Number.POSITIVE_INFINITY, '60000' ] ) expect( () => validateTimeBudgetMs( invalid ) ).toThrow( RangeError );
	} );
} );

describe( 'RouteTimeBudget', () => {
	const window = { timeBudgetMs: 100, admitUntil: 75, abandonAt: 100 };

	it( 'always admits the entrypoint and closes once admission time has passed', () => {
		let now = 80;
		const budget = new RouteTimeBudget( window, 'https://example.test/', () => now );
		expect( budget.admits( 'https://example.test/about' ) ).toBe( false );
		expect( budget.admits( 'https://example.test/' ) ).toBe( true );
		// Not closed until the entrypoint has started, so it is never skipped.
		expect( budget.closed() ).toBe( false );
		budget.start( 'https://example.test/' );
		expect( budget.closed() ).toBe( true );
		now = 10;
		expect( budget.admits( 'https://example.test/about' ) ).toBe( true );
	} );

	it.each( [
		[ 'without a reserve', undefined, false, 44 ],
		[ 'with an explicit zero reserve', 0, false, 44 ],
		[ 'with a 5s reserve, clock-only admission', 5_000, false, 6 ],
		[ 'with a 5.5s reserve, clock-only admission', 5_500, false, 6 ],
		[ 'with a 5s reserve, projected admission', 5_000, true, 6 ],
		[ 'with a 5.5s reserve, projected admission', 5_500, true, 5 ],
	] )( 'closes admission once the per-route reserve no longer fits: %s', ( _name, reserve, projectAdmission, admitted ) => {
		let now = 0;
		const entrypoint = 'https://example.test/';
		const budget = new RouteTimeBudget( { timeBudgetMs: 60_000, ...( reserve !== undefined ? { routeReserveMs: reserve } : {} ), admitUntil: 45_000, abandonAt: 60_000, projectAdmission }, entrypoint, () => now );
		// One route takes 1s; every route finishes before the next candidate is checked.
		const capture = ( url: string ): void => {
			budget.start( url );
			now += 1_000;
			budget.finish( url );
		};
		expect( budget.admits( entrypoint ) ).toBe( true );
		capture( entrypoint );
		let count = 0;
		while ( budget.admits( `https://example.test/${ count + 1 }` ) ) {
			count++;
			capture( `https://example.test/${ count }` );
			// The entrypoint stays admitted even while every other route is refused.
			expect( budget.admits( entrypoint ) ).toBe( true );
		}
		expect( count ).toBe( admitted );
		expect( budget.admits( entrypoint ) ).toBe( true );
	} );

	it( 'reports reserve-skipped routes as budget skips naming the reserve, under clock-only and projected admission', () => {
		const entrypoint = 'https://example.test/';
		const window = { timeBudgetMs: 60_000, routeReserveMs: 5_000, admitUntil: 45_000, abandonAt: 60_000 };
		const budget = new RouteTimeBudget( window, entrypoint, () => 50_000 );
		budget.start( entrypoint );
		const reason = 'capture time budget 60000ms with 5000ms reserved per route: route admission closed 45000ms into the capture, before this route started';
		const expected = ( url: string ) => ( { code: 'route_capture_skipped_budget', url, reason, unit: 'route', severity: 'error', metrics: { timeBudgetMs: 60_000 } } );
		expect( budget.diagnostics( [ entrypoint, 'https://example.test/a', 'https://example.test/b' ] ) )
			.toEqual( [ expected( 'https://example.test/a' ), expected( 'https://example.test/b' ) ] );
		// A reserve bounds what capture hands downstream, so projected admission still reports a missing route, not scope omission.
		expect( new RouteTimeBudget( { ...window, projectAdmission: true }, entrypoint, () => 50_000 ).diagnostics( [ 'https://example.test/a' ] ) )
			.toEqual( [ expected( 'https://example.test/a' ) ] );
	} );

	it( 'abandons running routes at the deadline, but never while the entrypoint runs', async () => {
		let now = 50;
		const budget = new RouteTimeBudget( window, 'https://example.test/', () => now );
		for ( const url of [ 'https://example.test/', 'https://example.test/slow', 'https://example.test/recording' ] ) budget.start( url );
		expect( budget.commit( 'https://example.test/recording' ) ).toBe( true );
		const close = vi.fn( async () => {} );
		const running = new Set( [ new Promise< void >( () => {} ) ] );

		expect( await budget.abandonIfDue( running, close ) ).toBe( false );
		now = 100;
		expect( await budget.abandonIfDue( running, close ) ).toBe( false );
		expect( close ).not.toHaveBeenCalled();

		budget.finish( 'https://example.test/' );
		vi.useFakeTimers();
		try {
			const abandoning = budget.abandonIfDue( running, close );
			await vi.advanceTimersByTimeAsync( CAPTURE_BUDGET_DRAIN_MS );
			expect( await abandoning ).toBe( true );
		} finally {
			vi.useRealTimers();
		}
		expect( close ).toHaveBeenCalledTimes( 1 );
		expect( budget.abandoning ).toBe( true );
		// An abandoned route records nothing; one that already committed keeps its outcome.
		expect( budget.commit( 'https://example.test/slow' ) ).toBe( false );
		expect( budget.diagnostics( [ 'https://example.test/', 'https://example.test/slow', 'https://example.test/recording', 'https://example.test/never' ] ) ).toEqual( [
			{ code: 'route_capture_skipped_budget', url: 'https://example.test/slow', reason: 'capture time budget 100ms: abandoned in flight at the deadline', unit: 'route', severity: 'error', metrics: { timeBudgetMs: 100 } },
			{ code: 'route_capture_skipped_budget', url: 'https://example.test/never', reason: 'capture time budget 100ms: route admission closed 75ms into the capture, before this route started', unit: 'route', severity: 'error', metrics: { timeBudgetMs: 100 } },
		] );
	} );

	it( 'reports skipped routes as missing without counting them against usability', () => {
		const budget = new RouteTimeBudget( window, 'https://example.test/', () => 90 );
		budget.start( 'https://example.test/' );
		const routes = [ 'https://example.test/', ...Array.from( { length: 19 }, ( _, index ) => `https://example.test/${ index }` ) ];
		const missing = missingRoutes( budget.diagnostics( routes ) );
		expect( missing ).toHaveLength( 19 );
		expect( missing[ 0 ] ).toEqual( { url: 'https://example.test/0', code: 'route_capture_skipped_budget', reason: expect.stringContaining( 'capture time budget 100ms' ) } );
		// A deadline that left only the entrypoint is a usable, incomplete capture.
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: missing, summary: { routesDiscovered: 20 } } ) ).toBe( true );
		// Failures among the attempted routes still follow max(1, 10%): skipped routes are not attempted.
		const failed = ( count: number ) => Array.from( { length: count }, ( _, index ) => ( { url: `https://example.test/f${ index }`, code: 'route_capture_failed' as const, reason: 'deadline' } ) );
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: [ ...missing.slice( 0, 9 ), ...failed( 1 ) ], summary: { routesDiscovered: 20 } } ) ).toBe( true );
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: [ ...missing.slice( 0, 9 ), ...failed( 2 ) ], summary: { routesDiscovered: 20 } } ) ).toBe( false );
		expect( isUsableCapture( { complete: false, entrypointCaptured: false, missingRoutes: missing, summary: { routesDiscovered: 20 } } ) ).toBe( false );
	} );
} );

describe( 'RouteDeadlines', () => {
	it( 'derives the deadline from the time budget and concurrency, never below the floor; explicit and zero win', () => {
		expect( deriveRouteDeadlineMs( undefined, 42 * 60_000, 3 ) ).toBe( 14 * 60_000 );
		expect( deriveRouteDeadlineMs( undefined, 60_000, 6 ) ).toBe( ROUTE_DEADLINE_MIN_MS );
		expect( deriveRouteDeadlineMs( undefined, undefined, 6 ) ).toBe( ROUTE_DEADLINE_MIN_MS );
		expect( deriveRouteDeadlineMs( 1_500, undefined, 6 ) ).toBe( 1_500 );
		expect( deriveRouteDeadlineMs( 0, 42 * 60_000, 3 ) ).toBe( 0 );
	} );

	it( 'accepts a non-negative integer route deadline (zero disabled)', () => {
		expect( () => validateRouteDeadlineMs( undefined ) ).not.toThrow();
		expect( () => validateRouteDeadlineMs( 0 ) ).not.toThrow();
		for ( const invalid of [ -5, 1.5, Number.POSITIVE_INFINITY, '60000' ] ) expect( () => validateRouteDeadlineMs( invalid ) ).toThrow( RangeError );
	} );

	it( 'abandons a route at its deadline and frees its slot; a finished route is unaffected', async () => {
		vi.useFakeTimers();
		try {
			const abandonedUrls: string[] = [];
			const deadlines = new RouteDeadlines( 1_000, url => abandonedUrls.push( url ) );
			const route = new Promise< void >( () => {} );
			const expiry = deadlines.start( 'https://example.test/slow' );
			deadlines.finish( 'https://example.test/fast' );
			// No abandonment before the deadline.
			expect( deadlines.commit( 'https://example.test/slow' ) ).toBe( true );
			let freed = false;
			void expiry.then( () => { freed = true; } );
			await vi.advanceTimersByTimeAsync( 999 );
			expect( freed ).toBe( false );
			await vi.advanceTimersByTimeAsync( 1 );
			expect( abandonedUrls ).toEqual( [ 'https://example.test/slow' ] );
			expect( freed ).toBe( true );
			// Expired while running the recorded phase: the diagnostic names it.
			deadlines.note( 'https://example.test/slow', 'settle', 'desktop' );
			expect( routeTimeoutDiagnostic( 'https://example.test/slow', 1_000, { phase: 'settle', profile: 'desktop' } ) ).toEqual( {
				code: 'route_capture_timeout', url: 'https://example.test/slow',
				reason: 'route capture deadline 1000ms: abandoned during the "settle" phase in the desktop profile',
				unit: 'route', severity: 'error', metrics: { routeDeadlineMs: 1_000 },
			} );
		} finally {
			vi.useRealTimers();
		}
	} );

	it( 'records nothing for an abandoned route and ignores later phase notes', async () => {
		vi.useFakeTimers();
		try {
			const deadlines = new RouteDeadlines( 500, () => {} );
			const expiry = deadlines.start( 'https://example.test/slow' );
			await vi.advanceTimersByTimeAsync( 500 );
			expect( deadlines.commit( 'https://example.test/slow' ) ).toBe( false );
			// Phases after abandonment belong to nothing.
			deadlines.note( 'https://example.test/slow', 'context', 'desktop' );
			expect( expiry ).toBeInstanceOf( Promise );
		} finally {
			vi.useRealTimers();
		}
	} );
	it( 'holds the slot until the route finishes when the deadline is disabled', async () => {
		const deadlines = new RouteDeadlines( 0, () => { throw new Error( 'a disabled deadline never abandons' ); } );
		let settled = false;
		const slot = deadlines.start( 'https://example.com/a' ).then( () => { settled = true; } );
		await new Promise( resolve => setTimeout( resolve, 20 ) );
		// The capture loop races this promise against the route to free its
		// slot; settling before the route ends would admit routes past the
		// concurrency limit.
		expect( settled ).toBe( false );
		deadlines.finish( 'https://example.com/a' );
		await slot;
		expect( settled ).toBe( true );
	} );
} );
