import { describe, expect, it } from 'vitest';
import { createPhaseLedger, routePhaseBreakdown } from './phase-ledger.js';

describe( 'createPhaseLedger', () => {
	it( 'accounts for route wall time across profile phases with an other residual', () => {
		const breakdown = routePhaseBreakdown( [
			[ { phase: 'navigate', ms: 40 }, { phase: 'settle', ms: 30 } ],
			[ { phase: 'navigate', ms: 40 }, { phase: 'serialize', ms: 20 } ],
		], 100 );
		expect( breakdown ).toEqual( { navigate: 61, settle: 23, serialize: 15, other: 1 } );
		expect( Object.values( breakdown ).reduce( ( total, ms ) => total + ms, 0 ) ).toBe( 100 );
	} );

	it( 'bounds overlapping profile measurements to route wall time', () => {
		const breakdown = routePhaseBreakdown( [ [ { phase: 'navigate', ms: 80 }, { phase: 'settle', ms: 80 } ] ], 100 );
		expect( Object.values( breakdown ).reduce( ( total, ms ) => total + ms, 0 ) ).toBe( 100 );
		expect( breakdown.other ).toBe( 0 );
	} );

	it( 'tiles elapsed time across entered phases and accumulates repeats in first-entry order', () => {
		let now = 0;
		const ledger = createPhaseLedger( () => now );
		ledger.enter( 'navigate' ); now = 100;
		ledger.enter( 'serialize' ); now = 130;
		ledger.enter( 'screenshot' ); now = 200;
		ledger.enter( 'serialize' ); now = 250;
		expect( ledger.finish() ).toEqual( [
			{ phase: 'navigate', ms: 100 },
			{ phase: 'serialize', ms: 80, count: 2 },
			{ phase: 'screenshot', ms: 70 },
		] );
	} );

	it( 'records nothing before the first phase and closes the open phase once', () => {
		let now = 5;
		const ledger = createPhaseLedger( () => now );
		expect( ledger.finish() ).toEqual( [] );
		ledger.enter( 'context' ); now = 15;
		expect( ledger.finish() ).toEqual( [ { phase: 'context', ms: 10 } ] );
		now = 50;
		expect( ledger.finish() ).toEqual( [ { phase: 'context', ms: 10 } ] );
	} );
	it( 'tallies readiness outcomes by wait name', () => {
		const ledger = createPhaseLedger( () => 0 );
		ledger.wait( 'stable', { reason: 'quiet', ms: 600 } );
		ledger.wait( 'stable', { reason: 'deadline', ms: 5000 } );
		ledger.wait( 'scroll-restore', { reason: 'quiet', ms: 210 } );
		expect( ledger.readiness() ).toEqual( {
			stable: { count: 2, ms: 5600, deadline: 1 },
			'scroll-restore': { count: 1, ms: 210, deadline: 0 },
		} );
	} );
} );
