import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || !existsSync( chromium.executablePath() );
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0}.drawer{display:none;padding:24px}.nav-open .drawer{display:block}
.icon::before{content:'☰'}.icon--open::before{content:'×'}button{width:48px;height:48px}</style></head>
<body class="page"><header><button id="toggle" class="toggle" aria-label="Menu" aria-expanded="false" aria-controls="drawer"><span><span class="icon"></span></span><span class="unchanged"></span></button>
<nav id="drawer" class="drawer"><a href="#content">Content</a></nav></header><main id="content"><h1>Neutral menu</h1></main>
<script>const toggle=document.getElementById('toggle');function set(open){document.body.classList.toggle('nav-open',open);toggle.classList.toggle('toggle--open',open);toggle.querySelector('.icon').classList.toggle('icon--open',open);toggle.setAttribute('aria-expanded',String(open));}
toggle.onclick=()=>set(toggle.getAttribute('aria-expanded')!=='true');addEventListener('keydown',event=>{if(event.key==='Escape')set(false);});</script></body></html>`;

// One full capture (~12 seconds), then exercise only the exported site, with
// the source script gone. Both the control itself and its nested icon change.
it.skipIf( skipBrowser )( 'replays trigger class deltas when a captured menu opens and closes', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'trigger-classes-' ) );
	let copyRoot: string | undefined;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html; charset=utf-8' );
		response.end( request.url === '/copy/' && copyRoot ? readResolvedPage( copyRoot, join( copyRoot, 'index.html' ) ) : fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch( { args: [ '--host-resolver-rules=MAP localtest.me 127.0.0.1' ] } );
	try {
		const result = await captureWebsite( { url, outputDir: root }, {
			findAdapter: () => ( { id: 'neutral-menu', detect: () => true, discover: async () => ( { urls: [ { url } ] } ) } ),
		} );
		expect( result.summary.routesFailed ).toBe( 0 );
		copyRoot = join( root, 'website' );
		const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
		await page.goto( `${ url }copy/` );
		const trigger = page.locator( '#toggle:visible' ), icon = trigger.locator( '.icon' );
		const evidence = JSON.parse( ( await trigger.getAttribute( 'data-blocks-engine-capture-dialog-trigger-state' ) )! );
		expect( evidence ).toEqual( [
			{ selector: '', tag: 'button', closed: { class: '' }, opened: { class: 'toggle--open' }, classTokensOnly: true },
			{ selector: ':scope > :nth-child(1) > :nth-child(1)', tag: 'span', closed: { class: '' }, opened: { class: 'icon--open' }, classTokensOnly: true },
		] );
		await icon.evaluate( node => node.classList.add( 'unrelated' ) );
		expect( await icon.evaluate( node => node.classList.contains( 'icon--open' ) ) ).toBe( false );
		for ( const close of [ 'toggle', 'escape' ] ) {
			await trigger.click();
			expect( await icon.evaluate( node => node.classList.contains( 'icon--open' ) ) ).toBe( true );
			expect( await icon.evaluate( node => getComputedStyle( node, '::before' ).content ) ).toBe( '"×"' );
			expect( await trigger.evaluate( node => node.classList.contains( 'toggle--open' ) ) ).toBe( true );
			if ( close === 'escape' ) await page.keyboard.press( 'Escape' ); else await trigger.click();
			expect( await icon.evaluate( node => node.classList.contains( 'icon--open' ) ) ).toBe( false );
			expect( await trigger.evaluate( node => node.classList.contains( 'toggle--open' ) ) ).toBe( false );
			expect( await icon.evaluate( node => node.classList.contains( 'unrelated' ) ) ).toBe( true );
			expect( await trigger.locator( '.unchanged' ).getAttribute( 'class' ) ).toBe( 'unchanged' );
		}
	} finally {
		await browser.close();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 120_000 );
