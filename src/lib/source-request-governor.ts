/**
 * Per-origin source request governor (#907).
 *
 * Every HTTP request a capture makes to one source origin can go through one
 * governor: template grouping and HTTP acquisition share it, so source
 * throttling slows the whole capture instead of stopping one pass.
 *
 * - At most `concurrency` HTTP requests are in flight at once. Browser
 *   fan-out is uncapped while healthy; it shares admission limits only after
 *   an origin throttle, until success-driven recovery reaches full speed.
 * - A throttle response (429 or 503) pauses new requests for the source's
 *   `Retry-After` (delta-seconds or an HTTP date, capped at
 *   `maxRetryAfterMs`), drops the in-flight limit to 1 and retries the
 *   throttled request itself, in a loop bounded by the caller's AbortSignal
 *   and `maxAttempts`, so one route a source refuses for good cannot hold
 *   the origin at one request in flight indefinitely.
 * - Each `recoveryStep` consecutive successes raise the limit by one, back up
 *   to `concurrency`.
 *
 * Throttle rates stay log-only. Documents the source keeps refusing after
 * the capture has slowed down end the capture with `source_blocked_client`
 * and bounded evidence (first refusal time and request count) for the
 * receipt. An explicit throttle status is the source's own answer; ambiguous
 * transport resets are first confirmed by escalating probes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Discovery adapters include URL-only helpers without capture options. Keep their
 * capture ownership here; parameterized browser/acquisition paths pass it explicitly. */
export const sourceRequestContext = new AsyncLocalStorage<SourceRequestGovernors>();

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

/** Earlier response, three consecutive document refusals, and at least two route paths are required. */
export const SOURCE_REFUSAL_DEFAULTS = { consecutive: 3, probeAtMs: [2000, 8000, 20000, 60000], probeTimeoutMs: 3000 } as const;

export type SourceRequestCategory = 'document' | 'device-check' | 'asset-original' | 'subresource' | 'refusal-probe' | 'retry';
export type SourceRequestCounts = Record<SourceRequestCategory, number>;
/** Page documents decide whether this client can still capture the source. */
const DOCUMENT_CATEGORIES: ReadonlySet<SourceRequestCategory> = new Set(['document', 'device-check']);

export class SourceBlockedClientError extends Error {
	readonly code = 'source_blocked_client';
	constructor(readonly evidence: { origin: string; requestsBeforeFirstRefusal: number; firstRefusalAt: string; refusal?: 'throttle' | 'transport'; requestCounts?: SourceRequestCounts }) {
		super(`source_blocked_client: The source ${evidence.origin} blocked this network; retry later or from another network.`);
	}
}

export interface SourceRequestGovernorOptions {
	/** Confirmation offsets, injectable for local fixtures; capped by maxRetryAfterMs. */
	refusalProbeAtMs?: readonly number[];
	concurrency?: number;
	maxRetryAfterMs?: number;
	fallbackRetryAfterMs?: number;
	recoveryStep?: number;
}

/** Transport refusals are source pressure signals, including nested Node fetch causes. */
export function isSourceTransportThrottle(error: unknown, refusalOnly = false): boolean {
	if (!error || typeof error !== 'object') return false;
	const value = error as { message?: string; code?: string; cause?: unknown };
	const match = /ECONNRESET|ECONNREFUSED|ERR_CONNECTION_(?:RESET|REFUSED)|connection (?:reset|refused)|(CONTENT_LENGTH_MISMATCH|content length mismatch|body length mismatch|socket hang up)/i.exec(`${value.code ?? ''} ${value.message ?? ''}`);
	return !!(match && (!refusalOnly || !match[1]))
		|| (value.cause !== error && isSourceTransportThrottle(value.cause, refusalOnly));
}

export interface GovernedRequestOptions {
	category?: SourceRequestCategory;
	/** Owning document URL, never an asset URL, for cross-route refusal proof. */
	routeUrl?: string;
	/** Browser fan-out is unlimited while healthy; shares the reduced limit during recovery. */
	browser?: boolean;
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
	requestCounts: SourceRequestCounts;
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
	private hadResponse = false;
	private responseGeneration = 0;
	private refusalCount = 0;
	private readonly refusalRoutes = new Set<string>();
	private firstRefusal?: { requestsBeforeFirstRefusal: number; firstRefusalAt: string };
	private confirmation?: Promise<void>;
	private responseWake?: () => void;
	private readonly probeAtMs: readonly number[];
	blockedClient?: SourceBlockedClientError;

	/** Persistent transport failures need navigation backoff as well as admission pacing. */
	get hasSustainedRefusal(): boolean { return this.refusalCount >= 2; }

