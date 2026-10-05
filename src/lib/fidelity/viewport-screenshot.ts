import type { Page } from 'playwright';
import { PNG } from 'pngjs';

/** Capture the compositor viewport without Playwright's fractional CSS clip. */
export async function captureViewportScreenshot( page: Page ): Promise<Buffer> {
	const viewport = page.viewportSize();
	if ( ! viewport ) throw new Error( 'Screenshot viewport is undeclared' );
	const session = await page.context().newCDPSession( page );
	try {
		const result = await session.send( 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false } );
		const png = Buffer.from( result.data, 'base64' );
		const raster = PNG.sync.read( png );
		if ( raster.width !== viewport.width || raster.height !== viewport.height ) {
			throw new Error( `Screenshot viewport mismatch: ${ raster.width }x${ raster.height } !== ${ viewport.width }x${ viewport.height }` );
		}
		return png;
	} finally {
		await session.detach();
	}
}
