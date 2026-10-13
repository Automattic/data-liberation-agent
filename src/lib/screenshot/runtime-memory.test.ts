import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableRuntimeMemory } from './runtime-memory.js';

const MiB = 1024 ** 2;
const limit = 2048 * MiB;

function cgroup( files: Record< string, string > ) {
	return ( path: string ) => {
		if ( ! ( path in files ) ) throw Object.assign( new Error( `ENOENT: ${ path }` ), { code: 'ENOENT' } );
		return files[ path ]!;
	};
}

// memory.current = anon + file (page cache and shmem). Node's availableMemory() is limit - current.
function container( { anonMiB, cacheMiB, shmemMiB = 0, path = '/' }: { anonMiB: number; cacheMiB: number; shmemMiB?: number; path?: string } ) {
	const directory = `/sys/fs/cgroup${ path === '/' ? '' : path }`;
	const current = ( anonMiB + cacheMiB + shmemMiB ) * MiB;
	vi.spyOn( process, 'availableMemory' ).mockReturnValue( limit - current );
	return cgroup( {
		'/proc/self/cgroup': `0::${ path }\n`,
		[ `${ directory }/memory.current` ]: `${ current }\n`,
		[ `${ directory }/memory.stat` ]: `anon ${ anonMiB * MiB }\nfile ${ ( cacheMiB + shmemMiB ) * MiB }\nactive_file ${ cacheMiB * MiB }\ninactive_file 0\nshmem ${ shmemMiB * MiB }\n`,
	} );
}

describe( 'availableRuntimeMemory', () => {
	afterEach( () => vi.restoreAllMocks() );

	it( 'counts page cache written by capture as available, active or not', () => {
		// Measured shape at 2 GB: ~900 MiB of processes, 430 MiB of written output in cache.
		const read = container( { anonMiB: 900, cacheMiB: 430 } );
		expect( process.availableMemory() ).toBe( 718 * MiB );
		expect( availableRuntimeMemory( limit, read ) ).toBe( 1148 * MiB );
	} );

	it( 'does not count shared memory or process memory as available', () => {
		const read = container( { anonMiB: 1500, cacheMiB: 0, shmemMiB: 300 } );
		expect( availableRuntimeMemory( limit, read ) ).toBe( 248 * MiB );
	} );

	it( 'reads the cgroup named in /proc/self/cgroup, not the hierarchy root', () => {
		const read = container( { anonMiB: 700, cacheMiB: 300, path: '/system.slice/capture.scope' } );
		expect( availableRuntimeMemory( limit, read ) ).toBe( 1348 * MiB );
	} );

	it( 'is exactly process.availableMemory() without a cgroup v2 hierarchy', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( {} ) ) ).toBe( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( { '/proc/self/cgroup': '12:memory:/docker/abc\n' } ) ) ).toBe( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': 'max\n', '/sys/fs/cgroup/memory.stat': '' } ) ) ).toBe( 321 * MiB );
	} );

	it( 'never reports less than the runtime does, nor more than the limit', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 900 * MiB );
		const heavier = cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': `${ 1900 * MiB }`, '/sys/fs/cgroup/memory.stat': 'file 0\nshmem 0' } );
		expect( availableRuntimeMemory( limit, heavier ) ).toBe( 900 * MiB );
		const emptier = cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': '0', '/sys/fs/cgroup/memory.stat': `file ${ 4096 * MiB }\nshmem 0` } );
		expect( availableRuntimeMemory( limit, emptier ) ).toBe( limit );
	} );
} );
