import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as netServer, type Server } from 'node:net';
import { fetchEntryDocument } from './capture.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';
import { SourceRequestGovernors } from './source-request-governor.js';

/**
 * One port that speaks HTTPS with a certificate for another domain and plain
 * HTTP, like a shared host serving its own certificate for a customer domain.
 */
describe( 'entry document over a broken HTTPS certificate', () => {
	let dir: string;
	let server: Server;
	let port: number;
	let httpHandler: RequestListener = () => {};

	beforeAll( async () => {
		dir = mkdtempSync( join( tmpdir(), 'entry-http-' ) );
		execFileSync( 'openssl', [ 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-subj', '/CN=shared-host.example', '-days', '2', '-addext', 'subjectAltName=DNS:shared-host.example' ], { cwd: dir, stdio: 'pipe' } );
		const secure = httpsServer( { key: readFileSync( join( dir, 'key.pem' ) ), cert: readFileSync( join( dir, 'cert.pem' ) ) }, ( _req, res ) => res.end( 'secure' ) );
		const plain = httpServer( ( req, res ) => httpHandler( req, res ) );
		server = netServer( socket => socket.once( 'data', chunk => {
			socket.pause();
			socket.unshift( chunk );
			( chunk[ 0 ] === 0x16 ? secure : plain ).emit( 'connection', socket );
			process.nextTick( () => socket.resume() );
		} ) );
		port = await new Promise( resolve => server.listen( 0, '127.0.0.1', () => resolve( ( server.address() as { port: number } ).port ) ) );
	}, 20_000 );

	afterAll( async () => {
		await new Promise( resolve => server.close( resolve ) );
		rmSync( dir, { recursive: true, force: true } );
	} );

	const fetchEntry = () => runWithTrustedOrigins( [ `https://127.0.0.1:${ port }`, `http://127.0.0.1:${ port }` ], () =>
		fetchEntryDocument( `https://127.0.0.1:${ port }/about?x=1`, new SourceRequestGovernors(), { session: false } ) );

	it( 'continues from the HTTP address when it serves the page', async () => {
		httpHandler = ( _req, res ) => { res.setHeader( 'content-type', 'text/html' ); res.end( '<title>plain</title>' ); };
		const response = await fetchEntry();
		expect( response.finalUrl ).toBe( `http://127.0.0.1:${ port }/about?x=1` );
		expect( response.body.toString() ).toBe( '<title>plain</title>' );
	} );

	it( 'reports the certificate failure when HTTP redirects back to HTTPS', async () => {
		httpHandler = ( req, res ) => { res.writeHead( 301, { location: `https://127.0.0.1:${ port }${ req.url }` } ); res.end(); };
		await expect( fetchEntry() ).rejects.toThrow( /ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|self-signed/ );
	} );
} );
