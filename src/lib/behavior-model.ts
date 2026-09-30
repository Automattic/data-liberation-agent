import type { BehaviorTrace, SourceBehavior } from './screenshot/behavior-capture.js';

export interface LearnedTextReveal {
	selector: string;
	/** Relative to phase start; source text is evidence, never runtime replay payload. */
	startMs: number;
	intervalMs: number;
	characters: number;
	confidence: 'observed_prefix_progression';
}

/** Only classify observed one-character prefix progressions. Other DOM changes remain unknown. */
export function learnTextReveals( trace: BehaviorTrace ): LearnedTextReveal[] {
	const result: LearnedTextReveal[] = [];
	for ( const [ selector, states ] of Object.entries( trace.text ) ) {
		if ( states.length < 4 ) continue;
		const final = states.at( -1 )!.text;
		if ( final.length < 3 || final.length > 512 ) continue;
		// Cycling dots and other repeated prefixes are not a one-shot text reveal.
		const timeline = states[ 0 ].text === final && states[ 1 ]?.text !== final ? states.slice( 1 ) : states;
		const prefixes = timeline.filter( ( state ) => final.startsWith( state.text ) );
		if ( prefixes.slice( 1 ).some( ( state, index ) => state.text.length < prefixes[ index ].text.length ) ) continue;
		const frames = timeline.filter( ( state ) => state.text.length > 0 && final.startsWith( state.text ) );
		// Browsers coalesce mutation callbacks under load, so observed frames may
		// skip characters. Accept strictly growing prefixes and measure the
		// per-character rate over the whole run rather than per frame.
		let start = frames.length - 1;
		while ( start > 0 && frames[ start ].text.length > frames[ start - 1 ].text.length && frames[ start ].at > frames[ start - 1 ].at ) start--;
		const sequence = frames.slice( start );
		const first = Array.from( sequence[ 0 ]?.text ?? '' ).length;
		const last = Array.from( final ).length;
		if ( sequence.length < 3 || first > 2 || sequence.at( -1 )!.text !== final ) continue;
		const intervalMs = Math.round( ( sequence.at( -1 )!.at - sequence[ 0 ].at ) / Math.max( 1, last - first ) );
		if ( intervalMs < 5 || intervalMs > 1000 ) continue;
		// Reject bursts: a multi-character jump must have taken plausible time for
		// that rate. Single-character steps are always valid; timer jitter can
		// deliver two consecutive ticks only milliseconds apart.
		if ( sequence.slice( 1 ).some( ( frame, index ) => {
			const added = Array.from( frame.text ).length - Array.from( sequence[ index ].text ).length;
			return added > 1 && frame.at - sequence[ index ].at < ( added - 1 ) * intervalMs * .25;
		} ) ) continue;
		result.push( { selector, startMs: sequence[ 0 ].at, intervalMs, characters: Array.from( final ).length, confidence: 'observed_prefix_progression' } );
	}
	return result.sort( ( a, b ) => a.startMs - b.startMs );
}

/** Explicit evidence/model separation: a canvas trace is not a translated canvas algorithm. */
export function modelSourceBehavior( observed: SourceBehavior ) {
	return {
		schema: 'data-liberation/behavior-model/v1',
		url: observed.url,
		startup: learnTextReveals( observed.startup ),
		replays: observed.replays.map( ( replay ) => ( { trigger: replay.selector, textReveals: learnTextReveals( replay.trace ) } ) ),
		unsupported: Object.keys( observed.pointer.trace.canvas ).map( ( selector ) => ( {
			selector, capability: 'canvas-algorithm', reason: 'Drawing API observations do not reconstruct pointer-dependent source computation',
			methods: Object.keys( observed.pointer.trace.canvas[ selector ].methods ),
		} ) ),
		truncated: observed.startup.truncated || observed.pointer.trace.truncated || observed.replays.some( ( replay ) => replay.trace.truncated ),
		status: 'observed_untranslated',
	};
}

/** A counterfactual Date probe distinguishes dynamic time text from editorial prefixes. */
export function timeDependentTargets( first: SourceBehavior, second: SourceBehavior ): string[] {
	return Object.keys( first.startup.text ).filter( ( selector ) => {
		const initial = first.startup.settledText ? first.startup.settledText[ selector ] : first.startup.text[ selector ].at( -1 )?.text;
		const counterfactual = second.startup.settledText ? second.startup.settledText[ selector ] : second.startup.text[ selector ]?.at( -1 )?.text;
		return initial !== undefined && counterfactual !== undefined && initial !== counterfactual;
	} );
}
