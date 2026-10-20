/**
 * Per-origin source request governor (#907).
 *
 * Every HTTP request a capture makes to one source origin can go through one
 * governor: template grouping and HTTP acquisition share it, so source
 * throttling slows the whole capture instead of stopping one pass.
 *
 * - At most `concurrency` requests are in flight at once.
 * - A throttle response (429 or 503) pauses new requests for the source's
 *   `Retry-After` (delta-seconds or an HTTP date, capped at
 *   `maxRetryAfterMs`), drops the in-flight limit to 1 and retries the
 *   throttled request itself, in a loop bounded by the caller's AbortSignal
 *   and `maxAttempts`, so one route a source refuses for good cannot hold
 *   the origin at one request in flight indefinitely.
 * - Each `recoveryStep` consecutive successes raise the limit by one, back up
 *   to `concurrency`.
 *
 * The governor counts throttle events but stores no timestamps in anything a
 * caller reports; `stats()` timing is for logs only.
 */

export const SOURCE_REQUEST_GOVERNOR_DEFAULTS = {
	/** Requests in flight per origin, as in rendered inspection (#746). */
	concurrency: 6,
	/** Longest `Retry-After` honoured; a larger request waits this long. */
	maxRetryAfterMs: 60_000,
	/** Wait when a throttle response has no usable `Retry-After`. */
	fallbackRetryAfterMs: 1000,
	/** Consecutive successes before the in-flight limit grows by one. */
	recoveryStep: 4,
	/** Requests per governed call, the first included, before a throttle response is returned to the caller. */
	maxAttempts: 10,
} as const;

/** Statuses a source uses to say "slow down". */
export const THROTTLE_STATUSES: ReadonlySet< number > = new Set( [ 429, 503 ] );

/**
 * A `Retry-After` header as milliseconds: delta-seconds or an HTTP date,
 * clamped to `[0, maxMs]`. A missing or unparseable header is `fallbackMs`.
 */
export function parseRetryAfter( header: string | null | undefined, options: { fallbackMs?: number; maxMs?: number; now?: number } = {} ): number {
	const fallbackMs = options.fallbackMs ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.fallbackRetryAfterMs;
	const maxMs = options.maxMs ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxRetryAfterMs;
	const value = header?.trim() ?? '';
	let requested = Number.NaN;
	if ( /^\d+(?:\.\d+)?$/.test( value ) ) requested = Number( value ) * 1000;
	// An HTTP date names its weekday and month; `Date.parse` also reads bare numbers such as `-5` as years.
	else if ( /[a-z]/i.test( value ) ) requested = Date.parse( value ) - ( options.now ?? Date.now() );
	return Math.min( maxMs, Math.max( 0, Number.isFinite( requested ) ? requested : fallbackMs ) );
}

export interface SourceRequestGovernorOptions {
	concurrency?: number;
	maxRetryAfterMs?: number;
	fallbackRetryAfterMs?: number;
	recoveryStep?: number;
}

export interface GovernedRequestOptions {
	/** Rejects waits and stops retrying once aborted. */
	signal?: AbortSignal;
	/** Requests at most, the first included. Default `SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxAttempts`. */
	maxAttempts?: number;
	/** Called for each throttle response, before the governor waits to retry it. */
	onThrottle?: ( status: number ) => void;
}

export interface GovernedResponse< T > {
	/** The last response: a success, a non-throttle failure, or the final throttle once `maxAttempts` ran out. */
	response: T;
	attempts: number;
	/** Throttle responses this call received. */
	throttles: number;
}

export interface SourceRequestGovernorStats {
	origin: string;
	requests: number;
	throttleEvents: number;
	/** Current in-flight limit. */
	concurrency: number;
	/** Requests per second since the first request; logs only. */
	sustainedRate: number;
}

function abortReason( signal: AbortSignal ): unknown {
	return signal.reason ?? new DOMException( 'The operation was aborted', 'AbortError' );
}

export class SourceRequestGovernor {
	readonly origin: string;
	readonly maxConcurrency: number;
	private readonly maxRetryAfterMs: number;
	private readonly fallbackRetryAfterMs: number;
	private readonly recoveryStep: number;
	private limit: number;
	private active = 0;
	private successes = 0;
	private pausedUntil = 0;
	private requests = 0;
	private throttles = 0;
	private firstRequestAt: number | undefined;
	private readonly waiters: Array< () => void > = [];

	constructor( origin: string, options: SourceRequestGovernorOptions = {} ) {
		this.origin = origin;
		this.maxConcurrency = Math.max( 1, Math.floor( options.concurrency ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.concurrency ) || 1 );
		this.maxRetryAfterMs = options.maxRetryAfterMs ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxRetryAfterMs;
		this.fallbackRetryAfterMs = options.fallbackRetryAfterMs ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.fallbackRetryAfterMs;
		this.recoveryStep = Math.max( 1, options.recoveryStep ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.recoveryStep );
		this.limit = this.maxConcurrency;
	}

