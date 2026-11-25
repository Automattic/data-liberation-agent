import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { fetchTemplateDocument } from './template-cluster-fetch.js';

describe( 'template document attempt budgets', () => {
	async function fixture( run: ( url: string, requests: () => number ) => Promise< void >, alwaysTimeout = false ) {
		let requests = 0;
		const server = createServer( ( _req, res ) => {
			requests++;
			if ( requests === 1 || alwaysTimeout ) return;
			res.end( '<html><body>Recovered document</body></html>' );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as import('node:net').AddressInfo ).port }/`;
		try {
			await runWithTrustedOrigins( [ url ], () => run( url, () => requests ) );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( resolve => server.close( () => resolve() ) );
		}
	}

	it( 'retries a timed-out document with a fresh attempt timeout', async () => {
		await fixture( async ( url, requests ) => {
			const response = await fetchTemplateDocument( url, { governors: new SourceRequestGovernors(), timeoutMs: 100, deadline: Date.now() + 2000 } );
			expect( response.status ).toBe( 200 );
			expect( response.body.toString() ).toContain( 'Recovered document' );
			expect( requests() ).toBe( 2 );
		} );
	} );

	it( 'bounds repeated timeouts to three attempts', async () => {
		await fixture( async ( url, requests ) => {
			await expect( fetchTemplateDocument( url, { governors: new SourceRequestGovernors(), timeoutMs: 100, deadline: Date.now() + 2000 } ) ).rejects.toMatchObject( { name: 'TimeoutError' } );
			expect( requests() ).toBe( 3 );
		}, true );
	} );

	it( 'bounds throttle waits by the capture deadline', async () => {
		let requests = 0;
		const server = createServer( ( _req, res ) => {
			requests++;
			res.writeHead( 429, { 'Retry-After': '10' } );
			res.end();
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as import('node:net').AddressInfo ).port }/`;
		try {
			await runWithTrustedOrigins( [ url ], async () => {
				await expect( fetchTemplateDocument( url, { governors: new SourceRequestGovernors(), timeoutMs: 1000, deadline: Date.now() + 200 } ) ).rejects.toMatchObject( { name: 'TimeoutError' } );
				expect( requests ).toBe( 1 );
			} );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( resolve => server.close( () => resolve() ) );
		}
	} );

	it( 'stops retrying at the capture deadline', async () => {
		await fixture( async ( url, requests ) => {
			await expect( fetchTemplateDocument( url, { governors: new SourceRequestGovernors(), timeoutMs: 1000, deadline: Date.now() + 100 } ) ).rejects.toMatchObject( { name: 'TimeoutError' } );
			expect( requests() ).toBe( 1 );
		}, true );
	} );
} );
