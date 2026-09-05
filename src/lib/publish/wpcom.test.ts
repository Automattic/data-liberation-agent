import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wpcomTarget } from './wpcom.js';

const dirs: string[] = [];

function site(): string {
	const directory = mkdtempSync( join( tmpdir(), 'dla-wpcom-' ) );
	dirs.push( directory );
	writeFileSync( join( directory, 'index.html' ), '<h1>Home</h1>' );
	mkdirSync( join( directory, 'assets' ) );
	writeFileSync( join( directory, 'assets', 'site.css' ), 'body{}' );
	return directory;
}

function json( body: unknown, status = 200 ): Response {
	return new Response( JSON.stringify( body ), {
		status,
		headers: { 'content-type': 'application/json' },
	} );
}

afterEach( () => {
	vi.unstubAllGlobals();
	for ( const directory of dirs.splice( 0 ) ) rmSync( directory, { recursive: true, force: true } );
} );

describe( 'wpcomTarget', () => {
	it( 'uploads, approves the exact plan, and returns the live site receipt', async () => {
		const fetchMock = vi.fn( async ( input: string | URL | Request, init?: RequestInit ) => {
			const url = String( input );
			if ( url === 'https://uploads.example/upload' ) return json( { success: true } );
			if ( url.endsWith( '/upload-complete' ) ) return json( { session_id: 'abc123', state: 'artifact_queued' } );
			if ( url.endsWith( '/approve' ) ) return json( { session_id: 'abc123', state: 'queued' } );
			if ( url.endsWith( '/abc123' ) ) {
				const statusCalls = fetchMock.mock.calls.filter( ( call ) => String( call[ 0 ] ).endsWith( '/abc123' ) );
				return statusCalls.length === 1
					? json( { session_id: 'abc123', state: 'preview_ready', plan_hash: 'plan-sha' } )
					: json( {
						session_id: 'abc123',
						state: 'finished',
						site_url: 'https://example.wordpress.com/',
						receipt: { success: true, pages: 1 },
					} );
			}
			if ( url.endsWith( '/static-site-import-session' ) ) {
				return json( {
					session_id: 'abc123',
					state: 'awaiting_upload',
					upload: { url: 'https://uploads.example/upload', token: 'upload-token', filename: 'site.zip' },
				} );
			}
			throw new Error( `Unexpected request: ${ url } ${ init?.method ?? 'GET' }` );
		} );
		vi.stubGlobal( 'fetch', fetchMock );

		const result = await wpcomTarget.publish( {
			directory: site(),
			token: 'oauth-token',
			destination: 'example.wordpress.com',
			approve: true,
		} );

		expect( result ).toMatchObject( {
			target: 'wpcom',
			liveUrl: 'https://example.wordpress.com/',
			files: 2,
		} );
		const createCall = fetchMock.mock.calls.find( ( call ) => String( call[ 0 ] ).endsWith( '/static-site-import-session' ) )!;
		const createBody = JSON.parse( String( createCall[ 1 ]?.body ) );
		expect( createBody.source ).toMatchObject( {
			type: 'artifact_upload',
			files: 2,
			entrypoint: 'index.html',
		} );
		expect( createBody.source.sha256 ).toMatch( /^[a-f0-9]{64}$/ );
		expect( createBody.source.bytes ).toBeGreaterThan( 0 );

		const uploadCall = fetchMock.mock.calls.find( ( call ) => String( call[ 0 ] ) === 'https://uploads.example/upload' )!;
		expect( new Headers( uploadCall[ 1 ]?.headers ).get( 'authorization' ) ).toBe( 'Bearer upload-token' );
		expect( new Headers( uploadCall[ 1 ]?.headers ).get( 'authorization' ) ).not.toContain( 'oauth-token' );
		expect( ( ( uploadCall[ 1 ]?.body as FormData ).get( 'file' ) as Blob ).size ).toBe( createBody.source.bytes );

		const approveCall = fetchMock.mock.calls.find( ( call ) => String( call[ 0 ] ).endsWith( '/approve' ) )!;
		expect( JSON.parse( String( approveCall[ 1 ]?.body ) ) ).toEqual( { plan_hash: 'plan-sha' } );
	} );

	it( 'requires explicit approval after planning', async () => {
		vi.stubGlobal( 'fetch', vi.fn( async ( input: string | URL | Request ) => {
			const url = String( input );
			if ( url === 'https://uploads.example/upload' ) return json( {} );
			if ( url.endsWith( '/upload-complete' ) ) return json( { state: 'artifact_queued' } );
			if ( url.endsWith( '/abc123' ) ) {
				return json( { session_id: 'abc123', state: 'preview_ready', plan_hash: 'review-me' } );
			}
			return json( {
				session_id: 'abc123',
				state: 'awaiting_upload',
				upload: { url: 'https://uploads.example/upload', token: 'upload-token', filename: 'site.zip' },
			} );
		} ) );

		await expect( wpcomTarget.publish( {
			directory: site(),
			token: 'oauth-token',
			destination: 'example.wordpress.com',
		} ) ).rejects.toMatchObject( { code: 'approval_required' } );
	} );

	it( 'resumes a preview without creating or uploading another session', async () => {
		const fetchMock = vi.fn( async ( input: string | URL | Request ) => {
			const url = String( input );
			if ( url.endsWith( '/abc123/approve' ) ) {
				return json( { session_id: 'abc123', state: 'queued' } );
			}
			if ( url.endsWith( '/abc123' ) ) {
				const statusCalls = fetchMock.mock.calls.filter( ( call ) => String( call[ 0 ] ).endsWith( '/abc123' ) );
				return statusCalls.length === 1
					? json( { session_id: 'abc123', state: 'preview_ready', plan_hash: 'plan-sha' } )
					: json( {
						session_id: 'abc123',
						state: 'finished',
						site_url: 'https://example.wordpress.com/',
						receipt: { success: true },
					} );
			}
			throw new Error( `Unexpected request: ${ url }` );
		} );
		vi.stubGlobal( 'fetch', fetchMock );

		const result = await wpcomTarget.publish( {
			directory: site(),
			token: 'oauth-token',
			destination: 'example.wordpress.com',
			session: 'abc123',
			approve: true,
		} );

		expect( result.liveUrl ).toBe( 'https://example.wordpress.com/' );
		expect( fetchMock.mock.calls.some( ( call ) => String( call[ 0 ] ) === 'https://uploads.example/upload' ) ).toBe( false );
		expect( fetchMock.mock.calls.some( ( call ) => String( call[ 0 ] ).endsWith( '/static-site-import-session' ) ) ).toBe( false );
	} );

	it( 'rejects resuming a session bound to another archive', async () => {
		vi.stubGlobal( 'fetch', vi.fn( async () => json( {
			session_id: 'abc123',
			state: 'preview_ready',
			source_digest: '0'.repeat( 64 ),
			plan_hash: 'plan-sha',
		} ) ) );

		await expect( wpcomTarget.publish( {
			directory: site(),
			token: 'oauth-token',
			destination: 'example.wordpress.com',
			session: 'abc123',
			approve: true,
		} ) ).rejects.toMatchObject( { code: 'session_source_mismatch' } );
	} );

	it( 'requires a token and destination before reading the site', async () => {
		await expect( wpcomTarget.publish( { directory: '/missing' } ) ).rejects.toMatchObject( {
			code: 'token_required',
		} );
		await expect( wpcomTarget.publish( { directory: '/missing', token: 'token' } ) ).rejects.toMatchObject( {
			code: 'site_required',
		} );
	} );
} );
