/**
 * Wall-clock accounting for one capture profile.
 *
 * `enter( phase )` closes the running phase and opens the next, so a profile's
 * phases tile its whole duration with no gaps: time spent between named steps
 * is attributed to the step that preceded it rather than lost. Repeated phases
 * accumulate. The result is recorded on the profile's manifest entry, making
 * every capture its own performance evidence.
 */
export interface CapturePhase {
	phase: string;
	ms: number;
	/** Times the phase was entered, when more than once. */
	count?: number;
}

/** How a named readiness wait ended across one profile; see settleDocument. */
export interface ReadinessTally {
	count: number;
	ms: number;
	/** Waits that spent their bound instead of observing quiet. */
	deadline: number;
}

export interface PhaseLedger {
	enter( phase: string ): void;
	wait( name: string, outcome: { reason: 'quiet' | 'deadline'; ms: number } ): void;
	finish(): CapturePhase[];
	readiness(): Record< string, ReadinessTally >;
}

/**
 * One route's stage timings, summed across its capture profiles and expressed
 * in its wall-clock duration. Profiles of a route can overlap, so when their
 * sum exceeds the route's duration each stage is scaled down to its share of
 * it. Time outside every profile's ledger is reported as `other`, so the
 * values always sum to `totalMs`.
 */
export function routePhaseBreakdown( profiles: Array< Array< CapturePhase > | undefined >, totalMs: number ): Record< string, number > {
	const phases: Record< string, number > = {};
	for ( const profile of profiles ) {
		for ( const { phase, ms } of profile ?? [] ) phases[ phase ] = ( phases[ phase ] ?? 0 ) + ms;
	}
	const measured = Object.values( phases ).reduce( ( total, ms ) => total + ms, 0 );
	if ( measured > totalMs && measured > 0 ) {
		const scale = totalMs / measured;
		for ( const phase of Object.keys( phases ) ) phases[ phase ] = Math.floor( phases[ phase ]! * scale );
	}
	const accounted = Object.values( phases ).reduce( ( total, ms ) => total + ms, 0 );
	phases.other = Math.max( 0, totalMs - accounted );
	return phases;
}

export function createPhaseLedger( now: () => number = Date.now ): PhaseLedger {
	const phases = new Map< string, CapturePhase >();
	const waits: Record< string, ReadinessTally > = {};
	let current: { phase: string; startedAt: number } | null = null;
	const close = ( at: number ) => {
		if ( ! current ) return;
		const entry = phases.get( current.phase ) ?? { phase: current.phase, ms: 0 };
		entry.ms += at - current.startedAt;
		if ( phases.has( current.phase ) ) entry.count = ( entry.count ?? 1 ) + 1;
		phases.set( current.phase, entry );
		current = null;
	};
	return {
		enter( phase ) {
			const at = now();
			close( at );
			current = { phase, startedAt: at };
		},
		wait( name, outcome ) {
			const tally = waits[ name ] ??= { count: 0, ms: 0, deadline: 0 };
			tally.count++;
			tally.ms += outcome.ms;
			if ( outcome.reason === 'deadline' ) tally.deadline++;
		},
		finish() {
			close( now() );
			return [ ...phases.values() ];
		},
		readiness() {
			return { ...waits };
		},
	};
}
