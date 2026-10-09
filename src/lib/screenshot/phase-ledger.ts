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

export interface PhaseLedger {
	enter( phase: string ): void;
	finish(): CapturePhase[];
}

export function createPhaseLedger( now: () => number = Date.now ): PhaseLedger {
	const phases = new Map< string, CapturePhase >();
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
		finish() {
			close( now() );
			return [ ...phases.values() ];
		},
	};
}