	get isConfirmingRefusal(): boolean { return this.confirmation !== undefined; }

	async admitSourceRequest(): Promise<void> {
		await this.confirmation;
		if (this.blockedClient) throw this.blockedClient; // failure-class: operational
	}

	/** Response headers from the browser, ahead of its finished or failed body. */
	observeSourceResponse(status: number, category: SourceRequestCategory): void {
		this.observeAccess(status, undefined, category);
	}

	/**
	 * Any response proves the network reaches the source. Only a document the
	 * source serves proves this client can still capture it: a throttled
	 * document is refusal evidence, like a transport reset, and subresources
	 * neither prove nor disprove access to pages.
	 */
	private observeAccess(status: number | undefined, error: unknown, category: SourceRequestCategory, routeUrl?: string, admission?: number): void {
		if (status !== undefined) this.hadResponse = true;
		if (!DOCUMENT_CATEGORIES.has(category)) return;
		if (status !== undefined && !THROTTLE_STATUSES.has(status)) this.reachable();
		else if (status !== undefined) this.observeRefusal('throttle', routeUrl, admission);
		else if (isSourceTransportThrottle(error, true)) this.observeRefusal('transport', routeUrl, admission);
	}

	private reachable(): void {
		this.hadResponse = true;
		this.responseGeneration++;
		this.responseWake?.();
		this.refusalCount = 0;
		this.refusalRoutes.clear();
		this.firstRefusal = undefined;
	}

	/** Snapshot only admissions made at one in flight, after the latest pause. */
	refusalAdmission(): number | undefined {
		return this.browserThrottled && this.limit === 1 && Date.now() >= this.pausedUntil ? this.throttles : undefined;
	}

	private observeRefusal(refusal: 'throttle' | 'transport', routeUrl?: string, admission?: number): void {
		if (!this.hadResponse || this.confirmation || this.blockedClient) return;
		this.firstRefusal ??= { requestsBeforeFirstRefusal: this.requests - 1, firstRefusalAt: new Date().toISOString() };
		// Failures from the original fan-out (or an older backoff) are pressure,
		// not proof that this client is still refused after slowing down.
		if (admission === undefined || admission !== this.throttles) return;
		this.refusalCount++;
		if (routeUrl) this.refusalRoutes.add(new URL(routeUrl).pathname);
		if (this.refusalCount < SOURCE_REFUSAL_DEFAULTS.consecutive || this.refusalRoutes.size < 2) return;
		const evidence = { origin: this.origin, ...this.firstRefusal, refusal };
		if (refusal === 'throttle') {
			// Already admitted one at a time after each Retry-After: no probe can say more.
			this.blockedClient = new SourceBlockedClientError({ ...evidence, requestCounts: this.stats().requestCounts });
			for (const wake of this.waiters.splice(0)) wake();
			return;
		}
		const generation = this.responseGeneration;
		this.confirmation = this.confirmRefusal(routeUrl ?? this.origin, generation, evidence).finally(() => {
			this.confirmation = undefined;
			this.wake();
		});
	}

