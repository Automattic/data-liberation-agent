import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { IntegrityError } from '../failure-class.js';
import { runSteps, SkipSet, type CaptureStep } from './capture-steps.js';
import { combineSkips } from './probe-exclusions.js';
import { createPhaseLedger } from './phase-ledger.js';

describe( 'runSteps', () => {
	it.each( [ 'when', 'expiry', 'failure', 'integrity', 'crash' ] as const )( '%s', async scenario => {
		const ctx = { page: {} as Page, values: [] as string[] };
		let expired = false;
		const ledger = createPhaseLedger();
		const steps: CaptureStep<typeof ctx>[] = [ {
			id: 'first', onFailure: 'best-effort', bound: 'probe-budget',
			when: () => scenario !== 'when',
			partial: c => c.values.push( 'partial' ),
			run: async c => {
				if ( scenario === 'integrity' ) throw new IntegrityError( 'test' );
				if ( scenario === 'failure' ) throw new Error( 'test' );
				c.values.push( 'first' );
			},
		}, {
			id: 'later', onFailure: 'best-effort', run: async c => { c.values.push( 'later' ); },
		} ];
		const run = runSteps( steps, ctx, { ledger, rendererCrashed: () => scenario === 'crash', budget: {
			expired: () => expired,
			run: async ( _phase, drive, partial ) => {
				if ( scenario === 'expiry' ) { expired = true; return partial; }
				return drive();
			},
		} } );
		if ( scenario === 'integrity' ) await expect( run ).rejects.toBeInstanceOf( IntegrityError );
		else await run;
		expect( ctx.values ).toEqual( {
			when: [ 'later' ], expiry: [ 'partial' ], failure: [ 'partial', 'later' ], integrity: [], crash: [],
		}[ scenario ] );
		const phases = ledger.finish();
		expect( phases.find( p => p.phase === 'first' )?.failed ).toBe( scenario === 'failure' ? 1 : undefined );
		if ( scenario === 'crash' ) expect( phases ).toEqual( [] );
	} );
} );

it( 'SkipSet preserves every post-baseline selector combination', () => {
	for ( const excluded of [ undefined, '', '.excluded' ] ) for ( const chrome of [ undefined, '.chrome' ] ) {
		const baseline = '.baseline';
		const collection = '.collection';
		for ( const [ actual, expected ] of [
			[ SkipSet.of( excluded, chrome ).selector(), combineSkips( excluded, chrome ) ],
			[ SkipSet.of( chrome, excluded ).with( baseline ).selector(), combineSkips( combineSkips( chrome, excluded ), baseline ) ],
			[ SkipSet.of( excluded, baseline ).selector(), combineSkips( excluded, baseline ) ],
			[ SkipSet.of( excluded, baseline ).with( collection, chrome ).selector(), combineSkips( combineSkips( combineSkips( excluded, baseline ), collection ), chrome ) ],
			[ SkipSet.of( excluded, collection, chrome ).selector(), combineSkips( combineSkips( excluded, collection ), chrome ) ],
		] ) expect( actual ).toBe( expected );
	}
} );