	/** Throttle responses seen by every caller of this governor. */
	get throttleEvents(): number {
		return this.throttles;
	}

	/** In-flight limit right now: `maxConcurrency`, or less while recovering from a throttle. */
	get concurrency(): number {
		return this.limit;
	}

	stats(): SourceRequestGovernorStats {
		const elapsed = this.firstRequestAt === undefined ? 0 : ( Date.now() - this.firstRequestAt ) / 1000;
		return { origin: this.origin, requests: this.requests, throttleEvents: this.throttles, concurrency: this.limit, sustainedRate: elapsed > 0 ? this.requests / elapsed : 0 };
	}

	/**
	 * Run `task` under the governor. A throttle response is retried after its
	 * `Retry-After` until it succeeds, `maxAttempts` runs out (the last throttle
	 * response is returned) or `signal` aborts; an abort rejects with the signal's reason. A task that throws
	 * releases its slot and rethrows.
	 */
	async run< T extends { status: number; headers: Headers } >( task: ( attempt: number ) => Promise< T >, options: GovernedRequestOptions = {} ): Promise< GovernedResponse< T > > {
		const maxAttempts = Math.max( 1, options.maxAttempts ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxAttempts );
		let throttles = 0;
		for ( let attempt = 1; ; attempt++ ) {
			await this.acquire( options.signal );
			let response: T;
			try {
				this.requests++;
				this.firstRequestAt ??= Date.now();
				response = await task( attempt );
			} finally {
				this.release();
			}
			if ( ! THROTTLE_STATUSES.has( response.status ) ) {
				this.recordSuccess();
				return { response, attempts: attempt, throttles };
			}
			throttles++;
			this.recordThrottle( parseRetryAfter( response.headers.get( 'retry-after' ), { fallbackMs: this.fallbackRetryAfterMs, maxMs: this.maxRetryAfterMs } ) );
			options.onThrottle?.( response.status );
			// The next acquire rejects once the signal has aborted.
			if ( attempt >= maxAttempts ) return { response, attempts: attempt, throttles };
		}
	}

	private recordThrottle( delayMs: number ) {
		this.throttles++;
		this.limit = 1;
		this.successes = 0;
		this.pausedUntil = Math.max( this.pausedUntil, Date.now() + delayMs );
	}

	private recordSuccess() {
		if ( this.limit >= this.maxConcurrency ) return;
		if ( ++this.successes < this.recoveryStep ) return;
		this.successes = 0;
		this.limit++;
		this.wake();
	}

	/** Wait for a free slot, then for any pause to pass. */
	private async acquire( signal?: AbortSignal ): Promise< void > {
		for ( ;; ) {
			if ( signal?.aborted ) throw abortReason( signal ); // failure-class: operational
			if ( this.active < this.limit ) {
				const wait = this.pausedUntil - Date.now();
				if ( wait <= 0 ) {
					this.active++;
					return;
				}
				await this.sleep( wait, signal );
				continue;
			}
			await new Promise< void >( ( resolve, reject ) => {
				const onAbort = () => {
					const index = this.waiters.indexOf( wake );
					if ( index >= 0 ) this.waiters.splice( index, 1 );
					reject( abortReason( signal! ) ); // failure-class: operational
				};
				const wake = () => {
					signal?.removeEventListener( 'abort', onAbort );
					resolve();
				};
				this.waiters.push( wake );
				signal?.addEventListener( 'abort', onAbort, { once: true } );
			} );
		}
	}

	private release() {
		this.active--;
		this.wake();
	}

	private wake() {
		let free = this.limit - this.active;
		while ( free-- > 0 && this.waiters.length ) this.waiters.shift()!();
	}

	private sleep( ms: number, signal?: AbortSignal ): Promise< void > {
		return new Promise< void >( ( resolve, reject ) => {
			const onAbort = () => {
				clearTimeout( timer );
				reject( abortReason( signal! ) ); // failure-class: operational
			};
			const timer = setTimeout( () => {
				signal?.removeEventListener( 'abort', onAbort );
				resolve();
			}, ms );
			signal?.addEventListener( 'abort', onAbort, { once: true } );
		} );
	}
}

/**
 * One governor per source origin, owned by a capture. Every pass that
 * requests the same origin gets the same instance; the first request for an
 * origin fixes its options.
 */
export class SourceRequestGovernors {
	private readonly byOrigin = new Map< string, SourceRequestGovernor >();

	constructor( private readonly defaults: SourceRequestGovernorOptions = {} ) {}

	forOrigin( url: string, options: SourceRequestGovernorOptions = {} ): SourceRequestGovernor {
		const origin = new URL( url ).origin;
		let governor = this.byOrigin.get( origin );
		if ( ! governor ) {
			governor = new SourceRequestGovernor( origin, { ...this.defaults, ...options } );
			this.byOrigin.set( origin, governor );
		}
		return governor;
	}
}
