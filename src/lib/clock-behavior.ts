import type { SourceBehavior } from './screenshot/behavior-capture.js';
import { timeDependentTargets } from './behavior-model.js';

export interface ClockBinding { selector: string; role: string; confidence: 'two_controlled_dates' }

/** Match dynamic targets against controlled local time semantics, never their ID or source text labels. */
export function learnClockBindings( first: SourceBehavior, second: SourceBehavior ): { bindings: ClockBinding[]; unsupported: string[] } {
	const bindings: ClockBinding[] = [];
	const unsupported: string[] = [];
	for ( const selector of timeDependentTargets( first, second ) ) {
		const a = first.startup.settledText?.[ selector ]?.trim();
		const b = second.startup.settledText?.[ selector ]?.trim();
		const roles = Object.keys( first.clockSamples ?? {} ).filter( ( role ) => a === first.clockSamples?.[ role ] && b === second.clockSamples?.[ role ] );
		if ( roles.length === 1 ) bindings.push( { selector, role: roles[ 0 ], confidence: 'two_controlled_dates' } );
		else unsupported.push( selector );
	}
	return { bindings, unsupported };
}
