import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify( execFile );
const fixture = fileURLToPath( new URL( './fixtures/renderer-crash-child.mjs', import.meta.url ) );

async function capture( mode: string ) {
	// A fatal protocol assertion must fail the child, not disappear into Vitest's
	// unhandled-error reporting. Exercise real Chromium and the capture pipeline.
	const { stdout, stderr } = await run( process.execPath, [ '--import', 'tsx', fixture, mode ], {
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
	} );
	expect( stderr ).not.toMatch( /Assertion|uncaught|chrome-fidelity.*skipped/ );
	return JSON.parse( stdout.trim().split( '\n' ).at( -1 )! );
}

describe( 'renderer crash recovery in a child process', () => {
	it( 'retries once in a fresh context without restarting a connected browser', async () => {
		const evidence = await capture( 'recover' );
		expect( evidence.attempts ).toBe( 2 );
		expect( evidence.crashes ).toBe( 1 );
		expect( evidence.result ).toMatchObject( { captured: 2, failed: 0, browserRestarts: 0 } );
		expect( evidence.failures ).toEqual( [] );
		expect( evidence.entry ).toMatchObject( { html: 'html/homepage.html', desktop: 'screenshots/desktop/homepage.png' } );
		expect( evidence.logs.filter( ( log: string ) => log.startsWith( '[retry]' ) ) ).toHaveLength( 1 );
	}, 65_000 );

	it( 'keeps a repeated crash failed with attempt two and captures the later route', async () => {
		const evidence = await capture( 'persistent' );
		expect( evidence.attempts ).toBe( 2 );
		expect( evidence.crashes ).toBe( 2 );
		expect( evidence.result ).toMatchObject( { captured: 1, failed: 1, browserRestarts: 0 } );
		expect( evidence.failures ).toMatchObject( [ { stage: 'evaluate', error: 'source renderer crashed', attempt: 2 } ] );
		expect( evidence.entry.html ).toBeUndefined();
		expect( evidence.logs.filter( ( log: string ) => log.startsWith( '[retry]' ) ) ).toHaveLength( 1 );
	}, 65_000 );
} );
