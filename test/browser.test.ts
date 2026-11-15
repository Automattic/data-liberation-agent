import { expect } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { test } from './browser.js';

let workerBrowser: Browser;
let previousContext: BrowserContext;

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
