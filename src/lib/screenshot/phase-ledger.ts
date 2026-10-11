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
