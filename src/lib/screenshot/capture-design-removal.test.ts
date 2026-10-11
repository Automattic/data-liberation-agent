import { expectTypeOf, it } from 'vitest';
import type { ScreenshotOpts, ScreenshotResult } from './types.js';

it( 'does not expose the removed capture-design option or result fields', () => {
	expectTypeOf< ScreenshotOpts >().not.toHaveProperty( 'captureDesign' );
	expectTypeOf< ScreenshotOpts >().not.toHaveProperty( 'includeScripts' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'siteCssPath' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'cssMediaUrls' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'headLinks' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'siteJsText' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'nav' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'footerHtml' );
	expectTypeOf< ScreenshotResult >().not.toHaveProperty( 'chromeCssText' );
} );
