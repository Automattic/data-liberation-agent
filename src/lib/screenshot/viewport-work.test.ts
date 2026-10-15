import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';
import { observeViewportWork } from './viewport-work.js';

const ORIGIN = 'https://viewport-work.test';

/** Served like a capture: both trackers are installed before the source runs. */
async function served( browser: Browser, body: string ): Promise< Page > {
	const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
	await page.addInitScript( observeRuntimeStyleWrites );
	await page.addInitScript( observeViewportWork );
	await page.route( `${ ORIGIN }/**`, route => route.fulfill( { contentType: 'text/html', body: `<!doctype html><html><body style="margin:0">${ body }
		</body></html>` } ) );
	await page.goto( `${ ORIGIN }/` );
	return page;
}

const widths = [ 390, 600, 768, 1024, 1440 ];

describe( 'fluid rest ends on viewport work evidence', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch( { headless: true } ); } );
	afterAll( async () => { await browser.close(); } );

	it( 'waits for a 400 ms debounced resize handler before sampling', async () => {
		// Like a bundled debounce utility, the source keeps its own timer reference.
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>
			const later = window.setTimeout, cancel = window.clearTimeout;
			const box = document.querySelector('#box');
			const fit = () => { box.style.width = innerWidth / 2 + 'px'; };
			let timer;
			addEventListener('resize', () => { cancel(timer); timer = later(fit, 400); });
			fit();
			</script>` );
		try {
			const started = performance.now();
			const result = await learnAndApplyFluidGeometry( page, { widths, settleMs: 800 } );
			console.info( JSON.stringify( { fixture: 'debounced-400ms', elapsedMs: Math.round( performance.now() - started ) } ) );
			expect( result ).toMatchObject( { unmodelled: 0, breakpoints: [], byKind: { container: 1, constant: 1 } } );
			expect( await page.locator( '#box' ).getAttribute( 'style' ) ).toBe( 'width: 50%; height: 40px;' );
			expect( await page.locator( '#box' ).evaluate( element => element.getBoundingClientRect().width ) ).toBeCloseTo( 720, 0 );
		} finally { await page.close(); }
	}, 30_000 );

	it( 'rests a width whose geometry settled at once without a fixed window', async () => {
		const page = await served( browser, `<div id="box" style="width:720px;height:40px">Neutral text</div>
			<script>const box = document.querySelector('#box'); const fit = () => { box.style.width = innerWidth / 2 + 'px'; }; addEventListener('resize', fit); fit();</script>` );
		try {
			const started = performance.now();
			const result = await learnAndApplyFluidGeometry( page, { widths, settleMs: 800 } );
			const elapsed = performance.now() - started;
			console.info( JSON.stringify( { fixture: 'settled-at-once', elapsedMs: Math.round( elapsed ) } ) );
			expect( result ).toMatchObject( { unmodelled: 0, breakpoints: [], byKind: { container: 1, constant: 1 } } );
			expect( await page.locator( '#box' ).getAttribute( 'style' ) ).toBe( 'width: 50%; height: 40px;' );
			// Five widths and the return: a fixed one-second window per rest alone
			// cost 6 s (8.2 s in total, against 3.8 s resting on evidence).
			expect( elapsed ).toBeLessThan( 5000 );
		} finally { await page.close(); }
	}, 30_000 );
} );
