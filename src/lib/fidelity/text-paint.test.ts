import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { observePage } from './check.js';

const skipped = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );
describe.skipIf( skipped )( 'rendered text range visibility', () => {
	it( 'excludes zero-font and empty rectangular clips while preserving prose, duplicates and styled descendants', async () => {
		const browser = await chromium.launch();
		try {
			for ( const width of [ 390, 768, 1440 ] ) {
				const page = await browser.newPage( { viewport: { width, height: 900 } } );
				const visible = '<p>Ordinary hero copy.</p><p>Repeated label</p><p>Repeated label</p><p>Contact paragraph stays.</p><p>Visible descendant</p>';
				await page.setContent( visible );
				const source = await observePage( page, page.url(), width, 0, null, undefined, undefined, true, true );
				await page.setContent( `<style>
					.zero { font-size:0; line-height:0 }
					.legacy { position:absolute; width:200px; height:30px; clip:rect(0px,0px,0px,0px) }
					.inset { position:absolute; width:200px; height:30px; clip-path:inset(50%) }
					.tiny { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
				</style><span class="zero">Repeated label</span>${ visible.replace( '<p>Visible descendant</p>', '<div class="zero">Unpainted parent<span style="font-size:16px;line-height:normal">Visible descendant</span></div>' ) }
				<span class="zero">Extra accessible name</span><span class="legacy">Legacy clip name</span>
				<span class="inset">Inset clip name</span><span class="tiny">Tiny clip name</span>` );
				const candidate = await observePage( page, page.url(), width, 0, null, undefined, undefined, true, true );
				expect( candidate.textChars ).toBe( source.textChars );
				const keys = candidate.typography?.map( run => run.key ) ?? [];
				expect( keys ).toContain( 'Visible descendant' );
				expect( keys ).not.toContain( 'Inset clip name' );
				expect( keys ).not.toContain( 'Legacy clip name' );
				await page.close();
			}
		} finally { await browser.close(); }
	}, 60_000 );

	it( 'counts partly painted text and focused links, including visible aria-hidden editorial labels', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		try {
			await page.setContent( `<style>body{margin:0;background:white;color:black}
				.partial{position:absolute;top:120px;left:20px;width:200px;height:24px;font:20px monospace;clip-path:inset(0 95% 0 0)}
				.focus{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
				.focus:focus{width:auto;height:auto;overflow:visible;clip-path:none}
			</style><a class="focus" href="#main">Focused link</a><main id="main"><p>Repeated label</p><p aria-hidden="true">Repeated label</p></main><span class="partial">MMMM partial text</span>` );
			const resting = await observePage( page, page.url(), 390, 0, null, undefined, undefined, true, true );
			expect( resting.textChars ).toBe( 'Repeated label Repeated label MMMM partial text'.length );
			expect( resting.typography?.map( run => run.key ) ).toContain( 'MMMM partial text' );
			const png = PNG.sync.read( await page.locator( '.partial' ).screenshot() );
			expect( [ ...png.data ].some( ( value, index ) => index % 4 < 3 && value < 100 ) ).toBe( true );
			await page.locator( '.focus' ).focus();
			const focused = await observePage( page, page.url(), 390, 0, null, undefined, undefined, true, true );
			expect( focused.textChars ).toBe( 'Focused link Repeated label Repeated label MMMM partial text'.length );
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'does not insert phantom separators when unpainted inline text is removed', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();
		try {
			await page.setContent( '<p>prefix<span style="font-size:0">Hidden label</span>suffix</p>' );
			const observation = await observePage( page, page.url(), 390, 0, null, undefined, undefined, true, true );
			expect( observation.textChars ).toBe( 'prefixsuffix'.length );
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'keeps visible descendants through hidden ancestors and conservative nonrectangular clips', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();
		try {
			await page.setContent( '<div style="visibility:hidden">Unpainted ancestor<span style="visibility:visible">Visible child</span></div><p style="clip-path:polygon(0 0,100% 0,100% 100%,0 100%)">Ordinary polygon content</p>' );
			const observation = await observePage( page, page.url(), 390, 0, null, undefined, undefined, true, true );
			expect( observation.textChars ).toBe( 'Visible child Ordinary polygon content'.length );
			expect( observation.typography?.map( run => run.key ) ).toContain( 'Visible child' );
		} finally { await browser.close(); }
	}, 30_000 );
} );
