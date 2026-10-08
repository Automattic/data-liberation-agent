import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { captureFluidBaseline } from './fluid-baseline.js';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

it( 'restores unlearned replacement roles without replacing the returned learned geometry', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( '<div id="learned" style="width:80px">Learned</div><div id="unlearned">Authored</div>' );
		const baseline = await captureFluidBaseline( page, 'data-dla-fluid-id' );
		await page.locator( '#learned' ).evaluate( node => node.setAttribute( 'data-dla-fluid-id', 'desktop-0' ) );
		await baseline.evaluate( state => state.bind() );
		await page.evaluate( () => {
			( document.querySelector( '#learned' ) as HTMLElement ).style.width = '320px';
			const original = document.querySelector( '#unlearned' )!;
			const replacement = original.cloneNode( true ) as HTMLElement;
			replacement.style.height = '480px';
			original.replaceWith( replacement );
		} );
		await baseline.evaluate( state => state.restore( true ) );
		expect( await page.locator( '#learned' ).evaluate( node => ( node as HTMLElement ).style.width ) ).toBe( '320px' );
		expect( await page.locator( '#unlearned' ).getAttribute( 'style' ) ).toBeNull();
		await baseline.evaluate( state => state.cleanup() );
		await baseline.dispose();
	} finally { await browser.close(); }
} );

it.each( [
	[ 'copy', 'Array.prototype.entries = function () { return this.slice(); };' ],
	[ 'deleted', 'delete Array.prototype.entries;' ],
] )( 'restores and cleans replacement roles when main-world Array.entries is %s', async ( _mode, patch ) => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( `<script>${ patch }Array.from = function (value) { return Array.isArray(value) ? value.slice() : []; };</script><div class="active"><nav id="duplicate" class="menu" data-dla-fluid-id="mobile-0" style="width:400px">Active</nav></div><div class="spacer"><nav id="duplicate" class="menu" data-dla-fluid-id="mobile-1" style="width:80px;left:13px">Clone</nav></div>` );
		const baseline = await captureFluidBaseline( page, 'data-dla-fluid-id' );
		await baseline.evaluate( state => state.bind() );
		await page.evaluate( () => document.querySelector( '.spacer .menu' )!.replaceWith( document.querySelector( '.active .menu' )!.cloneNode( true ) ) );
		await baseline.evaluate( state => state.reconcile() );
		await baseline.evaluate( state => state.restore() );
		expect( ( await page.locator( '.spacer .menu' ).boundingBox() )!.width ).toBe( 80 );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.left ) ).toBe( '13px' );
		await baseline.evaluate( state => state.cleanup() );
		expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		await baseline.dispose();
	} finally {
		await browser.close();
	}
} );

it( 'keeps finalized clone geometry after cleanup while allowing source controls to open', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 402, height: 900 } } );
		await page.setContent( '<div class="active"><nav id="duplicate" class="menu" aria-hidden="true" style="width:402px;left:5px">Active</nav></div><div class="spacer"><nav id="duplicate" class="menu" aria-hidden="true" style="width:80px;left:13px">Clone</nav></div>' );
		const baseline = await captureFluidBaseline( page, 'data-dla-fluid-id' );
		await page.locator( '.active .menu' ).evaluate( element => element.setAttribute( 'data-dla-fluid-id', 'mobile-0' ) );
		await baseline.evaluate( state => state.bind() );
		await baseline.evaluate( state => state.activate( [ { id: 'mobile-0', property: 'width', css: '100vw', segmented: false } ], 'data-dla-fluid-segment', 402 ) );
		await baseline.evaluate( state => state.cleanup() );
		await page.evaluate( () => document.querySelector( '.spacer .menu' )!.replaceWith( document.querySelector( '.active .menu' )!.cloneNode( true ) ) );
		await page.waitForFunction( () => ( document.querySelector( '.spacer .menu' ) as HTMLElement ).style.width === '80px' );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.left ) ).toBe( '13px' );
		expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		await page.locator( '.spacer .menu' ).evaluate( element => {
			const opened = element.cloneNode( true ) as HTMLElement;
			opened.setAttribute( 'aria-hidden', 'false' );
			opened.style.width = '120px';
			opened.style.left = '77px';
			element.replaceWith( opened );
		} );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '120px' );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.left ) ).toBe( '77px' );
		await baseline.dispose();
	} finally {
		await browser.close();
	}
} );

