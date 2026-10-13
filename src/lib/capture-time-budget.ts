import type { RouteDiagnostic } from './capture-export-routes.js';
import { ROUTE_CAPTURE_SKIPPED_BUDGET } from './capture-usability.js';

/**
 * Capture time budget (`CaptureOptions.timeBudgetMs`).
 *
 * The budget is the time from the start of `captureWebsite` until export must
 * begin. Inside it:
 *
 * 1. Route admission closes at `admitUntil` (budget minus grace). No new route
 *    starts after that, except the entrypoint, which is always admitted first.
 * 2. Routes already running get the grace window to finish. At `abandonAt` (the
 *    end of the budget) the browser is closed and every route still running is
 *    abandoned, bounded by `CAPTURE_BUDGET_DRAIN_MS`. The entrypoint is never
 *    abandoned: if it is still running, the capture waits for it (its own
 *    navigation and stage timeouts bound it).
 * 3. Section media downloads stop starting at `abandonAt`.
 *
 * Export, the homepage preview and the fidelity reference then run on what was
 * captured. Every route left uncaptured is a `route_capture_skipped_budget`
 * finding (unit `route`, a missing route).
 */
export interface CaptureTimeBudgetWindow {
	timeBudgetMs: number;
	/** Epoch ms after which no route other than the entrypoint starts. */
	admitUntil: number;
	/** Epoch ms at which routes still running are abandoned. */
	abandonAt: number;
}

/** Longest window in-flight routes get to finish after admission closes. */
export const CAPTURE_BUDGET_MAX_GRACE_MS = 60_000;
/** Share of the budget reserved as that grace window, up to the maximum. */
export const CAPTURE_BUDGET_GRACE_FRACTION = 0.25;
/** How long abandoned routes get to unwind after the browser is closed. */
export const CAPTURE_BUDGET_DRAIN_MS = 5_000;

export function validateTimeBudgetMs( timeBudgetMs: unknown ): void {
	if ( timeBudgetMs !== undefined && ( typeof timeBudgetMs !== 'number' || ! Number.isSafeInteger( timeBudgetMs ) || timeBudgetMs < 1 ) )
		throw new RangeError( 'timeBudgetMs must be a positive integer number of milliseconds' );
}

export function captureTimeBudgetWindow( startedAt: number, timeBudgetMs: number ): CaptureTimeBudgetWindow {
	const grace = Math.min( CAPTURE_BUDGET_MAX_GRACE_MS, Math.floor( timeBudgetMs * CAPTURE_BUDGET_GRACE_FRACTION ) );
	return { timeBudgetMs, admitUntil: startedAt + timeBudgetMs - grace, abandonAt: startedAt + timeBudgetMs };
}

/** Wait for `promise`, at most `ms`. */
async function bounded( promise: Promise< unknown >, ms: number ): Promise< void > {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race( [ promise, new Promise< void >( resolve => { timer = setTimeout( resolve, ms ); } ) ] );
	} finally {
		if ( timer ) clearTimeout( timer );
	}
}

/**
 * Route admission under a capture time budget, for one browser capture run.
 * The route pool asks it whether the next route may start, waits through it,
 * and lets it abandon the routes still running at the deadline.
 */
export class RouteTimeBudget {
	private readonly started = new Set< string >();
	private readonly running = new Set< string >();
	private readonly committed = new Set< string >();
	private readonly abandoned = new Set< string >();
	/** The browser was closed at the deadline; nothing may relaunch it. */
	abandoning = false;

	constructor( readonly window: CaptureTimeBudgetWindow, readonly entrypoint: string, private readonly now: () => number = Date.now ) {}

	/** The entrypoint is always admitted; any other route only before admission closes. */
	admits( url: string ): boolean {
		return url === this.entrypoint || ( ! this.abandoning && this.now() < this.window.admitUntil );
	}

	/** Admission has closed and the entrypoint has started: start no more work. */
	closed(): boolean {
		return this.started.has( this.entrypoint ) && ( this.abandoning || this.now() >= this.window.admitUntil );
	}

	start( url: string ): void {
		this.started.add( url );
		this.running.add( url );
	}

	finish( url: string ): void {
		this.running.delete( url );
	}

	/**
	 * Called once a route is about to record its outcome. False when the route
	 * was abandoned: it must record nothing, so a late finish can't race export.
	 */
	commit( url: string ): boolean {
		if ( this.abandoned.has( url ) ) return false;
		this.committed.add( url );
		return true;
	}

	/** Wait for a running route to settle, waking at the deadline if one is due. */
	async wait( running: ReadonlySet< Promise< void > > ): Promise< void > {
		const remaining = this.window.abandonAt - this.now();
		if ( remaining > 0 ) await bounded( Promise.race( running ), remaining );
		else await Promise.race( running );
	}

	/**
	 * At the deadline, abandon every running route that has not committed its
	 * outcome, unless the entrypoint is still running. `close` stops the
	 * browser so abandoned routes fail fast; their settlement is awaited for at
	 * most `CAPTURE_BUDGET_DRAIN_MS`. Returns whether routes were abandoned.
	 */
	async abandonIfDue( running: ReadonlySet< Promise< void > >, close: () => Promise< void > ): Promise< boolean > {
		if ( this.abandoning || this.now() < this.window.abandonAt || this.running.has( this.entrypoint ) ) return false;
		const abandoned = [ ...this.running ].filter( url => ! this.committed.has( url ) );
		if ( ! abandoned.length ) return false;
		for ( const url of abandoned ) this.abandoned.add( url );
		this.abandoning = true;
		await close();
		await this.drain( running );
		return true;
	}

	/** Await settlement of running routes, bounded once routes were abandoned. */
	async drain( running: ReadonlySet< Promise< void > > ): Promise< void > {
		const settled = Promise.allSettled( running );
		if ( this.abandoning ) await bounded( settled, CAPTURE_BUDGET_DRAIN_MS );
		else await settled;
	}

	/** One `route_capture_skipped_budget` finding per route the budget left uncaptured. */
	diagnostics( urls: readonly string[] ): RouteDiagnostic[] {
		const rows: RouteDiagnostic[] = [];
		const seen = new Set< string >();
		const { timeBudgetMs, admitUntil, abandonAt } = this.window;
		const budget = `capture time budget ${ timeBudgetMs }ms`;
		for ( const url of urls ) {
			if ( seen.has( url ) ) continue;
			seen.add( url );
			const reason = ! this.started.has( url )
				? `${ budget }: route admission closed ${ timeBudgetMs - ( abandonAt - admitUntil ) }ms into the capture, before this route started`
				: this.abandoned.has( url ) ? `${ budget }: abandoned in flight at the deadline` : undefined;
			if ( reason ) rows.push( { code: ROUTE_CAPTURE_SKIPPED_BUDGET, url, reason, unit: 'route', severity: 'error', metrics: { timeBudgetMs } } );
		}
		return rows;
	}
}
