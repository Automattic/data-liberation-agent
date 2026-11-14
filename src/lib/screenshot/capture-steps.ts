import type { Page } from 'playwright';
import { isIntegrityError } from '../failure-class.js';
import { withReadOnlyProbes } from './probe-guards.js';
import type { createPhaseBudget } from './phase-budget.js';
import type { PhaseLedger } from './phase-ledger.js';
import { withEvaluateTimeout } from './page-helpers.js';

export interface CaptureStep<C> {
	id: string;
	/** Continuation work retains the currently running phase. */
	continuePhase?: boolean;
	when?( ctx: C ): boolean;
	bound?: 'probe-budget' | { evaluateMs: number };
	guard?: 'read-only';
	/** `throw` preserves mandatory work that had no local containment. */
	onFailure: 'best-effort' | 'drop-profile' | 'throw';
	/** Existing failure evidence/fallback; also called on probe-budget expiry. */
	partial?: ( ctx: C, error?: unknown ) => unknown;
	run( ctx: C ): Promise<void>;
}

/** One owner for phase accounting, probe bounds, guards and containment.
 * Returns false when the profile stops, true when every eligible step ran.
 */
export async function runSteps<C extends { page: Page }>(
	steps: readonly CaptureStep<C>[], ctx: C,
	{ ledger, budget, rendererCrashed }: {
		ledger?: PhaseLedger;
		budget?: ReturnType<typeof createPhaseBudget>;
		rendererCrashed: () => boolean;
	},
): Promise<boolean> {
	for ( const step of steps ) {
		if ( rendererCrashed() || budget?.expired() ) return false;
		if ( step.when && ! step.when( ctx ) ) continue;
		if ( ! step.continuePhase ) ledger?.enter( step.id );
		try {
			const drive = () => step.guard === 'read-only'
				? withReadOnlyProbes( ctx.page, () => step.run( ctx ) ) : step.run( ctx );
			if ( step.bound === 'probe-budget' ) {
				if ( budget ) await budget.run( step.id, drive, undefined );
				else await drive();
				if ( budget?.expired() ) step.partial?.( ctx );
			} else if ( step.bound ) await withEvaluateTimeout( drive(), step.bound.evaluateMs );
			else await drive();
		} catch ( error ) {
			if ( isIntegrityError( error ) || step.onFailure === 'throw' ) throw error; // failure-class: integrity
			ledger?.fail( step.id );
			step.partial?.( ctx, error );
			if ( step.onFailure === 'drop-profile' ) return false;
		}
	}
	return true;
}

/** Immutable selector composition, preserving order, duplicates and spacing. */
export class SkipSet {
	private constructor( private readonly selectors: Array<string | undefined> ) {}
	static of( ...selectors: Array<string | undefined> ): SkipSet { return new SkipSet( selectors ); }
	with( ...selectors: Array<string | undefined> ): SkipSet { return SkipSet.of( ...this.selectors, ...selectors ); }
	selector(): string | undefined { return this.selectors.filter( Boolean ).join( ', ' ) || undefined; }
}