	private async confirmRefusal(url: string, generation: number, evidence: SourceBlockedClientError['evidence']): Promise<void> {
		const started = Date.now();
		for (const offset of this.probeAtMs) {
			// Reserve the probe timeout inside the total confirmation budget.
			const deadline = started + this.maxRetryAfterMs;
			await new Promise<void>(resolve => {
				const timer = setTimeout(done, Math.max(0, Math.min(started + offset, deadline - SOURCE_REFUSAL_DEFAULTS.probeTimeoutMs) - Date.now()));
				const governor = this;
				function done() { clearTimeout(timer); governor.responseWake = undefined; resolve(); }
				this.responseWake = done;
			});
			if (this.responseGeneration !== generation) return;
			try {
				this.recordRequest('refusal-probe');
				const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(SOURCE_REFUSAL_DEFAULTS.probeTimeoutMs, deadline - Date.now()))) });
				await response.body?.cancel();
				this.reachable();
				return;
			} catch (error) {
				// A timeout or unrelated failure cannot prove a client refusal.
				if (!isSourceTransportThrottle(error, true)) return;
			}
		}
		if (this.responseGeneration === generation) this.blockedClient = new SourceBlockedClientError({ ...evidence, requestCounts: this.stats().requestCounts });
	}

	private readonly maxRetryAfterMs: number;
	private readonly fallbackRetryAfterMs: number;
	private readonly recoveryStep: number;
	private limit: number;
	private active = 0;
	private successes = 0;
	private browserThrottled = false;
	private pausedUntil = 0;
	private requests = 0;
	private readonly requestCounts: SourceRequestCounts = { document: 0, 'device-check': 0, 'asset-original': 0, subresource: 0, 'refusal-probe': 0, retry: 0 };

	private recordRequest(category: SourceRequestCategory): void {
		this.requests++;
		this.requestCounts[category]++;
		this.firstRequestAt ??= Date.now();
	}
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
		this.probeAtMs = options.refusalProbeAtMs ?? SOURCE_REFUSAL_DEFAULTS.probeAtMs;
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
		return { origin: this.origin, requests: this.requests, requestCounts: { ...this.requestCounts }, throttleEvents: this.throttles, concurrency: this.limit, sustainedRate: elapsed > 0 ? this.requests / elapsed : 0 };
	}

	/**
	 * Run `task` under the governor. A throttle response is retried after its
	 * `Retry-After` until it succeeds, `maxAttempts` runs out (the last throttle
	 * response is returned) or `signal` aborts; an abort rejects with the signal's reason. A task that throws
	 * releases its slot and rethrows, except transport refusals, which throttle
	 * and retry with the fallback delay under the same attempt bound.
	 */
	async run< T extends { status: number; headers: Headers } >( task: ( attempt: number ) => Promise< T >, options: GovernedRequestOptions = {} ): Promise< GovernedResponse< T > > {
		const maxAttempts = Math.max( 1, options.maxAttempts ?? SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxAttempts );
		let throttles = 0;
		for ( let attempt = 1; ; attempt++ ) {
			await this.acquire( options.signal, options.browser );
			const refusalAdmission = this.refusalAdmission();
			let response: T;
			try {
				this.recordRequest(attempt > 1 ? 'retry' : options.category ?? 'document');
				response = await task( attempt );
			} catch (error) {
				if (!isSourceTransportThrottle(error)) throw error; // failure-class: operational
				this.observeAccess(undefined, error, options.category ?? 'document', options.routeUrl, refusalAdmission);
				throttles++;
				this.recordThrottle(this.fallbackRetryAfterMs);
				if (this.confirmation) {
					await this.admitSourceRequest();
					// Confirmation recovered: retry this interrupted acquisition, even
					// when the caller delegates ordinary retries to navigation.
					continue;
				}
				if (attempt >= maxAttempts) throw error; // failure-class: operational
				continue;
			} finally {
				this.release();
			}
			this.observeAccess(response.status, undefined, options.category ?? 'document', options.routeUrl, refusalAdmission);
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
		this.browserThrottled = true;
		this.successes = 0;
		this.pausedUntil = Math.max( this.pausedUntil, Date.now() + delayMs );
	}

	/** Outcomes observed by the browser's native network stack. */
	observeBrowserOutcome(status?: number, retryAfter?: string | null, error?: unknown, routeUrl?: string, admission?: number, category: SourceRequestCategory = 'document'): void {
		this.recordRequest(category);
		this.observeAccess(status, error, category, routeUrl, admission);
		if ((status !== undefined && THROTTLE_STATUSES.has(status)) || isSourceTransportThrottle(error)) {
			this.recordThrottle(parseRetryAfter(retryAfter, { fallbackMs: this.fallbackRetryAfterMs, maxMs: this.maxRetryAfterMs }));
		} else if (status !== undefined) this.recordSuccess();
	}

	/** Healthy native browser requests need no admission or bookkeeping slot. */
	get isBrowserThrottled(): boolean { return this.browserThrottled; }

	private recordSuccess() {
		if ( !this.browserThrottled && this.limit >= this.maxConcurrency ) return;
		if ( ++this.successes < this.recoveryStep ) return;
		this.successes = 0;
		this.limit = Math.min(this.maxConcurrency, this.limit + 1);
		if (this.limit === this.maxConcurrency) this.browserThrottled = false;
		this.wake();
	}

	/** Wait for a free slot, then for any pause to pass. */
	async acquire( signal?: AbortSignal, browser = false ): Promise< void > {
		for ( ;; ) {
			await this.admitSourceRequest();
			if ( signal?.aborted ) throw abortReason( signal ); // failure-class: operational
			if ( (browser && !this.browserThrottled) || this.active < this.limit ) {
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

	release() {
		this.active--;
		this.wake();
	}

	private wake() {
		let free = !this.browserThrottled ? this.waiters.length : this.limit - this.active;
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
	/** Capture-local file reuse, including concurrent originals; no byte cache. */
	readonly originals = new Map<string, Promise<import('./media-fetch/media.js').DownloadResult>>();
	private readonly byOrigin = new Map< string, SourceRequestGovernor >();

	constructor( private readonly defaults: SourceRequestGovernorOptions = {} ) {}

	stats(): SourceRequestGovernorStats[] {
		return [...this.byOrigin.values()].map(governor => governor.stats());
	}

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
