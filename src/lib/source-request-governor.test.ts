import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter, SOURCE_REQUEST_GOVERNOR_DEFAULTS, SourceRequestGovernor, SourceRequestGovernors } from './source-request-governor.js';

const ok = () => ( { status: 200, headers: new Headers() } );
const throttle = ( retryAfter?: string, status = 429 ) => ( { status, headers: new Headers( retryAfter === undefined ? {} : { 'retry-after': retryAfter } ) } );
const tick = () => new Promise( resolve => setTimeout( resolve, 0 ) );

afterEach( () => vi.useRealTimers() );

describe( 'parseRetryAfter', () => {
	const now = Date.parse( '2026-01-01T00:00:00Z' );

	it( 'reads delta-seconds and HTTP dates', () => {
		expect( parseRetryAfter( '0', { now } ) ).toBe( 0 );
		expect( parseRetryAfter( '3', { now } ) ).toBe( 3000 );
		expect( parseRetryAfter( ' 1.5 ', { now } ) ).toBe( 1500 );
		expect( parseRetryAfter( 'Thu, 01 Jan 2026 00:00:05 GMT', { now } ) ).toBe( 5000 );
		// A date in the past means "now".
		expect( parseRetryAfter( 'Wed, 31 Dec 2025 23:59:00 GMT', { now } ) ).toBe( 0 );
	} );

	it( 'caps the wait at the documented maximum', () => {
		expect( parseRetryAfter( '86400', { now } ) ).toBe( SOURCE_REQUEST_GOVERNOR_DEFAULTS.maxRetryAfterMs );
		expect( parseRetryAfter( '10', { now, maxMs: 2000 } ) ).toBe( 2000 );
		expect( parseRetryAfter( 'Fri, 02 Jan 2026 00:00:00 GMT', { now, maxMs: 2000 } ) ).toBe( 2000 );
	} );

	it( 'falls back for a missing or invalid header', () => {
		expect( parseRetryAfter( null, { now } ) ).toBe( SOURCE_REQUEST_GOVERNOR_DEFAULTS.fallbackRetryAfterMs );
		expect( parseRetryAfter( undefined, { now, fallbackMs: 250 } ) ).toBe( 250 );
		expect( parseRetryAfter( '', { now, fallbackMs: 250 } ) ).toBe( 250 );
		expect( parseRetryAfter( 'soon', { now, fallbackMs: 250 } ) ).toBe( 250 );
		expect( parseRetryAfter( '-5', { now, fallbackMs: 250 } ) ).toBe( 250 );
	} );
} );

