import { createServer, type Server } from 'node:http';
import { request } from 'playwright';
import { describe, expect, it } from 'vitest';
import { checkInternalRoute } from './internal-route.js';

async function listen( server: Server ): Promise<string> {
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
}

async function close( server: Server ): Promise<void> {
	server.closeAllConnections(); await new Promise<void>( resolve => server.close( () => resolve() ) );
}

describe( 'candidate-local HTTP inspection', () => {
	it( 'follows relative and absolute local Locations, preserves real failures, and bounds unsafe or incomplete chains', async () => {
		let forbiddenRequests = 0;
		const forbidden = createServer( ( _request, response ) => { forbiddenRequests++; response.end( 'Mutated source evidence must never be borrowed' ); } );
		const forbiddenOrigin = await listen( forbidden );
		const seen: string[] = [];
		let origin: string;
		const server = createServer( ( req, response ) => {
			const path = req.url!; seen.push( `${ req.headers.host }${ path }` );
			const redirects: Record<string, [number, string]> = {
				'/canonical': [ 301, '/canonical/' ],
				'/chain': [ 302, 'relative' ],
				'/relative': [ 303, `${ origin }/absolute` ],
				'/absolute': [ 307, '/last' ], '/last': [ 308, '/canonical/' ],
				'/redirect404': [ 301, '/404' ],
				'/source': [ 301, `${ forbiddenOrigin }/source` ],
				'/external': [ 302, `${ forbiddenOrigin.replace( '127.0.0.1', 'localhost' ) }/external` ],
				'/local-first': [ 307, '/source' ],
				'/host-alias': [ 308, `${ origin.replace( '127.0.0.1', 'localhost' ) }/never` ],
				'/protocol': [ 301, `${ origin.replace( 'http:', 'https:' ) }/never` ],
				'/credentials': [ 301, `${ origin.replace( '://', '://user:password@' ) }/never` ],
				'/invalid': [ 302, 'http://[' ], '/scheme': [ 302, 'file:///never' ],
				'/loop': [ 301, '/cycle' ], '/cycle': [ 302, '/loop#fragment' ],
			};
			if ( path.startsWith( '/bound/' ) ) { response.writeHead( 301, { location: `/bound/${ Number( path.split( '/' ).pop() ) + 1 }` } ); response.end(); return; }
			if ( path.startsWith( '/slow/' ) ) {
				const n = Number( path.split( '/' ).pop() );
				setTimeout( () => { response.writeHead( 301, { location: `/slow/${ n + 1 }` } ); response.end(); }, 150 ); return;
			}
			if ( path === '/disconnect' ) { req.socket.destroy(); return; }
			if ( path === '/missing' ) { response.writeHead( 301 ); response.end(); return; }
			if ( redirects[ path ] ) { const [ status, location ] = redirects[ path ]; response.writeHead( status, { location } ); response.end(); return; }
			response.statusCode = [ '/404', '/403', '/500', '/304' ].includes( path ) ? Number( path.slice( 1 ) ) : 200;
			response.end( 'Candidate response' );
		} );
		origin = await listen( server );
		const context = await request.newContext();
		try {
			for ( const [ path, status, redirects, outcome ] of [
				[ '/canonical', 200, 1, 'reachable' ], [ '/chain', 200, 4, 'reachable' ],
				[ '/404', 404, 0, 'http-error' ], [ '/redirect404', 404, 1, 'http-error' ],
				[ '/403', 403, 0, 'http-error' ], [ '/500', 500, 0, 'http-error' ], [ '/304', 304, 0, 'http-error' ],
				[ '/source', 301, 0, 'blocked-redirect' ], [ '/external', 302, 0, 'blocked-redirect' ], [ '/local-first', 301, 1, 'blocked-redirect' ],
				[ '/host-alias', 308, 0, 'blocked-redirect' ], [ '/protocol', 301, 0, 'blocked-redirect' ], [ '/credentials', 301, 0, 'blocked-redirect' ],
				[ '/invalid', 302, 0, 'invalid-location' ], [ '/scheme', 302, 0, 'blocked-redirect' ],
				[ '/missing', 301, 0, 'missing-location' ], [ '/loop', 302, 1, 'redirect-loop' ], [ '/disconnect', null, 0, 'request-error' ],
			] as const ) {
				expect( await checkInternalRoute( context, origin, path ), path ).toEqual( { path, status, redirects, outcome } );
			}
			expect( await checkInternalRoute( context, origin, `${ forbiddenOrigin }/initial` ) ).toMatchObject( { status: null, outcome: 'blocked-redirect' } );
			expect( await checkInternalRoute( context, origin, '/bound/0', { maxRedirects: 2 } ) ).toEqual( { path: '/bound/0', status: 301, redirects: 2, outcome: 'redirect-limit' } );
			expect( seen.filter( path => path.includes( '/bound/' ) ) ).toHaveLength( 3 );
			const started = performance.now();
			expect( await checkInternalRoute( context, origin, '/slow/0', { timeoutMs: 400 } ) ).toEqual( { path: '/slow/0', status: 301, redirects: 2, outcome: 'timeout' } );
			expect( performance.now() - started ).toBeLessThan( 1_000 );
			expect( seen.filter( path => path.includes( '/slow/' ) ) ).toHaveLength( 3 );
			expect( forbiddenRequests ).toBe( 0 );
			expect( seen.some( path => path.includes( '/never' ) || path.startsWith( 'localhost:' ) ) ).toBe( false );
		} finally { await context.dispose(); await close( server ); await close( forbidden ); }
	} );
} );
