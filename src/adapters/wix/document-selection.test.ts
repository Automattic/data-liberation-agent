import { describe, expect, it } from 'vitest';
import { WIX_CLASSIC_DEVICE_SELECTION, wixDocumentSelection } from './document-selection.js';
import { selectedDocument } from '../../lib/document-selection.js';

describe( 'classic Wix source request identity', () => {
	it( 'keeps tablet distinct even when its UA includes Mobile', () => {
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Mozilla/5.0 (iPad; CPU OS 12_2) Mobile/15E148 Safari' ) ).toBe( 'tablet' );
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) Chrome Safari' ) ).toBe( 'tablet' );
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7) Mobile Safari' ) ).toBe( 'mobile' );
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome Mobile Safari' ) ).toBe( 'mobile' );
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Opera/9.80 (Android; Opera Mini/32.0.2254; U; en) Presto Version/12.16' ) ).toBe( 'mobile' );
		expect( selectedDocument( WIX_CLASSIC_DEVICE_SELECTION, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome Safari' ) ).toBe( 'desktop' );
	} );
	it( 'declares selection only for captured classic desktop and optimized phone identities', () => {
		const desktop = '<meta id="wixDesktopViewport" name="viewport" content="width=device-width"><body>';
		const mobile = '<meta id="wixMobileViewport" name="viewport" content="width=320"><body class="device-mobile-optimized">';
		expect( wixDocumentSelection( { desktop, mobile } ) ).toBe( WIX_CLASSIC_DEVICE_SELECTION );
		expect( wixDocumentSelection( { desktop, mobile: mobile.replace( 'device-mobile-optimized', 'responsive device-mobile-optimized' ) } ) ).toBeUndefined();
		expect( wixDocumentSelection( { desktop, mobile: desktop } ) ).toBeUndefined();
	} );
} );
