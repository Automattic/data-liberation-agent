import { ROUTE_OMITTED_BY_BUDGET } from './route-budget.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { ROUTE_CAPTURE_SKIPPED_BUDGET, ROUTE_CAPTURE_TIMEOUT } from './capture-usability.js';

/**
 * Capture time budget (`CaptureOptions.timeBudgetMs`).
 *
 * The budget is the time from the start of `captureWebsite` until export must
 * begin. Inside it:
 *
 * 1. Route admission closes at `admitUntil` (budget minus grace). No new route
 *    starts after that, except the entrypoint, which is always admitted first.
 *    With `routeReserveMs`, every started route (entrypoint included) also
 *    holds that much of the budget for downstream work — export, or a
 *    caller's build whose cost scales with captured routes — so admission
 *    closes once the remaining window can no longer cover all reserves plus
 *    the candidate's. Routes left out this way are reported like other budget
 *    skips (`route_capture_skipped_budget`), with the reserve named in the
 *    reason. Routes already running are unaffected: `abandonAt` stays where
 *    it is.
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
	/** Project admission from observed route cost rather than only the clock. */
	projectAdmission?: boolean;
	/**
	 * Milliseconds of the budget held per started route for downstream work
	 * (`CaptureOptions.routeReserveMs`), so admission closes early enough that
	 * every route started still leaves its reserve unspent. Undefined: no
	 * per-route reserve.
	 */
	routeReserveMs?: number;
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

/**
 * Sane per-route deadline floor (ms). One route's bounded duration never
 * drops below this, however small the time budget or large the concurrency:
 * the deadline exists to bound a stalled route, not to cap a slow but
 * progressing one. The slowest routes observed during profiling completed in
 * about 8 minutes, so the floor sits above them.
 */
export const ROUTE_DEADLINE_MIN_MS = 600_000;

export function validateRouteDeadlineMs( routeDeadlineMs: unknown ): void {
	if ( routeDeadlineMs !== undefined && ( typeof routeDeadlineMs !== 'number' || ! Number.isSafeInteger( routeDeadlineMs ) || routeDeadlineMs < 0 ) )
		throw new RangeError( 'routeDeadlineMs must be a non-negative integer number of milliseconds (0 disables the deadline)' );
}

export function validateTimeBudgetMs( timeBudgetMs: unknown ): void {
	if ( timeBudgetMs !== undefined && ( typeof timeBudgetMs !== 'number' || ! Number.isSafeInteger( timeBudgetMs ) || timeBudgetMs < 1 ) )
		throw new RangeError( 'timeBudgetMs must be a positive integer number of milliseconds' );
}

export function validateRouteReserveMs( routeReserveMs: unknown ): void {
	if ( routeReserveMs !== undefined && ( typeof routeReserveMs !== 'number' || ! Number.isSafeInteger( routeReserveMs ) || routeReserveMs < 0 ) )
		throw new RangeError( 'routeReserveMs must be a non-negative integer number of milliseconds' );
}

export function captureTimeBudgetWindow( startedAt: number, timeBudgetMs: number, routeReserveMs?: number ): CaptureTimeBudgetWindow {
	const grace = Math.min( CAPTURE_BUDGET_MAX_GRACE_MS, Math.floor( timeBudgetMs * CAPTURE_BUDGET_GRACE_FRACTION ) );
	return {
		timeBudgetMs,
		...( routeReserveMs !== undefined ? { routeReserveMs } : {} ),
		admitUntil: startedAt + timeBudgetMs - grace,
		abandonAt: startedAt + timeBudgetMs,
	};
}

/**
 * Derive the per-route capture deadline (`CaptureOptions.routeDeadlineMs`).
 * An explicit non-zero deadline wins; zero disables the deadline. Otherwise
 * the deadline is the capture time budget divided by the admitted
 * concurrency — the share of the budget one stalled route is allowed to
 * consume — never below `ROUTE_DEADLINE_MIN_MS`. Without a budget the floor
 * still bounds a stalled route, which otherwise holds its slot until some
 * outer (host) deadline ends the whole capture.
 */
