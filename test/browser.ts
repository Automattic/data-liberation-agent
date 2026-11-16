import { test as base } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';

type Serve = ( handler: RequestListener ) => Promise<{ origin: string; server: Server }>;

/** Chromium belongs to the worker; cookies, storage and pages belong to a test. */
export const test = base.extend<{
	browser: Browser;
	serve: Serve;
	context: BrowserContext;
	newContext: ( options?: BrowserContextOptions ) => Promise<BrowserContext>;
	newPage: ( options?: BrowserContextOptions ) => Promise<Page>;
}>( {
	browser: [ async ( {}, use ) => {
		const browser = await chromium.launch();
		try { await use( browser ); } finally { await browser.close(); }
	}, { scope: 'worker' } ],
	serve: async ( {}, use ) => {
		const servers: Server[] = [];
		try {
			await use( async handler => {
				const server = createServer( handler );
				servers.push( server );
				await new Promise<void>( ( resolve, reject ) => {
					server.once( 'error', reject );
					server.listen( 0, '127.0.0.1', () => {
						server.off( 'error', reject );
						resolve();
					} );
				} );
				const { port } = server.address() as { port: number };
				return { origin: `http://127.0.0.1:${ port }`, server };
			} );
		} finally {
			await Promise.all( servers.map( async server => {
				server.closeAllConnections();
				if ( ! server.listening ) return;
				await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
			} ) );
		}
	},
	// The dependency is intentional: contexts must close before their HTTP servers.
	newContext: async ( { browser, serve: _serve }, use ) => {
		const contexts: BrowserContext[] = [];
		try {
			await use( async options => {
				const context = await browser.newContext( options );
				contexts.push( context );
				return context;
			} );
		} finally {
			await Promise.all( contexts.map( context => context.close() ) );
		}
	},
	context: async ( { newContext, serve: _serve }, use ) => {
		await use( await newContext() );
	},
	// Preserve Browser.newPage's separate-context semantics, including device options.
	newPage: async ( { browser, serve: _serve }, use ) => {
		const contexts: BrowserContext[] = [];
		try {
			await use( async options => {
				const page = await browser.newPage( options );
				contexts.push( page.context() );
				return page;
			} );
		} finally {
			await Promise.all( contexts.map( context => context.close() ) );
		}
	},
} );

export const it = test;
export type BrowserFixtures = { serve: Serve; browser: Browser; context: BrowserContext; newContext: ( options?: BrowserContextOptions ) => Promise<BrowserContext>; newPage: ( options?: BrowserContextOptions ) => Promise<Page> };
