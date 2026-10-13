import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { restoreTopScrollState } from './page-helpers.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || !existsSync( chromium.executablePath() );
const fixture = ( openedClass = 'opened', restoredClass = 'closed' ) => `<!doctype html><style>
body{margin:0}header{width:390px}.closed{background:transparent}.opened{background:rgba(2,6,23,.85)}
nav{height:64px}.panel{height:80px}
</style><header id="header" class="closed"><nav><button id="a">Menu A</button><button id="b">Menu B</button></nav><span id="tail"></span></header><main>Body</main><script>
for(const id of ['a','b'])document.getElementById(id).addEventListener('click',()=>{
const header=document.getElementById('header'),existing=document.getElementById('panel-'+id);
if(existing){existing.remove();header.className=header.querySelector('.panel')?${ JSON.stringify( openedClass ) }:${ JSON.stringify( restoredClass ) };return;}
const panel=document.createElement('div');panel.id='panel-'+id;panel.className='panel';panel.innerHTML='<a href="#'+id+'">'+id+'</a>';
header.insertBefore(panel,document.getElementById('tail'));header.className=${ JSON.stringify( openedClass ) };
});</script>`;

it.skipIf( skipBrowser )( 'observes menu paint from the portable baseline rather than a preceding scrolled screenshot', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	try {
		await page.setContent( `<!doctype html><style>body{margin:0;height:2000px}header{position:fixed;top:0;width:390px}.clear{background:transparent}.opaque{background:rgba(2,6,23,.85)}.panel{height:200px}</style>
		<header id="header" class="clear"><nav style="height:64px"><button id="menu">Menu</button></nav></header><main>Body</main><script>
		let open=false;const header=document.getElementById('header');const paint=()=>header.className=open||scrollY>20?'opaque':'clear';addEventListener('scroll',paint);
		document.getElementById('menu').onclick=()=>{open=!open;paint();if(!open){document.getElementById('panel').remove();return;}
		const panel=document.createElement('div');panel.id='panel';panel.className='panel';panel.innerHTML='<a href="#one">One</a>';header.append(panel);};</script>` );
		await page.evaluate( () => { scrollTo( 0, 500 ); dispatchEvent( new Event( 'scroll' ) ); } );
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'opaque' );
		await restoreTopScrollState( page );
		expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		expect( report.states[ 0 ]?.dialog?.ancestorState ).toMatchObject( { status: 'verified', ancestors: [ { selector: '#header', closed: { class: 'clear' }, opened: { class: 'opaque' } } ] } );
		await page.setContent( wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), report.states ) );
		await page.locator( '#menu' ).click();
		expect( await page.locator( '#header' ).evaluate( node => ( { height: node.getBoundingClientRect().height, paint: getComputedStyle( node ).backgroundColor } ) ) ).toEqual( { height: 264, paint: 'rgba(2, 6, 23, 0.85)' } );
	} finally { await browser.close(); }
}, 30_000 );

it.skipIf( skipBrowser )( 'keeps a shared ancestor open until its last source control closes', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	try {
		await page.setContent( fixture() );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		expect( report.states.filter( state => state.dialog?.ancestorState?.status === 'verified' ) ).toHaveLength( 2 );
		const baseline = ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' );
		await page.setContent( wireCapturedDialogs( baseline, report.states ) );
		await page.locator( '#a' ).click();
		await page.locator( '#b' ).click();
		await page.locator( '#a' ).click();
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'opened' );
		expect( await page.locator( '#b' ).getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		await page.locator( '#b' ).click();
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'closed' );
		expect( await page.locator( '#header' ).evaluate( node => node.getBoundingClientRect().height ) ).toBe( 64 );
	} finally { await browser.close(); }
}, 30_000 );

// Prototype.js replaces Array.from with a copy that only reads `length`, so a
// Set becomes []. The ancestor diff runs inside the page and must still see
// the changed attributes.
it.skipIf( skipBrowser )( 'records ancestor changes when the page library replaced Array.from', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	try {
		await page.setContent( `<script>Array.from = function ( iterable ) {
			if ( ! iterable ) return [];
			if ( 'toArray' in Object( iterable ) ) return iterable.toArray();
			var length = iterable.length || 0, results = new Array( length );
			while ( length-- ) results[ length ] = iterable[ length ];
			return results;
		};</script>${ fixture() }` );
		expect( await page.evaluate( () => Array.from( new Set( [ 1, 2 ] ) ).length ) ).toBe( 0 );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const state = report.states.find( item => item.trigger.id === 'a' );
		expect( state?.dialog?.ancestorState ).toMatchObject( { status: 'verified', ancestors: [ { selector: '#header', closed: { class: 'closed' }, opened: { class: 'opened' } } ] } );
	} finally { await browser.close(); }
}, 30_000 );