export function deriveRouteDeadlineMs( routeDeadlineMs: number | undefined, timeBudgetMs: number | undefined, concurrency: number ): number {
	if ( routeDeadlineMs !== undefined ) return routeDeadlineMs;
	if ( timeBudgetMs === undefined ) return ROUTE_DEADLINE_MIN_MS;
	return Math.max( ROUTE_DEADLINE_MIN_MS, Math.floor( timeBudgetMs / Math.max( 1, concurrency ) ) );
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
	private readonly startTimes = new Map< string, number >();
	private elapsedTotal = 0;
	private finishedCount = 0;
	private admissionClosed = false;
	private readonly committed = new Set< string >();
	private readonly abandoned = new Set< string >();
	/** The browser was closed at the deadline; nothing may relaunch it. */
	abandoning = false;

	constructor( readonly window: CaptureTimeBudgetWindow, readonly entrypoint: string, private readonly now: () => number = Date.now ) {}

	/** The entrypoint is always admitted; any other route only before admission closes. */
	admits( url: string, admittedConcurrency = this.running.size + 1 ): boolean {
		if ( url === this.entrypoint ) return true;
		if ( this.abandoning || this.now() >= this.admitDeadline() ) return false;
		if ( ! this.window.projectAdmission ) return true;
		// 127 seconds was the worst observed per-route duration behind the
		// former count cap. Replace it as soon as this run supplies evidence.
		const duration = this.finishedCount ? this.elapsedTotal / this.finishedCount : 127_000;
		const now = this.now();
		let work = duration;
		for ( const startedAt of this.startTimes.values() ) work += Math.max( 0, duration - ( now - startedAt ) );
		const projected = Math.max( duration, work / Math.max( 1, admittedConcurrency ) );
		if ( now + projected <= this.admitDeadline() ) return true;
		// Running routes can still revise the estimate; only close permanently
		// when the pool is idle, avoiding both premature truncation and a spin.
		if ( ! this.running.size ) this.admissionClosed = true;
		return false;
	}

	/**
	 * Admission deadline for one more route: `admitUntil` less each started
	 * route's downstream reserve, counting the candidate (`routeReserveMs`).
	 * The entrypoint holds its reserve too, so capture hands the next stage no
	 * more routes than the reserved budget covers. Without a reserve this is
	 * `admitUntil`.
	 */
	private admitDeadline(): number {
		const reserve = this.window.routeReserveMs;
		return reserve === undefined ? this.window.admitUntil : this.window.admitUntil - reserve * ( this.started.size + 1 );
	}

	/** Admission has closed and the entrypoint has started: start no more work. */
	closed(): boolean {
		return this.started.has( this.entrypoint ) && ( this.abandoning || this.admissionClosed || this.now() >= this.window.admitUntil );
	}

	start( url: string ): void {
		this.started.add( url );
		this.running.add( url );
		this.startTimes.set( url, this.now() );
	}

	finish( url: string ): void {
		this.running.delete( url );
		const startedAt = this.startTimes.get( url );
		if ( startedAt !== undefined ) {
			this.elapsedTotal += this.now() - startedAt;
			this.finishedCount++;
			this.startTimes.delete( url );
		}
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
		const { timeBudgetMs, routeReserveMs, admitUntil, abandonAt } = this.window;
		const budget = routeReserveMs === undefined
			? `capture time budget ${ timeBudgetMs }ms`
			: `capture time budget ${ timeBudgetMs }ms with ${ routeReserveMs }ms reserved per route`;
		for ( const url of urls ) {
			if ( seen.has( url ) ) continue;
			seen.add( url );
			const reason = ! this.started.has( url )
				? `${ budget }: route admission closed ${ timeBudgetMs - ( abandonAt - admitUntil ) }ms into the capture, before this route started`
				: this.abandoned.has( url ) ? `${ budget }: abandoned in flight at the deadline` : undefined;
			if ( reason ) {
				// A reserve bounds what capture hands downstream, so a route it
				// leaves out is a missing route like any other budget skip, not
				// scope omission.
				if ( this.window.projectAdmission && routeReserveMs === undefined && ! this.started.has( url ) ) rows.push( { code: ROUTE_OMITTED_BY_BUDGET, url, reason: `${ budget }: projected route cost exceeds remaining admission window` } );
				else rows.push( { code: ROUTE_CAPTURE_SKIPPED_BUDGET, url, reason, unit: 'route', severity: 'error', metrics: { timeBudgetMs } } );
			}
		}
		return rows;
	}
}

