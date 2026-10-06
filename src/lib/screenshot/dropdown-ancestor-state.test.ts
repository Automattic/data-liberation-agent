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

it.skipIf( skipBrowser )( 'does not overwrite an ancestor edited after its captured proof', async () => {
	const browser = await chromium.launch( { headless: true } );
	const page = await browser.newPage();
	try {
		await page.setContent( fixture() );
		const report = await captureTriggeredDialogs( page, 'https://example.test/' );
		const baseline = ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ).replace( 'id="header" class="closed"', 'id="header" class="owner-edited"' );
		const portable = wireCapturedDialogs( baseline, report.states );
		expect( portable ).toContain( 'data-dla-dialog-ancestor-unverified="portable-owner-mismatch"' );
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
			expect( portable ).not.toContain( 'data-dla-dialog-ancestor-state=' );
			await page.close();
		}
	} finally { await browser.close(); }
}, 30_000 );
