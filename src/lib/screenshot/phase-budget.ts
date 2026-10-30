import type { Page } from 'playwright';
import type { ProfileDiagnostic } from './manifest-queue.js';

/** All post-baseline probes share this allocation; most route time remains for
 * baseline capture, other profiles, recording and resource cleanup. A timeout
 * closes the probe page: racing alone would leave browser evaluations driving
 * the source and mutating evidence after the phase returned. */
export function createPhaseBudget( page: Page, routeDeadlineMs: number, diagnostic: ( value: ProfileDiagnostic ) => void, overrun: ( ms: number ) => void = () => {} ) {
	const ms = Math.max( 1, Math.min( 30_000, ( routeDeadlineMs || 600_000 ) / 10 ) );
	const end = Date.now() + Math.min( 90_000, ( routeDeadlineMs || 600_000 ) / 4 );
	const spent = new Map<string, number>();
	let expired = false;
	return {
		expired: () => expired,
		async run<T>( phase: string, drive: () => Promise<T>, partial: T ): Promise<T> {
			if ( expired ) return partial;
			const started = Date.now();
			const remaining = Math.max( 0, Math.min( ms - ( spent.get( phase ) ?? 0 ), end - started ) );
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<T>( resolve => {
				timer = setTimeout( () => {
					expired = true;
					overrun( Date.now() - started );
					diagnostic( { code: 'interaction_phase_budget_exceeded', reason: `${ phase } exceeded ${ ms }ms; partial interaction evidence retained; remaining probes skipped` } );
					void page.close( { runBeforeUnload: false } ).catch( () => {} );
					resolve( partial );
				}, remaining );
			} );
			try { return await Promise.race( [ drive(), timeout ] ); }
			finally {
				if ( timer ) clearTimeout( timer );
				spent.set( phase, ( spent.get( phase ) ?? 0 ) + Date.now() - started );
			}
		},
	};
}
