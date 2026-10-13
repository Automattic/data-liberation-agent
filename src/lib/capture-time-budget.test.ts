import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_BUDGET_DRAIN_MS, CAPTURE_BUDGET_MAX_GRACE_MS, captureTimeBudgetWindow, RouteTimeBudget, validateTimeBudgetMs } from './capture-time-budget.js';
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

	it( 'reports skipped routes as missing, so usability follows the shared policy', () => {
		const budget = new RouteTimeBudget( window, 'https://example.test/', () => 90 );
		budget.start( 'https://example.test/' );
		const rows = budget.diagnostics( [ 'https://example.test/', 'https://example.test/a' ] );
		const missing = missingRoutes( rows );
		expect( missing ).toEqual( [ { url: 'https://example.test/a', code: 'route_capture_skipped_budget', reason: expect.stringContaining( 'capture time budget 100ms' ) } ] );
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: missing, summary: { routesDiscovered: 2 } } ) ).toBe( true );
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: [ ...missing, ...missing ], summary: { routesDiscovered: 3 } } ) ).toBe( false );
	} );
} );