it.skipIf( skipBrowser )( 'does not overwrite an ancestor edited after its captured proof', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage();
	try {
		await page.setContent( fixture() );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const baseline = ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ).replace( 'id="header" class="closed"', 'id="header" class="owner-edited"' );
		const portable = wireCapturedDialogs( baseline, report.states );
		expect( portable ).toContain( 'data-blocks-engine-capture-dialog-ancestor-unverified="portable-owner-mismatch"' );
		await page.setContent( portable );
		await page.locator( '#a' ).click();
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'owner-edited' );
	} finally { await browser.close(); }
}, 30_000 );

it.skipIf( skipBrowser )( 'reports bounded and non-restored ancestor evidence without replaying it as verified', async () => {
	const browser = await chromium.launch( { headless: true } );
	try {
		for ( const [ source, reason ] of [
			[ fixture( 'x'.repeat( 5000 ) ), 'ancestor-attribute-limit' ],
			[ fixture( 'opened', 'opened' ), 'ancestor-restoration-unverified' ],
		] ) {
			const page = await browser.newPage();
			await page.setContent( source );
			const report = await captureTriggeredDialogs( page, 'https://example.test/' );
			const state = report.states.find( item => item.trigger.id === 'a' );
			expect( state?.dialog?.ancestorState ).toMatchObject( { status: 'unverified', reason } );
			expect( JSON.stringify( state?.dialog?.ancestorState ).length ).toBeLessThan( 32768 );
			const portable = wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), [ state! ] );
			expect( portable ).not.toContain( 'data-blocks-engine-capture-dialog-ancestor-state=' );
			await page.close();
		}
	} finally { await browser.close(); }
}, 30_000 );

// Squarespace-style overlay: the burger only toggles a body class, and the
// full-screen menu is shown by `.menu-open .overlay`. It is a modal, so it
// keeps its own mount, but the class must still be recorded and replayed.
// Escape closes it with a fade, so the probe must not toggle it open again.
it.skipIf( skipBrowser )( 'records and replays the ancestor class that shows a modal menu', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	try {
		await page.setContent( `<!doctype html><style>
		body{margin:0}.overlay{position:fixed;inset:0;opacity:0;visibility:hidden;background:#fff;transition:opacity .4s,visibility .6s}
		.menu-open .overlay{opacity:1;visibility:visible}
		</style><body class="page"><header id="header" class="dark header"><button id="burger">Open Menu</button><div class="overlay"><a href="/about">About</a></div></header><main>Body</main>
		<script>const header=document.getElementById('header');
		const set=open=>{document.body.classList.toggle('menu-open',open);header.classList.remove(open?'dark':'light');header.classList.add(open?'light':'dark');};
		document.getElementById('burger').addEventListener('click',()=>set(!document.body.classList.contains('menu-open')));
		addEventListener('keydown',event=>{if(event.key==='Escape')set(false);});</script>` );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const state = report.states.find( item => item.trigger.id === 'burger' );
		expect( state?.dialog ).toMatchObject( {
			presentation: 'modal',
			ancestorState: { status: 'verified', ancestors: [
				{ selector: '#header', tag: 'header', depth: 1, closed: { class: 'dark header' }, opened: { class: 'header light' } },
				{ selector: 'body', tag: 'body', depth: 2, closed: { class: 'page' }, opened: { class: 'page menu-open' } },
			] },
		} );
		// Closing re-added the header's theme class in a new order; as tokens it is restored.
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'header dark' );
		expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( 'page' );
		const portable = wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), report.states );
		await page.setContent( portable );
		expect( await page.locator( '#burger + [data-dla-dialog-panel]:not([data-dla-observed-placement])' ).count() ).toBe( 1 );
		await page.locator( '#burger' ).click();
		expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( 'page menu-open' );
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'header light' );
		await page.keyboard.press( 'Escape' );
		expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( 'page' );
		expect( await page.locator( '#header' ).getAttribute( 'class' ) ).toBe( 'header dark' );
	} finally { await browser.close(); }
}, 30_000 );

