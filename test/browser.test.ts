import { expect } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import type { Server } from 'node:http';
import { test } from './browser.js';

let workerBrowser: Browser;
let previousContext: BrowserContext;
let previousServer: Server;
const teardown: string[] = [];

test( 'owns an isolated context without closing the worker browser', async ( { browser, context } ) => {
	workerBrowser = browser;
	previousContext = context;
	await context.addCookies( [ { name: 'fixture', value: 'private', url: 'https://example.com/' } ] );
	const page = await context.newPage();
	await page.setContent( '<p>first test</p>' );
	expect( await page.textContent( 'p' ) ).toBe( 'first test' );
} );

test( 'reuses Chromium but not cookies, pages or contexts', async ( { browser, context } ) => {
	expect( browser ).toBe( workerBrowser );
	expect( browser.isConnected() ).toBe( true );
	expect( context ).not.toBe( previousContext );
	expect( previousContext.pages() ).toEqual( [] );
	expect( browser.contexts() ).not.toContain( previousContext );
	expect( context.pages() ).toEqual( [] );
	expect( await context.cookies() ).toEqual( [] );
} );

test( 'preserves context options and separate contexts for convenience pages', async ( { newPage, newContext } ) => {
	const first = await newPage( { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } );
	const second = await newPage();
	expect( first.viewportSize() ).toEqual( { width: 390, height: 844 } );
	expect( first.context() ).not.toBe( second.context() );
	expect( await first.evaluate( () => navigator.maxTouchPoints ) ).toBeGreaterThan( 0 );
	const context = await newContext( { locale: 'fr-FR' } );
	const page = await context.newPage();
	expect( await page.evaluate( () => navigator.language ) ).toBe( 'fr-FR' );
} );

// No readiness sleeps: events record fixture teardown after this test returns.
test( 'keeps servers alive until every convenience context has closed', async ( { serve, context, newContext, newPage } ) => {
 teardown.length = 0;
 const { origin, server } = await serve( ( _request, response ) => response.end( 'fixture' ) );
 previousServer = server;
 for ( const owned of [ context, await newContext(), ( await newPage() ).context() ] ) {
  owned.on( 'close', () => { teardown.push( server.listening ? 'context' : 'server closed too early' ); } );
  const page = owned.pages()[ 0 ] ?? await owned.newPage();
  await page.goto( origin );
  expect( await page.textContent( 'body' ) ).toBe( 'fixture' );
 }
 const closeAllConnections = server.closeAllConnections.bind( server );
 server.closeAllConnections = () => { teardown.push( 'connections' ); closeAllConnections(); };
 server.on( 'close', () => teardown.push( 'server' ) );
} );

test( 'closes contexts, then connections, then the HTTP server', () => {
 expect( previousServer.listening ).toBe( false );
 expect( teardown ).toEqual( [ 'context', 'context', 'context', 'connections', 'server' ] );
} );