describe( 'SourceRequestGovernor', () => {
	it( 'bounds requests in flight, drops to one after a throttle and recovers on successes', async () => {
		const governor = new SourceRequestGovernor( 'https://source.example', { concurrency: 4, recoveryStep: 2 } );
		let active = 0;
		let peak = 0;
		const request = ( result: () => { status: number; headers: Headers } ) => governor.run( async () => {
			active++;
			peak = Math.max( peak, active );
			await new Promise( resolve => setTimeout( resolve, 5 ) );
			active--;
			return result();
		}, { maxAttempts: 1 } );
		await Promise.all( Array.from( { length: 8 }, () => request( ok ) ) );
		expect( peak ).toBe( 4 );

		await request( () => throttle( '0' ) );
		expect( governor.throttleEvents ).toBe( 1 );
		expect( governor.concurrency ).toBe( 1 );
		peak = 0;
		await Promise.all( Array.from( { length: 2 }, () => request( ok ) ) );
		expect( peak ).toBe( 1 );
		// Two successes per step: 1 → 2 after the first pair, then 3, then 4.
		expect( governor.concurrency ).toBe( 2 );
		await Promise.all( Array.from( { length: 4 }, () => request( ok ) ) );
		expect( governor.concurrency ).toBe( 4 );
		peak = 0;
		await Promise.all( Array.from( { length: 8 }, () => request( ok ) ) );
		expect( peak ).toBe( 4 );
	} );

	it( 'retries a throttled request itself after its Retry-After', async () => {
		vi.useFakeTimers();
		const governor = new SourceRequestGovernor( 'https://source.example' );
		const task = vi.fn( async ( attempt: number ) => attempt < 3 ? throttle( attempt === 1 ? '2' : undefined, attempt === 1 ? 429 : 503 ) : ok() );
		let settled: Awaited< ReturnType< typeof governor.run > > | undefined;
		void governor.run( task ).then( result => { settled = result; } );
		await vi.advanceTimersByTimeAsync( 0 );
		expect( task ).toHaveBeenCalledTimes( 1 );
		await vi.advanceTimersByTimeAsync( 1999 );
		expect( task ).toHaveBeenCalledTimes( 1 );
		await vi.advanceTimersByTimeAsync( 1 );
		expect( task ).toHaveBeenCalledTimes( 2 );
		// No Retry-After on the 503: the fallback wait.
		await vi.advanceTimersByTimeAsync( SOURCE_REQUEST_GOVERNOR_DEFAULTS.fallbackRetryAfterMs );
		expect( task ).toHaveBeenCalledTimes( 3 );
		expect( settled ).toMatchObject( { response: { status: 200 }, attempts: 3, throttles: 2 } );
		expect( governor.throttleEvents ).toBe( 2 );
	} );

	it( 'pauses every caller of the origin, not only the throttled one', async () => {
		vi.useFakeTimers();
		const governor = new SourceRequestGovernor( 'https://source.example' );
		await governor.run( async () => throttle( '1' ), { maxAttempts: 1 } );
		const other = vi.fn( async () => ok() );
		void governor.run( other );
		await vi.advanceTimersByTimeAsync( 999 );
		expect( other ).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync( 1 );
		expect( other ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'stops after maxAttempts and returns the last throttle response', async () => {
		const governor = new SourceRequestGovernor( 'https://source.example' );
		const throttles: number[] = [];
		const result = await governor.run( async () => throttle( '0', 503 ), { maxAttempts: 3, onThrottle: status => throttles.push( status ) } );
		expect( result ).toMatchObject( { response: { status: 503 }, attempts: 3, throttles: 3 } );
		expect( throttles ).toEqual( [ 503, 503, 503 ] );
	} );

	it( 'rejects promptly when the deadline aborts a throttle wait or a queued request', async () => {
		const governor = new SourceRequestGovernor( 'https://source.example', { concurrency: 1 } );
		const deadline = AbortSignal.timeout( 50 );
		const started = Date.now();
		const task = vi.fn( async () => throttle( '30' ) );
		await expect( governor.run( task, { signal: deadline } ) ).rejects.toBeDefined();
		expect( Date.now() - started ).toBeLessThan( 1000 );
		expect( task ).toHaveBeenCalledTimes( 1 );

		const busy = new SourceRequestGovernor( 'https://source.example', { concurrency: 1 } );
		let release!: () => void;
		const holding = busy.run( () => new Promise< { status: number; headers: Headers } >( resolve => { release = () => resolve( ok() ); } ) );
		await tick();
		const controller = new AbortController();
		const queued = vi.fn( async () => ok() );
		const waiting = busy.run( queued, { signal: controller.signal } );
		controller.abort( new Error( 'deadline' ) );
		await expect( waiting ).rejects.toThrow( 'deadline' );
		release();
		await holding;
		expect( queued ).not.toHaveBeenCalled();
		// An already-aborted signal never starts a request.
		await expect( busy.run( queued, { signal: controller.signal } ) ).rejects.toThrow( 'deadline' );
	} );

	it( 'releases its slot when the task throws', async () => {
		const governor = new SourceRequestGovernor( 'https://source.example', { concurrency: 1 } );
		await expect( governor.run( async () => { throw new Error( 'reset' ); } ) ).rejects.toThrow( 'reset' );
		await expect( governor.run( async () => ok() ) ).resolves.toMatchObject( { attempts: 1 } );
	} );
} );

describe( 'SourceRequestGovernors', () => {
	it( 'hands every pass the same governor for one origin', () => {
		const governors = new SourceRequestGovernors();
		const first = governors.forOrigin( 'https://source.example/a/', { concurrency: 3 } );
		expect( governors.forOrigin( 'https://source.example/b/', { concurrency: 9 } ) ).toBe( first );
		expect( first.maxConcurrency ).toBe( 3 );
		expect( governors.forOrigin( 'https://other.example/' ) ).not.toBe( first );
	} );
} );
