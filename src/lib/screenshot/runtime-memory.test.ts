import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableRuntimeMemory, reclaimableMemoryFromVmStat, vmStatReader } from './runtime-memory.js';

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

// `vm_stat` reports pages of the hardware page size, counters ending in a period.
function vmStat( { pageSize = 16384, free = 0, inactive = 0, purgeable = 0, speculative = 0 }: { pageSize?: number; free?: number; inactive?: number; purgeable?: number; speculative?: number } = {} ) {
	// Real macOS layout: a colon after each label, counters right-aligned, ending in a period.
	const row = ( label: string, value: number ) => `${ `${ label }:`.padEnd( 30 ) }${ String( value ).padStart( 16 ) }.\n`;
	return `Mach Virtual Memory Statistics: (page size of ${ pageSize } bytes)\n`
		+ row( 'Pages free', free )
		+ row( 'Pages active', 1000 )
		+ row( 'Pages inactive', inactive )
		+ row( 'Pages speculative', speculative )
		+ row( 'Pages throttled', 0 )
		+ row( 'Pages wired down', 2000 )
		+ row( 'Pages purgeable', purgeable )
		+ row( '"Translation faults"', 3000 )
		+ row( 'Pages purged', 3000 );
}

// The cgroup cases describe Linux; keep the host's own vm_stat out of them.
const noVmStat = () => undefined;

describe( 'availableRuntimeMemory', () => {
	afterEach( () => vi.restoreAllMocks() );

	it( 'counts page cache written by capture as available, active or not', () => {
		// Measured shape at 2 GB: ~900 MiB of processes, 430 MiB of written output in cache.
		const read = container( { anonMiB: 900, cacheMiB: 430 } );
		expect( process.availableMemory() ).toBe( 718 * MiB );
		expect( availableRuntimeMemory( limit, read, noVmStat ) ).toBe( 1148 * MiB );
	} );

	it( 'does not count shared memory or process memory as available', () => {
		const read = container( { anonMiB: 1500, cacheMiB: 0, shmemMiB: 300 } );
		expect( availableRuntimeMemory( limit, read, noVmStat ) ).toBe( 248 * MiB );
	} );

	it( 'reads the cgroup named in /proc/self/cgroup, not the hierarchy root', () => {
		const read = container( { anonMiB: 700, cacheMiB: 300, path: '/system.slice/capture.scope' } );
		expect( availableRuntimeMemory( limit, read, noVmStat ) ).toBe( 1348 * MiB );
	} );

	it( 'is exactly process.availableMemory() without a cgroup v2 hierarchy', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( {} ), noVmStat ) ).toBe( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( { '/proc/self/cgroup': '12:memory:/docker/abc\n' } ), noVmStat ) ).toBe( 321 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': 'max\n', '/sys/fs/cgroup/memory.stat': '' } ), noVmStat ) ).toBe( 321 * MiB );
	} );

	it( 'never reports less than the runtime does, nor more than the limit', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 900 * MiB );
		const heavier = cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': `${ 1900 * MiB }`, '/sys/fs/cgroup/memory.stat': 'file 0\nshmem 0' } );
		expect( availableRuntimeMemory( limit, heavier, noVmStat ) ).toBe( 900 * MiB );
		const emptier = cgroup( { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': '0', '/sys/fs/cgroup/memory.stat': `file ${ 4096 * MiB }\nshmem 0` } );
		expect( availableRuntimeMemory( limit, emptier, noVmStat ) ).toBe( limit );
	} );

	it( 'on darwin counts inactive, purgeable and speculative pages the runtime reading leaves out', () => {
		// Free pages alone read as ~100 MiB; the kernel can still reclaim 600 MiB.
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 100 * MiB );
		const read = cgroup( {} );
		const vmStat_ = () => vmStat( { free: 100 * MiB / 16384, inactive: 300 * MiB / 16384, purgeable: 100 * MiB / 16384, speculative: 200 * MiB / 16384 } );
		expect( availableRuntimeMemory( limit, read, vmStat_ ) ).toBe( 700 * MiB );
	} );

	it( 'keeps the darwin reading within the limit and never below the runtime reading', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 900 * MiB );
		expect( availableRuntimeMemory( limit, cgroup( {} ), () => vmStat( { free: 4000 * MiB / 16384, inactive: 4000 * MiB / 16384 } ) ) ).toBe( limit );
		expect( availableRuntimeMemory( limit, cgroup( {} ), () => vmStat( { free: 10 * MiB / 16384 } ) ) ).toBe( 900 * MiB );
	} );

	it( 'falls back to the runtime reading when vm_stat is unavailable or unparseable', () => {
		vi.spyOn( process, 'availableMemory' ).mockReturnValue( 321 * MiB );
		for ( const vmStat_ of [ () => undefined, () => 'not vm_stat output', () => vmStat( { pageSize: 0 } ), () => vmStat().replace( 'Pages purgeable', 'Pages other' ), () => { throw new Error( 'spawn failed' ); } ] ) {
			expect( availableRuntimeMemory( limit, cgroup( {} ), vmStat_ ) ).toBe( 321 * MiB );
		}
	} );
} );

describe( 'reclaimableMemoryFromVmStat', () => {
	it( 'multiplies the four reclaimable counters by the reported page size', () => {
		// Apple silicon reports 16 KiB pages; Intel reports 4 KiB.
		expect( reclaimableMemoryFromVmStat( vmStat( { pageSize: 4096, free: 3, inactive: 5, purgeable: 7, speculative: 11 } ) ) ).toBe( 26 * 4096 );
		expect( reclaimableMemoryFromVmStat( vmStat( { free: 1, inactive: 2, purgeable: 3, speculative: 4 } ) ) ).toBe( 10 * 16384 );
	} );

	it.runIf( process.platform === 'darwin' )( 'parses the vm_stat output of the running machine', () => {
		expect( reclaimableMemoryFromVmStat( vmStatReader()() ) ).toBeGreaterThan( 0 );
	} );

	it( 'is undefined without every counter or a page size', () => {
		expect( reclaimableMemoryFromVmStat( undefined ) ).toBeUndefined();
		expect( reclaimableMemoryFromVmStat( vmStat().replace( 'Pages inactive', 'Pages held' ) ) ).toBeUndefined();
		expect( reclaimableMemoryFromVmStat( vmStat().replace( 'page size of 16384 bytes', 'page size unknown' ) ) ).toBeUndefined();
	} );
} );

describe( 'vmStatReader', () => {
	it( 'runs the command at most once per TTL and caches failures for the same TTL', () => {
		let nowMs = 0;
		let runs = 0;
		const run = vi.fn( () => {
			runs++;
			if ( runs === 2 ) throw new Error( 'boom' );
			return vmStat();
		} );
		const read = vmStatReader( run, 1000, () => nowMs );
		expect( read() ).toBeDefined();
		expect( read() ).toBeDefined();
		nowMs = 999;
		expect( read() ).toBeDefined();
		expect( run ).toHaveBeenCalledTimes( 1 );
		nowMs = 1000;
		expect( read() ).toBeUndefined();
		nowMs = 1500;
		expect( read() ).toBeUndefined();
		expect( run ).toHaveBeenCalledTimes( 2 );
		nowMs = 2000;
		expect( read() ).toBeDefined();
		expect( run ).toHaveBeenCalledTimes( 3 );
	} );
} );
