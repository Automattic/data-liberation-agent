import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type ReadText = ( path: string ) => string;
/** Returns `vm_stat` output, or undefined when the reading is unavailable. */
type ReadVmStat = () => string | undefined;

const readText: ReadText = path => readFileSync( path, 'utf8' );

const VM_STAT_TTL_MS = 1000;

/**
 * A `vm_stat` reader that spawns the command at most once per TTL. Admission
 * samples every 100 ms, and a process spawn per sample would cost more than
 * the samples are worth; available memory moves on a seconds timescale
 * relative to per-route admission decisions. Failures share the TTL, so a
 * broken `vm_stat` does not turn into a spawn per sample either.
 */
export function vmStatReader(
	run: () => string = () => execFileSync( 'vm_stat', { encoding: 'utf8', timeout: 2000 } ) as string,
	ttlMs: number = VM_STAT_TTL_MS,
	now: () => number = Date.now,
): ReadVmStat {
	let cache: { at: number; output: string | undefined } | undefined;
	return () => {
		const at = now();
		if ( cache !== undefined && at - cache.at < ttlMs ) return cache.output;
		let output: string | undefined;
		try {
			output = run();
		} catch {
			output = undefined;
		}
		cache = { at, output };
		return output;
	};
}

// The reader is spawned only where it exists and only when the cgroup path
// cannot answer; everywhere else admission keeps the runtime's own reading.
const darwinVmStat: ReadVmStat | undefined = process.platform === 'darwin' ? vmStatReader() : undefined;

/**
 * Reclaimable memory from `vm_stat` output: free, inactive, purgeable and
 * speculative pages × page size. On darwin, `process.availableMemory()` is
 * libuv's free-page count, so it excludes inactive, purgeable and speculative
 * pages the kernel reclaims on demand — reading it alone serializes capture
 * admission on Macs long before the machine is out of memory. All four
 * counters and the page size are required; anything else falls back to the
 * runtime's reading rather than under-reporting what the kernel can reclaim.
 */
export function reclaimableMemoryFromVmStat( output: string | undefined ): number | undefined {
	if ( output === undefined ) return undefined;
	const pageSize = Number( output.match( /page size of (\d+) bytes/ )?.[ 1 ] );
	if ( ! Number.isSafeInteger( pageSize ) || pageSize <= 0 ) return undefined;
	const pages = ( name: string ) => Number( output.match( new RegExp( `^Pages ${ name }:\\s+(\\d+)\\.\\s*$`, 'm' ) )?.[ 1 ] );
	const free = pages( 'free' ), inactive = pages( 'inactive' ), purgeable = pages( 'purgeable' ), speculative = pages( 'speculative' );
	if ( [ free, inactive, purgeable, speculative ].some( value => ! Number.isSafeInteger( value ) ) ) return undefined;
	return ( free + inactive + purgeable + speculative ) * pageSize;
}

/**
 * Memory still available to this process group under `limit`, counting
 * reclaimable memory as available.
 *
 * Under cgroup v2, `process.availableMemory()` is `memory.max - memory.current`,
 * and `memory.current` includes page cache. Capture writes screenshots,
 * resources and media to disk for the whole run, so that cache grows until it
 * fills the cgroup and reads as exhausted memory, although the kernel reclaims
 * it on demand. Usage here is `memory.current` minus that page cache: `file`
 * less `shmem`, since shared memory (Chromium's IPC and tmpfs) is counted in
 * `file` but cannot be dropped. Counting only inactive cache would not do:
 * the cache a route reads and writes is active while the route runs, so it
 * would inflate every per-route estimate measured from an idle floor.
 *
 * On darwin there is no cgroup hierarchy and `process.availableMemory()` is
 * free pages only; the reclaimable reading from `vm_stat` (free + inactive +
 * purgeable + speculative) replaces it, sampled through a throttled reader.
 *
 * In both cases the result never drops below the runtime's own reading and is
 * never more than the limit. Without a readable cgroup v2 hierarchy or a
 * working `vm_stat` this is exactly `process.availableMemory()`.
 */
export function availableRuntimeMemory(
	limit: number,
	read: ReadText = readText,
	vmStat: ReadVmStat | undefined = darwinVmStat,
): number {
	const available = process.availableMemory();
	const workingSet = cgroupWorkingSet( read );
	let best = available;
	if ( workingSet !== undefined ) best = Math.max( best, Math.min( limit, Math.max( 0, limit - workingSet ) ) );
	let output: string | undefined;
	try {
		output = vmStat?.();
	} catch {
		output = undefined;
	}
	const reclaimable = reclaimableMemoryFromVmStat( output );
	if ( reclaimable !== undefined ) best = Math.max( best, Math.min( limit, reclaimable ) );
	return best;
}

function cgroupWorkingSet( read: ReadText ): number | undefined {
	try {
		// cgroup v2 lists this process's group as `0::<path>`, as libuv reads it.
		const path = read( '/proc/self/cgroup' ).split( '\n' ).find( line => line.startsWith( '0::' ) )?.slice( 3 ).trim();
		if ( path === undefined ) return undefined;
		const directory = `/sys/fs/cgroup${ path === '/' ? '' : path }`;
		const current = Number( read( `${ directory }/memory.current` ).trim() );
		const stat = read( `${ directory }/memory.stat` );
		const field = ( name: string ) => Number( stat.match( new RegExp( `^${ name } (\\d+)$`, 'm' ) )?.[ 1 ] );
		const file = field( 'file' ), shmem = field( 'shmem' );
		if ( ! Number.isSafeInteger( current ) || ! Number.isSafeInteger( file ) || ! Number.isSafeInteger( shmem ) ) return undefined;
		return Math.max( 0, current - Math.max( 0, file - shmem ) );
	} catch {
		return undefined;
	}
}
