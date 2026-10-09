import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observePage } from './check.js';
import { checkTypography } from './rendered-contract-checks.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'painted inline typography correspondence', () => {
 let browser: Awaited< ReturnType< typeof chromium.launch > >;
 beforeAll( async () => { browser = await chromium.launch(); } );
 afterAll( async () => { await browser?.close(); } );

	it( 'compares adjacent text, comments and equivalent spans to serialized text at all reference widths', async () => {
		try {
			for ( const width of [ 390, 768, 1440 ] ) {
				const page = await browser.newPage( { viewport: { width, height: 900 } } );
				const observe = async ( content: string ) => {
					await page.setContent( `<style>body{font:16px/28px Arial}footer{line-height:24px}</style>${ content }` );
					return observePage( page, 'about:blank', width, 0, null, undefined, undefined, true, true );
				};
				const source = await observe( '<label>Email <!--framework--><span>*</span></label><label style="display:block">Nome <span><span>*</span></span></label><footer>©2026<!--framework--> <span>BethStuqui</span></footer>' );
				const candidate = await observe( '<label>Email *</label><label style="display:block">Nome *</label><footer>©2026 BethStuqui</footer>' );
				expect( source.typography ).toEqual( candidate.typography );
				expect( checkTypography( source, candidate ).failures ?? [] ).toEqual( [] );
				for ( const style of [ 'font-family:monospace', 'font-size:24px', 'font-weight:700', 'font-style:italic', 'letter-spacing:3px', 'position:absolute;left:200px', 'position:relative;left:40px', 'display:block', 'display:inline-block', 'margin-left:40px' ] ) {
					const changed = await observe( `<label>Email <span style="${ style }">*</span></label><label style="display:block">Nome <span style="${ style }">*</span></label><footer>©2026 <span style="${ style }">BethStuqui</span></footer>` );
					expect( checkTypography( source, changed ).failures?.length, `${ width }: ${ style }` ).toBeGreaterThan( 0 );
				}
				await page.close();
			}
		} finally { /* shared browser is closed after the suite */ }
	}, 60_000 );
	it( 'retains word boundaries and natural line wrapping without joining across a break or replaced box', async () => {
		const page = await browser.newPage();
		try {
			const observe = async ( content: string ) => {
				await page.setContent( `<style>p{width:110px;font:16px/28px Arial}</style><p>${ content }</p>` );
				return observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			};
			const source = await observe( 'Contiguous<!--comment--><span> typography</span> <span>wraps naturally</span>' );
			const merged = await observe( 'Contiguous typography wraps naturally' );
			expect( source.typography ).toEqual( merged.typography );
			expect( source.typography?.map( item => item.key ) ).toEqual( [ 'Contiguous typography wraps naturally' ] );
			for ( const boundary of [ '<br>', '<img width="40" height="20" alt="">', '<span style="display:inline-block;width:40px"></span>' ] ) {
				const separated = await observe( `Contiguous${ boundary } typography wraps naturally` );
				expect( checkTypography( source, separated ).failures?.length, boundary ).toBeGreaterThan( 0 );
			}
		} finally { await page.close(); }
	}, 30_000 );
} );
