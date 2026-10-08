import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { observePage, observedMotionDetached } from './check.js';
import { createReferenceCollector } from './reference.js';
import { triggerLazyLoad, waitForAnimations } from '../screenshot/page-helpers.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'settled motion evidence', () => {
	it( 'settles chained in-flight effects without spending the budget on paused entrances', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent( `<style>@keyframes fade{from{opacity:0}to{opacity:1}}
				#paused{animation:fade 1s both paused}#first{animation:fade 300ms both}#second.go{animation:fade 300ms both}</style>
				<div id="paused">Waiting for viewport</div><div id="first">First</div><div id="second">Second</div>
				<script>document.getElementById('first').addEventListener('animationend',()=>document.getElementById('second').classList.add('go'))</script>` );
			const started = Date.now();
			await waitForAnimations( page, 4_000 );
			const elapsed = Date.now() - started;
			expect( await page.locator( '#second' ).evaluate( element => element.getAnimations().map( animation => animation.playState ) ) ).toEqual( [ 'finished' ] );
			expect( await page.locator( '#paused' ).evaluate( element => element.getAnimations()[ 0 ]!.playState ) ).toBe( 'paused' );
			expect( elapsed ).toBeLessThan( 2_500 );
		} finally { await browser.close(); }
	}, 20_000 );

	it( 'brings every region into a layout viewport shorter than the sweep step', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 400, height: 200 } } );
			await page.setContent( `<style>body{margin:0}.item{height:40px;margin-bottom:60px}</style>
				${ Array.from( { length: 30 }, ( _, index ) => `<div class="item" data-index="${ index }"></div>` ).join( '' ) }
				<script>const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting&&entry.intersectionRatio>=.5)entry.target.dataset.seen='1';},{threshold:.5});
				document.querySelectorAll('.item').forEach(item=>observer.observe(item));</script>` );
			await triggerLazyLoad( page );
			expect( await page.locator( '.item:not([data-seen])' ).count() ).toBe( 0 );
		} finally { await browser.close(); }
	}, 60_000 );

	it( 'counts started effects, not clock progress of effects already in flight, as scroll responses', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 800, height: 400 } } );
			const html = `<style>body{margin:0;height:3000px}@keyframes clock{to{opacity:.5}}@keyframes reveal{from{opacity:0}to{opacity:1}}
				#entrance{position:absolute;top:500px;height:100px;animation:reveal 2s both paused}</style><div id="clock">Clock</div><div id="entrance">Entrance</div>`;
			const observation = await observePage( page, `data:text/html,${ encodeURIComponent( html ) }`, 800, 0, null, undefined, async () => {
				await page.evaluate( () => {
					const entrance = document.getElementById( 'entrance' )!;
					entrance.getAnimations()[ 0 ]!.currentTime = 0;
					document.getElementById( 'clock' )!.style.animation = 'clock 20s both';
					addEventListener( 'scroll', () => { if ( scrollY > 0 ) entrance.getAnimations()[ 0 ]!.play(); } );
				} );
			} );
			expect( observation.animations ).toEqual( [ 'clock', 'reveal' ] );
			expect( observation.responsiveAnimations ).toEqual( [ 'reveal' ] );
		} finally { await browser.close(); }
	}, 60_000 );

	it( 'reports observed motion targets that leave the document after observation', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const html = '<style>@keyframes intro{from{opacity:0}to{opacity:1}}#splash{animation:intro 10ms both}</style><div id="splash">Loading</div><p>Content</p>';
			await observePage( page, `data:text/html,${ encodeURIComponent( html ) }`, 800, 0, null, undefined, undefined, false, true );
			expect( await observedMotionDetached( page ) ).toBe( false );
			await page.evaluate( () => document.getElementById( 'splash' )!.remove() );
			expect( await observedMotionDetached( page ) ).toBe( true );
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'freezes a source observation coherent with the document after startup chrome is dismantled', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'settled-startup-' ) );
		// Once the visitor scrolls (here: the observation's own controlled scroll)
		// the source plays its splash outro and removes the splash afterwards,
		// after the first observation has already been frozen.
		const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Startup</title>
			<style>body{margin:0;height:2400px}@keyframes intro{from{opacity:0}to{opacity:1}}#splash{position:fixed;inset:0 0 auto 0;height:40px;animation:intro 10ms both}#splash.outro{animation:intro 10ms both,outro 1200ms both}@keyframes outro{to{opacity:0}}</style>
			<div id="splash">Loading</div><h1>Settled content</h1>`;
		const source = createServer( ( _request, response ) => { response.setHeader( 'content-type', 'text/html' ); response.end( html ); } );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		const browser = await chromium.launch();
		try {
			// Capture's own context: the collector observes from a fresh sibling page.
			const page = await ( await browser.newContext() ).newPage();
			const collector = createReferenceCollector( directory, url, [ url ], {
				prepareCapture: async target => {
					await target.evaluate( () => addEventListener( 'scroll', () => {
						const splash = document.getElementById( 'splash' );
						if ( scrollY === 0 || ! splash || splash.classList.contains( 'outro' ) ) return;
						splash.classList.add( 'outro' );
						splash.addEventListener( 'animationend', () => setTimeout( () => splash.remove(), 300 ) );
					} ) );
				},
			} );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false }, { id: 'desktop', width: 1440, height: 900, referenceWidths: [ 1440 ] } );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, websiteRoot: 'website', routes: [] } ) );
			const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) );
			const entry = manifest.entries[ 0 ];
			expect( entry.readiness.reasons ).toEqual( [] );
			const observation = JSON.parse( readFileSync( join( directory, entry.observation.path ), 'utf8' ) );
			expect( readFileSync( join( directory, entry.document.path ), 'utf8' ) ).not.toContain( 'id="splash"' );
			expect( observation.animations ).toEqual( [] );
		} finally {
			await browser.close(); source.closeAllConnections(); source.close(); rmSync( directory, { recursive: true, force: true } );
		}
	}, 90_000 );
} );
