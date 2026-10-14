import { readFileSync } from 'node:fs';

type ReadText = ( path: string ) => string;

const readText: ReadText = path => readFileSync( path, 'utf8' );

/**
 * Memory still available to this process group under `limit`, counting
 * reclaimable page cache as available.
 *
 * `process.availableMemory()` is `memory.max - memory.current` under cgroup v2,
 * and `memory.current` includes page cache. Capture writes screenshots,
 * resources and media to disk for the whole run, so that cache grows until it
 * fills the cgroup and reads as exhausted memory, although the kernel reclaims
 * it on demand. Usage here is `memory.current` minus that page cache: `file`
 * less `shmem`, since shared memory (Chromium's IPC and tmpfs) is counted in
 * `file` but cannot be dropped. Counting only inactive cache would not do:
 * the cache a route reads and writes is active while the route runs, so it
 * would inflate every per-route estimate measured from an idle floor. Without
 * a readable cgroup v2 hierarchy this is exactly `process.availableMemory()`.
 */
export function availableRuntimeMemory( limit: number, read: ReadText = readText ): number {
	const available = process.availableMemory();
	const workingSet = cgroupWorkingSet( read );
	if ( workingSet === undefined ) return available;
	return Math.max( available, Math.min( limit, Math.max( 0, limit - workingSet ) ) );
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
