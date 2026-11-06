import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { chromium, devices } from 'playwright';
import { checkRouteDeviceMode } from './screenshotter.js';
import { retryRouteDeviceCheck, RouteDeviceEvidence } from './device-mode.js';

it( 'inherits only rendered script proofs, preserves identity differences, and retries failed requests', async () => {
	let failed = false;
	let scriptLoads = 0;
	const server = createServer( ( req, res ) => {
		if ( req.url === '/retry' && ! failed ) { failed = true; req.socket.destroy(); return; }
		if ( req.url?.endsWith( '.js' ) ) {
			scriptLoads++;
			res.setHeader( 'content-type', 'application/javascript' );
			res.end( req.url === '/new.js' ? "if(/iPhone/.test(navigator.userAgent))document.body.classList.add('phone')" : '' );
			return;
		}
		res.setHeader( 'content-type', 'text/html' );
		if ( req.url === '/fit' ) {
			res.end( `<!doctype html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script>addEventListener('DOMContentLoaded',()=>{const fit=()=>{let s=document.getElementById('t-style');if(!s){s=document.createElement('style');s.id='t-style';document.head.append(s)}s.textContent='#t{font-size:'+ (innerWidth<768?32:56) +'px!important}'};fit();addEventListener('resize',fit)})</script></head><body><h1 id="t">Strategy and Communication</h1><p>Body text.</p></body>` );
			return;
		}
		res.end( `<body><script nonce="${ req.headers[ 'user-agent' ] === 'Desktop' ? 'a' : 'b' }"></script><p>${ req.url === '/server' && /iPhone/.test( req.headers[ 'user-agent' ] ?? '' ) ? 'phone' : 'same' }</p><script src="${ req.url === '/client' ? '/new.js' : '/known.js' }"></script></body>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const port = ( server.address() as { port: number } ).port;
	const browser = await chromium.launch();
	try {
		const base = `http://127.0.0.1:${ port }`;
		const args = {
			browser, desktop: { userAgent: 'Desktop' }, phone: devices[ 'iPhone 13' ]!, publicUrlsOnly: false,
			deviceEvidence: new RouteDeviceEvidence(),
			identityHeaders: { desktop: { 'user-agent': 'Desktop' }, mobile: { 'user-agent': devices[ 'iPhone 13' ]!.userAgent } },
		};
		const fit = await checkRouteDeviceMode( { ...args, url: `${ base }/fit` } );
		expect( fit ).toMatchObject( { mode: 'dual', reason: 'the phone profile has different runtime-injected style rules' } );
		const first = await checkRouteDeviceMode( { ...args, url: `${ base }/first` } );
		expect( first.mode ).toBe( 'reflow-only' );
		expect( first.inheritedFrom ).toBeUndefined();
		const loaded = scriptLoads;
		const known = await checkRouteDeviceMode( { ...args, url: `${ base }/known` } );
		expect( known.inheritedFrom ).toBe( `${ base }/first` );
		expect( known.serverHtml ).toBe( 'identical-after-normalization' );
		expect( scriptLoads ).toBe( loaded );
		expect( ( await checkRouteDeviceMode( { ...args, url: `${ base }/client` } ) ).mode ).toBe( 'dual' );
		expect( ( await checkRouteDeviceMode( { ...args, url: `${ base }/server` } ) ).mode ).toBe( 'dual' );
		const retry = await checkRouteDeviceMode( { ...args, url: `${ base }/retry` } );
		expect( retry.mode ).toBe( 'reflow-only' );
		expect( retry.attempts ).toBe( 2 );
	} finally {
		await browser.close();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
	}
}, 60_000 );

it( 'retries a degraded rendered result before keeping dual', async () => {
	let attempts = 0;
	const result = await retryRouteDeviceCheck( async () => ++attempts === 1
		? { mode: 'dual', reason: 'degraded DOM', serverHtml: 'identical' }
		: { mode: 'reflow-only', reason: 'same settled DOM', serverHtml: 'identical' } );
	expect( result ).toMatchObject( { mode: 'reflow-only', attempts: 2 } );
} );
