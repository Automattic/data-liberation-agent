import type { Page } from 'playwright';
import { isIntegrityError } from '../failure-class.js';
import { withReadOnlyProbes } from './probe-guards.js';
import type { createPhaseBudget } from './phase-budget.js';
import type { PhaseLedger } from './phase-ledger.js';

export interface CaptureStep<C> {
	id: string;
	/** Continuation work retains the currently running phase. */
	continuePhase?: boolean;
	/** Preserve historical explicit enter plus probe enter accounting. */
	entries?: number;
	when?( ctx: C ): boolean;
	bound?: 'probe-budget';
	guard?: 'read-only';
	onFailure: 'best-effort';
	partial?: ( ctx: C, error?: unknown ) => unknown;
	run( ctx: C ): Promise<void>;
}

/** One owner for phase accounting, probe bounds, guards and containment. */
export async function runSteps<C extends { page: Page }>(
	steps: readonly CaptureStep<C>[], ctx: C,
	{ ledger, budget, rendererCrashed }: {
		ledger?: PhaseLedger;
		budget: ReturnType<typeof createPhaseBudget>;
		rendererCrashed: () => boolean;
	},
): Promise<void> {
	for ( const step of steps ) {
		if ( rendererCrashed() || budget.expired() ) return;
		if ( step.when && ! step.when( ctx ) ) continue;
		if ( ! step.continuePhase ) for ( let i = 0; i < ( step.entries ?? 1 ); i++ ) ledger?.enter( step.id );
		try {
			const drive = () => step.guard === 'read-only'
				? withReadOnlyProbes( ctx.page, () => step.run( ctx ) ) : step.run( ctx );
			if ( step.bound === 'probe-budget' ) {
				await budget.run( step.id, drive, undefined );
				if ( budget.expired() ) step.partial?.( ctx );
			} else await drive();
		} catch ( error ) {
			if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
			ledger?.fail( step.id );
			step.partial?.( ctx, error );
		}
	}
}

/** Immutable selector composition, preserving order, duplicates and spacing. */
export class SkipSet {
	private constructor( private readonly selectors: Array<string | undefined> ) {}
	static of( ...selectors: Array<string | undefined> ): SkipSet { return new SkipSet( selectors ); }
	with( ...selectors: Array<string | undefined> ): SkipSet { return SkipSet.of( ...this.selectors, ...selectors ); }
	selector(): string | undefined { return this.selectors.filter( Boolean ).join( ', ' ) || undefined; }
}
