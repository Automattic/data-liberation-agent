import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { observeRuntimeStyleWrites } from './runtime-style-writes.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';
import { captureViewportClassStates } from './viewport-class-states.js';

// A sidebar script pins the menu open at wide widths and draws its toggle open
// with it (the Google Sites pattern); narrower widths show the closed icon.
const source = `<!doctype html><html><head><style>
.bar{display:block;width:20px;height:2px;transform:none}
.open .bar{transform:rotate(45deg)}
@media (min-width:600px){.open .bar{background:red}}
</style></head><body><button><span class="icon"><i class="bar"></i></span></button><script>
const sync=()=>document.querySelector('.icon').setAttribute('class',innerWidth>=1280?'icon open':'icon');
addEventListener('resize',sync);sync();
</script></body></html>`;

it( 'serves script-toggled class state at the widths the source applied it', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await page.addInitScript( observeRuntimeStyleWrites );
		await page.setContent( source );
		await markInitialDocument( page );
		const initial = await page.content();
		const result = await captureViewportClassStates( page, { settleMs: 0 } );
		expect( result.aliased ).toBe( 1 );

		// The serialized copy is the pre-sweep document plus what the sweep learned;
		// the source script rewrites classes on later resizes, and the copy runs no script.
		await page.setViewportSize( { width: 1024, height: 900 } );
		await page.setViewportSize( { width: 1440, height: 900 } );
		const copy = projectInitialDocument( initial, await page.content() ).replace( /<script\b[\s\S]*?<\/script>/gi, '' );
		const exported = await browser.newPage();
		await exported.setContent( copy );
		const bar = async ( width: number ) => {
			await exported.setViewportSize( { width, height: 900 } );
			return exported.evaluate( () => {
				const style = getComputedStyle( document.querySelector( '.bar' )! );
				return { open: style.transform !== 'none', red: style.backgroundColor === 'rgb(255, 0, 0)' };
			} );
		};
		expect( await bar( 1440 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1280 ) ).toEqual( { open: true, red: true } );
		expect( await bar( 1279 ) ).toEqual( { open: false, red: false } );
		expect( await bar( 1024 ) ).toEqual( { open: false, red: false } );
	} finally {
		await browser.close();
	}
}, 60_000 );
