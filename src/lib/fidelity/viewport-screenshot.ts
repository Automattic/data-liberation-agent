import type { Page } from 'playwright';
import { PNG } from 'pngjs';

/**
 * Full-page baseline after the caller's cleanup, lazy-load sweep and readiness.
 *
 * CSS transitions are off while it is taken. Chromium's beyond-viewport capture
 * transiently re-evaluates the document's media queries, and a scroll probe that
 * just returned to the top can still be delivering its scroll event; either
 * starts a transition (a shrinking navbar logo growing back over 0.3s) that the
 * raster would catch part-way. Without transitions every style change lands on
 * its end value, which is the document's own resting state (#2048).
 */
export async function captureFullPageScreenshot( page: Page, excludedMotion: string[] = [] ): Promise<Buffer> {
	const transitions = await page.evaluateHandle( async () => {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync( '*, *::before, *::after { transition: none !important; }' );
		document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
		// Deliver pending scroll/resize work so a class it toggles lands now, at rest.
		await new Promise<void>( resolve => {
			const done = setTimeout( resolve, 100 );
			requestAnimationFrame( () => requestAnimationFrame( () => { clearTimeout( done ); resolve(); } ) );
		} );
		getComputedStyle( document.documentElement ).transitionProperty;
		return sheet;
	} );
	// Use the same authored-rest/terminal-entrance pose as geometry measurement.
	const hidden = await page.evaluateHandle( selectors => selectors.flatMap( selector => [ ...document.querySelectorAll<HTMLElement>( selector ) ] ).map( element => {
		const visibility = element.style.visibility;
		element.style.visibility = 'hidden';
		return { element, visibility };
	} ), excludedMotion );
	const effects = await page.evaluateHandle( () => {
		const effects = document.getAnimations().flatMap( animation => animation.effect instanceof KeyframeEffect
			? [ { effect: animation.effect, frames: animation.effect.getKeyframes(), animation } ] : [] );
		for ( const { effect, frames, animation } of effects ) {
			const first = frames[ 0 ], last = frames.at( -1 );
			const entrance = effect.getTiming().iterations !== Infinity && effect.getComputedTiming().endTime !== Infinity &&
				animation.timeline instanceof DocumentTimeline && first?.opacity !== undefined && last?.opacity !== undefined &&
				Number( first.opacity ) < Number( last.opacity ) && Number( last.opacity ) === 1;
			effect.setKeyframes( entrance ? [ { ...last, offset: 0 }, { ...last, offset: 1 } ] : [] );
		}
		return effects;
	} );
	try {
		const session = await page.context().newCDPSession( page );
		try {
			const metrics = await session.send( 'Page.getLayoutMetrics' );
			const viewport = page.viewportSize()!;
			const scale = viewport.width / metrics.cssVisualViewport.clientWidth;
			const result = await session.send( 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
				clip: { x: 0, y: 0, width: metrics.cssVisualViewport.clientWidth, height: Math.max( metrics.cssContentSize.height, metrics.cssVisualViewport.clientHeight ), scale },
			} );
			const raster = PNG.sync.read( Buffer.from( result.data, 'base64' ) );
			// CDP rounds fractional emulated screen clips to device pixels.
			const height = Math.round( raster.height * viewport.width / raster.width );
			const normalized = new PNG( { width: viewport.width, height } );
			for ( let y = 0; y < height; y++ ) for ( let x = 0; x < viewport.width; x++ ) {
				const source = ( Math.min( raster.height - 1, Math.floor( y * raster.height / height ) ) * raster.width + Math.min( raster.width - 1, Math.floor( x * raster.width / viewport.width ) ) ) * 4;
				raster.data.copy( normalized.data, ( y * viewport.width + x ) * 4, source, source + 4 );
			}
			return PNG.sync.write( normalized );
		} finally { await session.detach(); }
	} finally {
		await effects.evaluate( effects => { for ( const { effect, frames } of effects ) effect.setKeyframes( frames ); } );
		await effects.dispose();
		await hidden.evaluate( entries => { for ( const { element, visibility } of entries ) element.style.visibility = visibility; } );
		await hidden.dispose();
		await transitions.evaluate( sheet => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter( item => item !== sheet ); } );
		await transitions.dispose();
	}
}

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
