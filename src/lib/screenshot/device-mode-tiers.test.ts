import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { chromium, devices } from 'playwright';
import { checkRouteDeviceMode } from './screenshotter.js';
import { retryRouteDeviceCheck, RouteDeviceEvidence } from './device-mode.js';
import { documentsDiffer } from '../responsive-assembly.js';

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

// #1366: a consent manager that orders its buttons by viewport width is not a second document.
const consentFixture = ( content: string ) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consent device check</title>
<style>body{margin:0}#consent{position:fixed;inset:auto 0 0 0;background:#fff;padding:1rem}#consent .actions{display:flex}</style></head>
<body><div id="consent" role="dialog" aria-label="Cookie consent"><p>This website uses cookies.</p><div class="actions"></div></div>
<main><h1>Welcome</h1><p>A short paragraph of page content.</p></main>
<script>
const labels = innerWidth < 600 ? ['Accept all', 'Decline'] : ['Decline', 'Accept all'];
const actions = document.querySelector('#consent .actions');
for (const label of labels) {
  const button = document.createElement('button');
  button.id = 'consent-' + label.replace(' ', '-').toLowerCase(); button.textContent = label;
  if (label === 'Decline') button.append(document.createElement('div'));
  actions.append(button);
}
${ content }
</script></body></html>`;

it.each( [
	{ name: 'consent dialog reordered by width', route: '/consent', mode: 'reflow-only', differ: false },
	{ name: 'main content differs by width', route: '/content', mode: 'dual', differ: true },
] )( 'compares structure without consent overlays: $name', async ( { route, mode, differ } ) => {
	const server = createServer( ( req, res ) => {
		res.setHeader( 'content-type', 'text/html' );
		res.end( consentFixture( req.url === '/content' ? "if (innerWidth < 600) document.querySelector('main').append(document.createElement('aside'), document.createElement('nav'));" : '' ) );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }${ route }`;
	const browser = await chromium.launch();
	try {
		const phone = devices[ 'iPhone 13' ]!;
		const decision = await checkRouteDeviceMode( { browser, url, desktop: { userAgent: 'Desktop' }, phone, publicUrlsOnly: false, deviceEvidence: new RouteDeviceEvidence() } );
		expect( decision.mode, decision.reason ).toBe( mode );
		const render = async ( options: typeof phone | { userAgent: string } ) => {
			const context = await browser.newContext( options );
			const page = await context.newPage();
			await page.goto( url );
			const html = await page.content();
			await context.close();
			return html;
		};
		expect( documentsDiffer( await render( { userAgent: 'Desktop' } ), await render( phone ) ) ).toBe( differ );
	} finally {
		await browser.close();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
	}
}, 60_000 );
