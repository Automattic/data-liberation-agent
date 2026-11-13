import { totalmem } from 'node:os';
import { availableRuntimeMemory } from './runtime-memory.js';

export type RouteKind = 'reference' | 'plain';

/**
 * The working set a route reserves before any route has calibrated memory
 * admission. Reference routes (the entrypoint with its fresh reference pages,
 * every profile) peaked at 0.9 GiB on wordpress.org and 1.8 GiB on a Wix source
 * with three profiles; a small runtime still admits one route at a time.
 */
export const UNCALIBRATED_ROUTE_RESERVE_BYTES = 2 * 1024 ** 3;

/** The memory this process group may use: its cgroup limit, or the machine's when it has none. */
export function runtimeMemoryLimit(): number {
	const constrained = process.constrainedMemory();
	const machine = totalmem();
	return Number.isSafeInteger( constrained ) && constrained > 0 ? Math.min( constrained, machine ) : machine;
}

/** Per-capture memory calibration and reservation; explicit concurrency disables it. */
export function createRouteAdmission( {
	memoryLimit,
	referenceRoutes,
	report = () => {},
	availableMemory = availableRuntimeMemory,
}: {
	memoryLimit: number;
	referenceRoutes?: Set<string>;
	report?: ( message: string ) => void;
	availableMemory?: ( limit: number ) => number;
} ) {
	const enabled = memoryLimit > 0 && typeof process.availableMemory === 'function';
	// Admission reserves memory per route, so it needs a per-route estimate:
	// group growth above the idle floor (Node, Chromium and retained resources
	// with no route running), divided across the routes active when sampled.
	// The whole-group peak would count that floor and every concurrent route
	// against each new route, throttling harder the more routes overlap.
	// A route opens fresh reference pages only when it is in the reference
	// sample, so routes are estimated per kind: a sample taken while any
	// reference route runs is attributed to reference routes, one taken while
	// only routes without reference pages run is attributed to those. Until a
	// route without reference pages has been measured, it reserves the
	// reference estimate.
	const routeKind = ( url: string ): RouteKind => ! referenceRoutes || referenceRoutes.has( url ) ? 'reference' : 'plain';
	let observedWorkingSet = 0;
	let idleFloor: number | undefined;
	const routeWorkingSet: Record< RouteKind, number > = { reference: 0, plain: 0 };
	const activeRoutes: Record< RouteKind, number > = { reference: 0, plain: 0 };
	const calibrated: Record< RouteKind, boolean > = { reference: false, plain: false };
	let reportedUncalibratedAdmission = false;
	const sampleMemory = (): number => {
		const available = availableMemory( memoryLimit );
		if ( ! Number.isFinite( available ) || available < 0 ) throw new Error( 'Capture memory admission: runtime available memory is invalid' );
		const used = memoryLimit - available;
		observedWorkingSet = Math.max( observedWorkingSet, used );
		const active = activeRoutes.reference + activeRoutes.plain;
		if ( active === 0 ) idleFloor = used;
		else if ( idleFloor !== undefined ) {
			const kind: RouteKind = activeRoutes.reference ? 'reference' : 'plain';
			routeWorkingSet[ kind ] = Math.max( routeWorkingSet[ kind ], ( used - idleFloor ) / active );
		}
		return available;
	};
	// The working set to reserve for a route. Before reference calibration
	// every route reserves a conservative prior (or more, once a larger share
	// was observed), so a host with room for several such routes does not run
	// the first one alone, while a small runtime still admits one at a time.
	const routeEstimate = ( kind: RouteKind ): number => {
		if ( ! calibrated.reference ) return Math.max( UNCALIBRATED_ROUTE_RESERVE_BYTES, routeWorkingSet.reference, routeWorkingSet.plain );
		return kind === 'plain' && calibrated.plain ? routeWorkingSet.plain : routeWorkingSet.reference;
	};
	// Reserve one observed per-route working set of its kind for every
	// running route whose peak may still be ahead, plus the route being
	// admitted. Even one unseen route can exceed the budget; this admits
	// overlap, rather than enforcing a per-source byte cap.
	const admit = ( kind: RouteKind, runningKinds: Iterable<RouteKind>, completed: number ): boolean => {
		const kinds = [ ...runningKinds ];
		if ( ! enabled ) return true;
		const available = sampleMemory();
		if ( kinds.length === 0 ) {
			if ( available === 0 ) throw new Error( `Capture memory admission: no available memory at the one-route floor (limit=${ memoryLimit }, observedWorkingSet=${ observedWorkingSet })` );
			return true;
		}
		let reserved = routeEstimate( kind );
		for ( const runningKind of kinds ) reserved += routeEstimate( runningKind );
		const admitted = available >= reserved;
		if ( ! admitted && ! calibrated.reference && completed > 0 && ! reportedUncalibratedAdmission ) {
			reportedUncalibratedAdmission = true;
			const message = '[memory-admission] limited to one route: reference memory calibration unavailable (no fresh non-absent, non-alias capture completed yet)';
			report( message );
			process.stderr.write( `${ message }\n` );
		}
		return admitted;
	};
	// A second concurrent profile of a running route needs another route-sized
	// share beyond every running route's reservation.
	const roomForParallelProfiles = ( kind: RouteKind ): boolean => {
		const reserved = activeRoutes.reference * routeEstimate( 'reference' ) + activeRoutes.plain * routeEstimate( 'plain' );
		return sampleMemory() >= reserved + routeEstimate( kind );
	};

	return {
		enabled,
		kind: routeKind,
		sample: sampleMemory,
		estimate: routeEstimate,
		admit,
		roomForParallelProfiles,
		start( kind: RouteKind ) { activeRoutes[ kind ]++; },
		release( kind: RouteKind ) { activeRoutes[ kind ]--; },
		calibrate( kind: RouteKind ) {
			sampleMemory();
			if ( kind === 'reference' || routeWorkingSet.plain > 0 ) calibrated[ kind ] = true;
		},
		diagnostic( kind: RouteKind, active: number, url: string ) {
			return { limitBytes: memoryLimit, availableBytes: sampleMemory(), observedWorkingSetBytes: observedWorkingSet, idleFloorBytes: idleFloor, routeWorkingSetBytes: { reference: Math.round( routeWorkingSet.reference ), plain: Math.round( routeWorkingSet.plain ) }, reservedBytes: routeEstimate( kind ), activeRoutes: active, calibrated, kind, url };
		},
	};
}