// Squarespace's body carries its whole style configuration as classes, over
// the 2 KiB Blocks Engine keeps per value. Only the changed tokens are recorded
// and replayed, at 3 KB (under DLA's own 4 KiB bound) and beyond it.
for ( const [ size, count ] of [ [ '3 KB', 170 ], [ '7 KB', 400 ] ] as const ) {
	it.skipIf( skipBrowser )( `records only the changed tokens of a ${ size } ancestor class list`, async () => {
		const browser = await chromium.launch( { headless: true } );
		const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
		const config = Array.from( { length: count }, ( _, index ) => `tweak-setting-${ index }` ).join( ' ' );
		try {
			await page.setContent( `<!doctype html><style>
			body{margin:0}.overlay{position:fixed;inset:0;opacity:0;visibility:hidden;background:#fff}
			.menu-open .overlay{opacity:1;visibility:visible}
			</style><body class="${ config } menu-closed"><header id="header"><button id="burger">Open Menu</button><div class="overlay"><a href="/about">About</a></div></header><main>Body</main>
			<script>document.getElementById('burger').addEventListener('click',()=>{document.body.classList.add('menu-open');document.body.classList.remove('menu-closed');});
			addEventListener('keydown',event=>{if(event.key==='Escape'){document.body.classList.remove('menu-open');document.body.classList.add('menu-closed');}});</script>` );
			expect( Buffer.byteLength( config ) ).toBeGreaterThan( 2048 );
			if ( count === 170 ) expect( Buffer.byteLength( config ) ).toBeLessThan( 4096 );
			const report = await captureTriggeredDialogs( page, 'https://example.test/' );
			const state = report.states.find( item => item.trigger.id === 'burger' );
			expect( state?.dialog?.ancestorState ).toEqual( expect.objectContaining( {
				status: 'verified',
				ancestors: [ { selector: 'body', tag: 'body', depth: 2, closed: { class: 'tweak-setting-0 tweak-setting-1 tweak-setting-2 menu-closed' }, opened: { class: 'tweak-setting-0 tweak-setting-1 tweak-setting-2 menu-open' }, classTokensOnly: true } ],
			} ) );
			await page.setContent( wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), report.states ) );
			await page.locator( '#burger' ).click();
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( `${ config } menu-open` );
			await page.keyboard.press( 'Escape' );
			expect( await page.locator( 'body' ).getAttribute( 'class' ) ).toBe( `${ config } menu-closed` );
		} finally { await browser.close(); }
	}, 30_000 );
}

// Opening only adds a class to a long-classed header that wraps a nearer,
// unchanged header. The row keeps unchanged tokens, so a consumer that matches
// the nearest ancestor with the row's tag and closed tokens finds the outer
// header rather than the inner one.
it.skipIf( skipBrowser )( 'keeps identifying tokens when opening only adds to a long class list', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	const config = Array.from( { length: 200 }, ( _, index ) => `config-${ index }` ).join( ' ' );
	try {
		await page.setContent( `<!doctype html><style>
		body{margin:0}.overlay{position:fixed;inset:0;opacity:0;visibility:hidden;background:#fff}
		.open .overlay{opacity:1;visibility:visible}
		</style><header id="outer" class="${ config }"><header id="inner" class="bar"><button id="burger">Open Menu</button><div class="overlay"><a href="/about">About</a></div></header></header>
		<script>document.getElementById('burger').addEventListener('click',()=>document.getElementById('outer').classList.add('open'));
		addEventListener('keydown',event=>{if(event.key==='Escape')document.getElementById('outer').classList.remove('open');});</script>` );
		expect( Buffer.byteLength( config ) ).toBeGreaterThan( 2048 );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const rows = report.states.find( item => item.trigger.id === 'burger' )?.dialog?.ancestorState?.ancestors ?? [];
		expect( rows ).toEqual( [ { selector: '#outer', tag: 'header', depth: 2, closed: { class: 'config-0 config-1 config-2' }, opened: { class: 'config-0 config-1 config-2 open' }, classTokensOnly: true } ] );
		// Blocks Engine's lookup: the nearest ancestor with the tag and every closed token.
		const matched = await page.evaluate( row => {
			const wanted = row.closed.class!.split( /\s+/ ).filter( Boolean );
			for ( let node = document.getElementById( 'burger' )!.parentElement; node; node = node.parentElement ) {
				if ( node.tagName.toLowerCase() === row.tag && wanted.every( token => node!.classList.contains( token ) ) ) return node.id;
			}
			return null;
		}, rows[ 0 ]! );
		expect( matched ).toBe( 'outer' );
		await page.setContent( wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), report.states ) );
		await page.locator( '#burger' ).click();
		expect( await page.locator( '#outer' ).getAttribute( 'class' ) ).toBe( `${ config } open` );
		expect( await page.locator( '#inner' ).getAttribute( 'class' ) ).toBe( 'bar' );
		await page.keyboard.press( 'Escape' );
		expect( await page.locator( '#outer' ).getAttribute( 'class' ) ).toBe( config );
	} finally { await browser.close(); }
}, 30_000 );

it.skipIf( skipBrowser )( 'adds no ancestor evidence to a modal that leaves its ancestors unchanged', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
	try {
		await page.setContent( `<!doctype html><body><header><button id="burger">Open Menu</button></header><script>
		document.getElementById('burger').addEventListener('click',()=>{const nav=document.createElement('nav');nav.style.cssText='position:fixed;inset:0;background:#fff';nav.innerHTML='<a href="/about">About</a>';document.body.append(nav);
		addEventListener('keydown',()=>nav.remove(),{once:true});});</script>` );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const state = report.states.find( item => item.trigger.id === 'burger' );
		expect( state?.dialog?.presentation ).toBe( 'modal' );
		expect( state?.dialog ).not.toHaveProperty( 'ancestorState' );
	} finally { await browser.close(); }
}, 30_000 );
