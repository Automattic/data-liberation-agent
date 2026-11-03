import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { assertPublicHttpUrl, safeFetch } from './media-fetch/safe-fetch.js';

const MISSING_ISSUER = new Set( [ 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ] );
const inFlight = new Map<string, Promise<void>>();
const MAX_DEPTH = 5;
const TIMEOUT_MS = 8000;

/** No HTTP data is sent on the inspection connection. Only the final, verified
 * connection may authorize installing intermediates for subsequent Node fetches.
 */
function peerChain( url: URL, ca: string[] | undefined, inspect: boolean, signal: AbortSignal ): Promise<X509Certificate[]> {
	return new Promise( ( resolve, reject ) => {
		const host = url.hostname.replace( /^\[|\]$/g, '' );
		const socket = tls.connect( {
			host, port: Number( url.port || 443 ),
			servername: isIP( host ) ? undefined : host, rejectUnauthorized: ! inspect, ca,
		} );
		const abort = () => socket.destroy( new Error( 'TLS preflight timed out' ) );
		signal.addEventListener( 'abort', abort, { once: true } );
		socket.once( 'close', () => signal.removeEventListener( 'abort', abort ) );
		socket.once( 'error', reject );
		if ( signal.aborted ) abort();
		socket.once( 'secureConnect', () => {
			const chain: X509Certificate[] = [];
			let cert = socket.getPeerCertificate( true );
			const seen = new Set<string>();
			while ( cert?.raw && chain.length < 10 ) {
				const parsed = new X509Certificate( cert.raw );
				if ( seen.has( parsed.fingerprint256 ) ) break;
				seen.add( parsed.fingerprint256 );
				chain.push( parsed );
				cert = cert.issuerCertificate;
			}
			socket.destroy();
			resolve( chain );
		} );
	} );
}

function valid( cert: X509Certificate ): boolean {
	return Date.parse( cert.validFrom ) <= Date.now() && Date.parse( cert.validTo ) > Date.now();
}

function issuedBy( cert: X509Certificate, issuer: X509Certificate ): boolean {
	return issuer.ca && valid( issuer ) && cert.checkIssued( issuer ) && cert.verify( issuer.publicKey );
}

async function preflight( url: URL ): Promise<void> {
	// These APIs arrived after the minimum supported Node version. Older Node
	// retains its normal verification behavior, without an insecure fallback.
	if ( typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function' ) return;
	const signal = AbortSignal.timeout( TIMEOUT_MS );
	try {
		await peerChain( url, undefined, false, signal );
		return;
	} catch ( error ) {
		if ( ! MISSING_ISSUER.has( ( error as NodeJS.ErrnoException ).code ?? '' ) ) return;
	}
	try {
		const chain = await peerChain( url, undefined, true, signal );
		if ( ! chain.length || chain.some( cert => ! valid( cert ) ) ) return;
		for ( let i = 1; i < chain.length; i++ ) if ( ! issuedBy( chain[ i - 1 ], chain[ i ] ) ) return;
		const defaults = tls.getCACertificates( 'default' );
		const roots = defaults.map( pem => new X509Certificate( pem ) );
		const added: string[] = [];
		const seen = new Set( chain.map( cert => cert.fingerprint256 ) );
		let last = chain[ chain.length - 1 ];
		for ( let depth = 0; depth <= MAX_DEPTH; depth++ ) {
			if ( roots.some( root => issuedBy( last, root ) ) ) {
				if ( ! added.length ) return;
				const intermediates = [ ...chain.slice( 1 ).map( cert => cert.toString() ), ...added ];
				// OpenSSL still checks hostname, constraints, purpose, dates and the
				// complete chain. Never enable allowPartialTrustChain.
				await peerChain( url, [ ...defaults, ...intermediates ], false, signal );
				// Merge at commit time: concurrent origins must not lose each other's CAs.
				tls.setDefaultCACertificates( [ ...new Set( [ ...tls.getCACertificates( 'default' ), ...intermediates ] ) ] );
				return;
			}
			if ( depth === MAX_DEPTH ) return;
			const issuerUrl = last.infoAccess?.match( /^CA Issuers - URI:(https?:\/\/[^\r\n]+)$/m )?.[ 1 ];
			if ( ! issuerUrl ) return;
			// Same SSRF, redirect and byte policies as all other capture requests.
			const response = await safeFetch( issuerUrl, { signal, timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024, maxRedirects: 3 } );
			if ( response.status !== 200 ) return;
			const issuer = new X509Certificate( response.body );
			if ( seen.has( issuer.fingerprint256 ) || ! issuedBy( last, issuer ) ) return;
			seen.add( issuer.fingerprint256 );
			added.push( issuer.toString() );
			last = issuer;
		}
	} catch {
		// Recovery is best effort. The capture's normal request reports the
		// original verification/network failure; no trust is changed on failure.
	}
}

/** capture/tls-incomplete-chain-aia: once per capture origin, shared by transports. */
export async function completeSourceTlsChain( rawUrl: string, failure: unknown ): Promise<boolean> {
	const codes = new Set<string>();
	let cause = failure;
	for ( let i = 0; i < 5 && cause && typeof cause === 'object'; i++ ) {
		codes.add( String( ( cause as NodeJS.ErrnoException ).code ) );
		cause = ( cause as Error ).cause;
	}
	if ( ! [ ...codes ].some( code => MISSING_ISSUER.has( code ) ) ) return false;
	const url = assertPublicHttpUrl( rawUrl );
	if ( url.protocol !== 'https:' ) return false;
	let pending = inFlight.get( url.origin );
	if ( ! pending ) {
		pending = preflight( url ).finally( () => inFlight.delete( url.origin ) );
		inFlight.set( url.origin, pending );
	}
	await pending;
	return true;
}
