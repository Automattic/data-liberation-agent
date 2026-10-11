import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';

const ORIGIN = 'https://runtime-style.test';

async function served( browser: Browser, body: string ): Promise< Page > {
	const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
	await page.addInitScript( observeRuntimeStyleWrites );
	await page.route( `${ ORIGIN }/**`, route => route.fulfill( { contentType: 'text/html', body: `<!doctype html><html><body style="margin:0">${ body }
		</body></html>` } ) );
	await page.goto( `${ ORIGIN }/` );
	return page;
}

const sweep = { widths: [ 390, 768, 1440 ], settleMs: 800 };

/** Count viewport changes from outside the page, without registering a source listener. */
function countResizes( page: Page ): () => number {
	let count = 0;
	const resize = page.setViewportSize.bind( page );
	page.setViewportSize = async size => { count++; return resize( size ); };
	return () => count;
}

describe( 'runtime style writes gate the responsive sweep', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch( { headless: true } ); } );
	afterAll( async () => { await browser.close(); } );

	it( 'skips the sweep when every inline pixel declaration was served in the markup', async () => {
		const page = await served( browser, '<div id="box" style="padding-top:18px;width:720px;height:40px">Neutral text</div>' );
		try {
			const resizes = countResizes( page );
			const result = await learnAndApplyFluidGeometry( page, sweep );
			expect( result ).toMatchObject( { applied: 0, unmodelled: 0 } );
			expect( resizes() ).toBe( 0 );
			expect( await page.locator( '#box' ).getAttribute( 'style' ) ).toBe( 'padding-top:18px;width:720px;height:40px' );
			expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'learns a served declaration that a resize handler rewrites', async () => {
		// Hydration writes the served value again, which is no mutation; only the
		// registered resize handler shows the declaration is width-dependent.
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>const box = document.querySelector('#box'); function resize() { box.style.width = innerWidth / 2 + 'px'; } addEventListener('resize', resize); resize();</script>` );
		try {
			const resizes = countResizes( page );
			const result = await learnAndApplyFluidGeometry( page, sweep );
			expect( result.applied ).toBeGreaterThan( 0 );
			expect( resizes() ).toBeGreaterThan( 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'learns geometry on elements script inserted after parsing', async () => {
		const page = await served( browser, `<main></main>
			<script>addEventListener('DOMContentLoaded', () => { const box = document.createElement('div'); box.id = 'box'; box.style.cssText = 'width:' + innerWidth / 2 + 'px;height:40px'; document.querySelector('main').append(box);
				addEventListener('resize', () => { box.style.width = innerWidth / 2 + 'px'; }); });</script>` );
		try {
			await page.waitForSelector( '#box' );
			const resizes = countResizes( page );
			const result = await learnAndApplyFluidGeometry( page, sweep );
			expect( result.applied ).toBeGreaterThan( 0 );
			expect( resizes() ).toBeGreaterThan( 0 );
		} finally { await page.close(); }
	}, 30_000 );
	it.each( [
		[ 'ResizeObserver', 'new ResizeObserver(() => { box.style.width = box.parentElement.clientWidth / 2 + "px"; }).observe(document.body);' ],
		[ 'media query listener', 'matchMedia("(max-width: 800px)").addEventListener("change", event => { box.style.width = event.matches ? "200px" : "720px"; });' ],
		[ 'onresize handler', 'window.onresize = () => { box.style.width = innerWidth / 2 + "px"; };' ],
	] )( 'keeps the sweep when a %s can react to viewport changes', async ( _, script ) => {
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div><script>const box = document.querySelector('#box'); ${ script }</script>` );
		try {
			const resizes = countResizes( page );
			await learnAndApplyFluidGeometry( page, sweep );
			expect( resizes() ).toBeGreaterThan( 0 );
		} finally { await page.close(); }
	}, 30_000 );
	it( 'probes the width extremes and skips the rest when viewport listeners never write geometry', async () => {
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>window.seen = 0; addEventListener('resize', () => { window.seen = innerWidth; });</script>` );
		try {
			const resizes = countResizes( page );
			const result = await learnAndApplyFluidGeometry( page, sweep );
			expect( result ).toMatchObject( { applied: 0, unmodelled: 0 } );
			// Narrowest, widest, and the return to the capture width.
			expect( resizes() ).toBe( 3 );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.locator( '[data-dla-fluid-id]' ).count() ).toBe( 0 );
		} finally { await page.close(); }
	}, 30_000 );
	it( 'keeps the sweep when a debounced resize handler writes geometry late', async () => {
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>const box = document.querySelector('#box'); let timer; addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => { box.style.width = innerWidth / 2 + 'px'; }, 400); });</script>` );
		try {
			const result = await learnAndApplyFluidGeometry( page, sweep );
			expect( result.applied ).toBeGreaterThan( 0 );
		} finally { await page.close(); }
	}, 60_000 );

	it( 'probes without the sampling sweep readiness', async () => {
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>addEventListener('resize', () => {});</script>` );
		try {
			const started = performance.now();
			await learnAndApplyFluidGeometry( page, { ...sweep, settleMs: 1200 } );
			// Three quiet windows; the sampling readiness needed at least settleMs each.
			expect( performance.now() - started ).toBeLessThan( 3 * 1200 );
		} finally { await page.close(); }
	}, 30_000 );
} );
