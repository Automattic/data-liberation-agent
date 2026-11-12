import { describe, expect, it } from 'vitest';
import { detectFromUrl } from '../../lib/detect-platform/detect-platform.js';
import { resolveEntryUrl } from '../../platform/registry.js';
import '../../platform/builtins.js';
import { figmaMakePreviewEntry, isFigmaMakeEditorUrl } from './entry.js';

const PREVIEW = 'https://3c04aff9-7285-4853-8e58-114b456bca0c-figmacachedpreview.figma.site';

describe( 'Figma Make editor links', () => {
	it.each( [
		[ 'https://www.figma.com/make/of2o08CoVFYoccXPtE4i0c/Booking-Site?t=abc-1/', true ],
		[ 'https://figma.com/make/of2o08CoVFYoccXPtE4i0c', true ],
		[ 'https://www.figma.com/make/of2o08CoVFYoccXPtE4i0c/Booking-Site?p=f', true ],
		[ 'http://www.figma.com/make/of2o08CoVFYoccXPtE4i0c/Booking-Site', false ],
		[ 'https://www.figma.com/design/of2o08CoVFYoccXPtE4i0c/Booking-Site', false ],
		[ 'https://www.figma.com/make/', false ],
		[ 'https://www.figma.com/blog/make/', false ],
		[ 'https://www.figma.com/', false ],
		[ 'https://figma.com.evil.test/make/of2o08CoVFYoccXPtE4i0c', false ],
		[ 'https://acme.com/make/of2o08CoVFYoccXPtE4i0c', false ],
	] )( '%s → %s', ( url, claimed ) => {
		expect( isFigmaMakeEditorUrl( new URL( url ) ) ).toBe( claimed );
	} );

	it( 'leaves links no platform claims unchanged without loading anything', async () => {
		await expect( resolveEntryUrl( 'https://www.figma.com/blog/' ) ).resolves.toBe( 'https://www.figma.com/blog/' );
		await expect( resolveEntryUrl( 'https://acme.com/make/abc' ) ).resolves.toBe( 'https://acme.com/make/abc' );
	} );
} );

describe( 'Figma Make preview entry', () => {
	it( 'takes the editor’s tokenized preview navigation', () => {
		const url = `${ PREVIEW }/?__figma_cached_preview_token=eyJhbGciOiJFUzI1NiJ9.e30.sig`;
		expect( figmaMakePreviewEntry( url ) ).toBe( url );
	} );

	it.each( [
		`${ PREVIEW }/`,
		`${ PREVIEW }/?__figma_cached_preview_token=`,
		`http://3c04aff9-figmacachedpreview.figma.site/?__figma_cached_preview_token=t`,
		'https://adriarenas.figma.site/?__figma_cached_preview_token=t',
		'https://figmacachedpreview.figma.site.evil.test/?__figma_cached_preview_token=t',
		'https://make-iframe-init-v2.figma.site/',
		'not a url',
	] )( 'ignores %s', ( url ) => {
		expect( figmaMakePreviewEntry( url ) ).toBeUndefined();
	} );

	it( 'detects the preview origin, and only the preview origin', () => {
		expect( detectFromUrl( `${ PREVIEW }/tours` ) ).toBe( 'figma-make' );
		expect( detectFromUrl( 'https://adriarenas.figma.site/' ) ).not.toBe( 'figma-make' );
		expect( detectFromUrl( 'https://www.figma.com/make/of2o08CoVFYoccXPtE4i0c/Booking-Site' ) ).not.toBe( 'figma-make' );
	} );
} );
