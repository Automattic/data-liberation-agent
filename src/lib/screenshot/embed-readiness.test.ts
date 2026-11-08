import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import { captureScreenshots } from './screenshotter.js';
import { waitForHiddenEmbeds } from './embed-readiness.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// A zero-size hidden frame (reCAPTCHA's `aframe`) has nothing to reveal into.
it.each( [
	[ 'no frames', [] ],
	[ 'a zero-size hidden frame', [ { width: '0px', height: '0px' } ] ],
] )( 'does not start a timer or observer with %s', async ( _label, styles ) => {
	const querySelectorAll = vi.fn().mockReturnValue( styles );
	const timer = vi.spyOn( globalThis, 'setTimeout' );
	const observer = vi.fn();
	vi.stubGlobal( 'document', { querySelectorAll } );
	vi.stubGlobal( 'getComputedStyle', ( frame: { width: string; height: string } ) => ( { display: 'none', visibility: 'visible', ...frame } ) );
	vi.stubGlobal( 'MutationObserver', observer );
	try {
		await waitForHiddenEmbeds();
		expect( querySelectorAll ).toHaveBeenCalledWith( 'iframe' );
		expect( timer ).not.toHaveBeenCalled();
		expect( observer ).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
		timer.mockRestore();
	}
} );

it.each( [ 'reveal', 'remove', 'timeout' ] )( 'cleans up the bounded wait on %s', async outcome => {
	vi.useFakeTimers();
	const frame = { isConnected: true };
	let display = 'none';
	let notify!: () => void;
	const disconnect = vi.fn();
	vi.stubGlobal( 'document', { querySelectorAll: () => [ frame ], documentElement: {} } );
	vi.stubGlobal( 'getComputedStyle', () => ( { display, visibility: 'visible', width: '352px', height: '150px' } ) );
	vi.stubGlobal( 'MutationObserver', class {
		constructor( callback: () => void ) { notify = callback; }
		observe() {}
		disconnect = disconnect;
	} );
	try {
		const waiting = waitForHiddenEmbeds( 500 );
		expect( vi.getTimerCount() ).toBe( 1 );
		if ( outcome === 'timeout' ) await vi.advanceTimersByTimeAsync( 500 );
		else {
			if ( outcome === 'reveal' ) display = 'block';
			else frame.isConnected = false;
			notify();
		}
		await waiting;
		expect( disconnect ).toHaveBeenCalledOnce();
		expect( vi.getTimerCount() ).toBe( 0 );
	} finally {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
} );

// One dual-device browser capture (~15s), using the delayed-load reveal fixture.
it.skipIf( skipBrowser )( 'captures the revealed iframe in both server-selected device documents', async () => {
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		const phone = /iPhone|Android/.test( request.headers[ 'user-agent' ] ?? '' );
		response.end( `<!doctype html><html><head><meta charset="utf-8"><title>Reveal</title>
		<style>.embed-hidden{display:none!important}</style></head>
		<body class="${ phone ? 'phone' : 'desktop' }"><main><h1>Donation form</h1><div class="embed-form" id="slot"></div><p>After the form.</p></main>
		<script>
		const f=document.createElement('iframe');f.className='embed-hidden';f.src='https://embed.test/frame.html';f.width=352;f.height=150;
		document.getElementById('slot').appendChild(f);
		f.addEventListener('load',()=>setTimeout(()=>{f.className='';f.height=1208;},2500));
		</script></body></html>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/embed-readiness-' ) );
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0,
			deviceMode: 'auto', learnFluid: false,
			// Mobile serialization retains browser-attested HTTPS iframe surfaces.
			initScript: async page => { await page.route( 'https://embed.test/frame.html', route => route.fulfill( {
				contentType: 'text/html', body: '<!doctype html><p>Form content</p>',
			} ) ); },
		} );
		expect( result.failed ).toBe( 0 );
		expect( result.deviceMode?.mode ).toBe( 'dual' );
		expect( result.deviceMode?.serverHtml ).toBe( 'different' );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		for ( const [ path, identity ] of [ [ entry.html, 'desktop' ], [ entry.mobileHtml, 'phone' ] ] ) {
			expect( path ).toBeTruthy();
			const $ = load( readFileSync( join( outputDir, path ), 'utf8' ) );
			expect( $( 'body' ).hasClass( identity ) ).toBe( true );
			expect( $( '#slot iframe' ) ).toHaveLength( 1 );
			expect( $( '#slot iframe' ).hasClass( 'embed-hidden' ) ).toBe( false );
			expect( Number( $( '#slot iframe' ).attr( 'height' ) ) ).toBeGreaterThanOrEqual( 1208 );
			expect( Number( $( '#slot iframe' ).attr( 'width' ) ) ).toBeGreaterThanOrEqual( 352 );
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
