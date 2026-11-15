import { test as base } from 'vitest';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';

/** Chromium belongs to the worker; cookies, storage and pages belong to a test. */
export const test = base.extend<{
	browser: Browser;
	context: BrowserContext;
	newContext: ( options?: BrowserContextOptions ) => Promise<BrowserContext>;
	newPage: ( options?: BrowserContextOptions ) => Promise<Page>;
}>( {
	browser: [ async ( {}, use ) => {
		const browser = await chromium.launch();
		try { await use( browser ); } finally { await browser.close(); }
	}, { scope: 'worker' } ],
	newContext: async ( { browser }, use ) => {
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
	context: async ( { newContext }, use ) => {
		await use( await newContext() );
	},
	// Preserve Browser.newPage's separate-context semantics, including device options.
	newPage: async ( { browser }, use ) => {
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
export type BrowserFixtures = { browser: Browser; context: BrowserContext; newContext: ( options?: BrowserContextOptions ) => Promise<BrowserContext>; newPage: ( options?: BrowserContextOptions ) => Promise<Page> };
