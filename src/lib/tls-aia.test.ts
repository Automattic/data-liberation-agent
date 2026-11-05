import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { Server } from 'node:net';
import * as tls from 'node:tls';
import { completeSourceTlsChain } from './tls-aia.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';

const supported = typeof tls.setDefaultCACertificates === 'function';
const listen = ( server: Server ): Promise<number> => new Promise( resolve => server.listen( 0, '127.0.0.1', () => resolve( ( server.address() as { port: number } ).port ) ) );
const close = ( server: Server ): Promise<void> => new Promise( resolve => server?.close( () => resolve() ) ?? resolve() );

describe.skipIf( ! supported )( 'capture/tls-incomplete-chain-aia', () => {
	let dir: string;
	let defaults: string[];
	let aia: ReturnType<typeof httpServer>;
	let source: ReturnType<typeof httpsServer>;
	let origin: string;
	let aiaOrigin: string;
	let mode = 'valid';
	let issuerRequests = 0;
	const pem = ( name: string ) => readFileSync( join( dir, name ), 'utf8' );
	const openssl = ( ...args: string[] ) => execFileSync( 'openssl', args, { cwd: dir, stdio: 'pipe' } );

	beforeAll( async () => {
		dir = mkdtempSync( join( tmpdir(), 'capture-aia-' ) );
		defaults = tls.getCACertificates( 'default' );
		aia = httpServer( ( _req, res ) => {
			issuerRequests++;
			res.end( mode === 'malformed' ? 'not a certificate' : pem( mode === 'cycle' ? 'leaf.pem' : 'intermediate.pem' ) );
		} );
		aiaOrigin = `http://127.0.0.1:${ await listen( aia ) }`;
		openssl( 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Test Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE' );
		openssl( 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-subj', '/CN=Test Intermediate' );
		writeFileSync( join( dir, 'ca.ext' ), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' );
		openssl( 'x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'intermediate.pem', '-days', '2', '-extfile', 'ca.ext' );
		openssl( 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost' );
		writeFileSync( join( dir, 'leaf.ext' ), `basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nauthorityInfoAccess=caIssuers;URI:${ aiaOrigin }/issuer\n` );
		openssl( 'x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.pem', '-CAkey', 'intermediate.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext' );
		writeFileSync( join( dir, 'index.txt' ), '' );
		writeFileSync( join( dir, 'ca.cnf' ), '[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=intermediate.pem\nprivate_key=intermediate.key\ndefault_md=sha256\npolicy=subject\n[subject]\ncommonName=supplied\n' );
		openssl( 'ca', '-batch', '-config', 'ca.cnf', '-rand_serial', '-in', 'leaf.csr', '-out', 'expired.pem', '-notext', '-startdate', '20000101000000Z', '-enddate', '20000102000000Z', '-extfile', 'leaf.ext' );
		source = httpsServer( { key: pem( 'leaf.key' ), cert: pem( 'leaf.pem' ) }, ( _req, res ) => res.end( 'verified' ) );
		origin = `https://127.0.0.1:${ await listen( source ) }`;
	}, 20_000 );

	afterAll( async () => {
		tls.setDefaultCACertificates( defaults );
		await Promise.all( [ close( source ), close( aia ) ] );
		rmSync( dir, { recursive: true, force: true } );
	} );

	async function recover() {
		const failure = await fetch( origin ).catch( error => error );
		expect( failure ).toBeInstanceOf( Error );
		await runWithTrustedOrigins( [ origin, aiaOrigin ], () => completeSourceTlsChain( origin, failure ) );
	}

	it( 'rejects malformed, cyclic and untrusted issuers without modifying trust', async () => {
		for ( mode of [ 'malformed', 'cycle', 'valid' ] ) {
			tls.setDefaultCACertificates( defaults );
			const before = tls.getCACertificates( 'default' );
			await recover();
			expect( tls.getCACertificates( 'default' ) ).toEqual( before );
			await expect( fetch( origin ) ).rejects.toThrow();
		}
	} );

	it( 'does not chase AIA for unrelated failures or unvouched private issuer URLs', async () => {
		tls.setDefaultCACertificates( [ ...defaults, pem( 'root.pem' ) ] );
		const before = issuerRequests;
		expect( await completeSourceTlsChain( origin, new Error( 'unrelated' ) ) ).toBe( false );
		const failure = await fetch( origin ).catch( error => error );
		await runWithTrustedOrigins( [ origin ], () => completeSourceTlsChain( origin, failure ) );
		expect( issuerRequests ).toBe( before );
		await expect( fetch( origin ) ).rejects.toThrow();
	} );

	it( 'rejects expired leaves even with a trusted root', async () => {
		tls.setDefaultCACertificates( [ ...defaults, pem( 'root.pem' ) ] );
		source.setSecureContext( { key: pem( 'leaf.key' ), cert: pem( 'expired.pem' ) } );
		const before = tls.getCACertificates( 'default' );
		await recover();
		expect( tls.getCACertificates( 'default' ) ).toEqual( before );
		await expect( fetch( origin ) ).rejects.toThrow();
		source.setSecureContext( { key: pem( 'leaf.key' ), cert: pem( 'leaf.pem' ) } );
	} );

	it( 'completes the missing intermediate and leaves ordinary fetch strictly verified', async () => {
		mode = 'valid';
		tls.setDefaultCACertificates( [ ...defaults, pem( 'root.pem' ) ] );
		const before = issuerRequests;
		await recover();
		expect( issuerRequests ).toBeGreaterThan( before );
		expect( await ( await fetch( origin ) ).text() ).toBe( 'verified' );
	} );
} );