it.each( [ '20px', '100vw' ] )( 'freezes a width when its fit or container fallback misses the returned source sample (%s parent)', async parentWidth => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 402, height: 900 } } );
		await page.setContent( `<div style="width:${ parentWidth }"><div id="tile" style="width:80px;height:20px">Tile</div></div><script>addEventListener('resize',()=>document.querySelector('#tile').style.width=(innerWidth===402?80:innerWidth)+'px')</script>` );
		const result = await learnAndApplyFluidGeometry( page, { widths: [ 390, 600, 768, 1440 ], settleMs: 10 } );
		expect( ( await page.locator( '#tile' ).boundingBox() )!.width ).toBe( 80 );
		expect( result.unmodelled ).toBe( 1 );
		expect( await page.locator( '#tile' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '80px' );
		await page.locator( '#tile' ).evaluate( element => { ( element as HTMLElement ).style.width = '13px'; } );
		expect( ( await page.locator( '#tile' ).boundingBox() )!.width ).toBe( 80 );
	} finally {
		await browser.close();
	}
}, 15_000 );

it( 'rebinds copied identities to the original clone role without borrowing active geometry', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( '<div class="active"><div id="duplicate" class="menu" style="width:400px;left:5px">Active</div></div><div class="spacer"><div id="duplicate" class="menu" style="width:80px;left:13px">Clone</div></div>' );
		const baseline = await captureFluidBaseline( page, 'data-dla-fluid-id' );
		await page.evaluate( () => {
			document.querySelector( '.active .menu' )!.setAttribute( 'data-dla-fluid-id', 'mobile-0' );
			document.querySelector( '.spacer .menu' )!.setAttribute( 'data-dla-fluid-id', 'mobile-1' );
		} );
		await baseline.evaluate( state => state.bind() );
		await page.evaluate( () => {
			document.querySelector( '.spacer .menu' )!.replaceWith( document.querySelector( '.active .menu' )!.cloneNode( true ) );
			document.querySelector( '.spacer .menu' )!.classList.add( 'runtime-state' );
		} );
		await baseline.evaluate( state => state.reconcile() );
		expect( await page.locator( '.spacer .menu' ).getAttribute( 'data-dla-fluid-id' ) ).toBe( 'mobile-1' );
		await baseline.evaluate( state => state.restore() );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '80px' );
		expect( await page.locator( '.spacer .menu' ).evaluate( element => ( element as HTMLElement ).style.left ) ).toBe( '13px' );
		expect( await page.locator( '.active .menu' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '400px' );
		// The same slot holding a different source role is not a replacement proof.
		await page.locator( '.spacer .menu' ).evaluate( element => { element.setAttribute( 'class', 'unrelated' ); ( element as HTMLElement ).style.width = '99px'; } );
		await baseline.evaluate( state => state.restore() );
		expect( await page.locator( '.unrelated' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '99px' );
		expect( await page.locator( '.unrelated' ).getAttribute( 'data-dla-fluid-id' ) ).toBeNull();
		await baseline.evaluate( state => state.cleanup() );
		expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		await baseline.dispose();
	} finally {
		await browser.close();
	}
} );

it( 'restores viewport and removes copied temporary identities when a sweep fails', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 402, height: 900 } } );
		await page.setContent( '<main style="width:402px">Content</main><script>addEventListener("resize",()=>{const old=document.querySelector("main"),next=old.cloneNode(true);old.replaceWith(next);next.style.width=innerWidth+"px"})</script>' );
		const resize = page.setViewportSize.bind( page );
		vi.spyOn( page, 'setViewportSize' ).mockImplementationOnce( async viewport => {
			await resize( viewport );
			await page.waitForTimeout( 50 );
			throw new Error( 'interrupted source measurement' );
		} );
		await expect( learnAndApplyFluidGeometry( page, { widths: [ 390, 768 ], settleMs: 10 } ) ).rejects.toThrow( 'interrupted source measurement' );
		expect( page.viewportSize()!.width ).toBe( 402 );
		expect( await page.locator( 'main' ).evaluate( element => ( element as HTMLElement ).style.width ) ).toBe( '402px' );
		expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
	} finally {
		await browser.close();
	}
} );
