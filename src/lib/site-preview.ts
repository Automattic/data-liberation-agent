import { join } from 'node:path';
import { startStaticServer } from './replicate/local-site/static-server.js';

/** Render the portable entrypoint, independent of optional full-page evidence. */
export async function captureSitePreview( websiteDir: string ) {
	const { chromium } = await import( 'playwright' );
	const server = await startStaticServer( websiteDir );
	let browser: Awaited< ReturnType< typeof chromium.launch > > | undefined;
	try {
		browser = await chromium.launch( { headless: true } );
		const page = await browser.newPage( { viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 } );
		page.setDefaultTimeout( 15_000 );
		const response = await page.goto( server.url, { waitUntil: 'load', timeout: 30_000 } );
		if ( ! response?.ok() ) throw new Error( 'Portable homepage is unavailable for preview' );
		await page.evaluate( async () => {
			await Promise.race( [
				Promise.all( [ document.fonts.ready, ...Array.from( document.images, image => image.decode().catch( () => {} ) ) ] ),
				new Promise( resolve => setTimeout( resolve, 5_000 ) ),
			] );
		} );
		await page.screenshot( { path: join( websiteDir, 'site-preview.png' ), fullPage: false, timeout: 15_000 } );
		return { path: 'website/site-preview.png', width: 1200, height: 900, origin: 'portable_render' };
	} finally {
		try { await browser?.close(); } finally { await server.close(); }
	}
}