/** What a route abandoned at its per-route deadline was doing when it stalled. */
export interface RouteDeadlineAbandonment {
	phase: string;
	profile?: string;
}

/**
 * Per-route capture deadline. Each route started with the monitor gets one
 * bounded duration; a route that exceeds it is abandoned — its browser
 * contexts are closed so its in-flight waits fail instead of running on, its
 * slot is freed for the next route, and it records one
 * `route_capture_timeout` missing-route diagnostic naming the phase it
 * entered last. Routes that finish in time are unaffected.
 */
export class RouteDeadlines {
	private readonly timers = new Map< string, NodeJS.Timeout >();
	private readonly current = new Map< string, RouteDeadlineAbandonment >();
	private readonly abandoned = new Map< string, RouteDeadlineAbandonment >();
	private readonly expiryResolvers = new Map< string, () => void >();

	constructor( readonly deadlineMs: number, private readonly abandon: ( url: string, abandonment: RouteDeadlineAbandonment ) => void ) {}

	/** Whether the deadline applies at all (zero disables it). */
	get enabled(): boolean {
		return this.deadlineMs > 0;
	}

	/**
	 * Start the deadline for one admitted route and return a promise that
	 * settles when the route either commits or hits its deadline, so the
	 * caller's slot frees at the deadline even if abandonment unwinds slowly.
	 */
	start( url: string ): Promise< void > {
		const expiry = new Promise< void >( resolve => this.expiryResolvers.set( url, resolve ) );
		// Disabled, the promise settles only when the route finishes: the caller
		// races it against the route to free the slot, so it must never settle first.
		if ( ! this.enabled ) return expiry;
		const timer = setTimeout( () => this.fire( url ), this.deadlineMs );
		timer.unref?.();
		this.timers.set( url, timer );
		return expiry;
	}

	/** Record the phase a still-running route entered last, and its profile. */
	note( url: string, phase: string, profile?: string ): void {
		if ( this.timers.has( url ) ) this.current.set( url, { phase, profile } );
	}

	private fire( url: string ): void {
		const abandonment = this.current.get( url ) ?? { phase: 'unknown' };
		this.current.delete( url );
		this.timers.delete( url );
		this.abandoned.set( url, abandonment );
		this.abandon( url, abandonment );
		this.expiryResolvers.get( url )?.();
	}

	/**
	 * Called once a route is about to record its outcome. False when the route
	 * was abandoned at its deadline: it must record nothing, so a late settle
	 * after its contexts were closed cannot record partial artifacts.
	 */
	commit( url: string ): boolean {
		return ! this.abandoned.has( url );
	}

	/** The timer for a route has ended. */
	finish( url: string ): void {
		const timer = this.timers.get( url );
		if ( timer ) {
			clearTimeout( timer );
			this.timers.delete( url );
		}
		this.current.delete( url );
		this.expiryResolvers.get( url )?.();
		this.expiryResolvers.delete( url );
	}
}

/** One `route_capture_timeout` finding per route the deadline abandoned. */
export function routeTimeoutDiagnostic( url: string, deadlineMs: number, abandonment: RouteDeadlineAbandonment ): RouteDiagnostic {
	const where = abandonment.profile ? ` in the ${ abandonment.profile } profile` : '';
	return {
		code: ROUTE_CAPTURE_TIMEOUT, url,
		reason: `route capture deadline ${ deadlineMs }ms: abandoned during the "${ abandonment.phase }" phase${ where }`,
		unit: 'route', severity: 'error', metrics: { routeDeadlineMs: deadlineMs },
	};
}
