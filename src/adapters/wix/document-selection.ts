import * as cheerio from 'cheerio';
import type { DeviceDocumentSelection } from '../../lib/document-selection.js';
import type { CaptureProfile } from '../../lib/screenshot/capture-profiles.js';

export function wixAdditionalProfiles( desktopHtml: string ): CaptureProfile[] {
	const $ = cheerio.load( desktopHtml );
	if ( $( 'meta#wixDesktopViewport[name="viewport"]' ).length !== 1 || $( 'body' ).hasClass( 'responsive' ) ) return [];
	return [ { id: 'tablet', device: 'iPad (gen 7)', width: 768, height: 900, referenceWidths: [ 390, 768, 1440 ], learnFluid: true } ];
}

/** Bounded translation of classic Wix request identities verified on public responses.
 * iPad receives the tablet head despite its Mobile token. Explicit phone browser
 * families precede Android tablet fallback (Opera Mini's Android UA lacks Mobile).
 * This is not image-kit's viewport-dependent image-fitting predicate.
 */
export const WIX_CLASSIC_DEVICE_SELECTION: DeviceDocumentSelection = {
	kind: 'device', id: 'wix-classic-request-identity/v1',
	documents: [ 'desktop', 'mobile', 'tablet' ], defaultDocument: 'desktop',
	rules: [
		{ userAgent: 'iPad', flags: 'i', document: 'tablet' },
		{ userAgent: 'iPhone|iPod|Android.*Mobile|BlackBerry|IEMobile|Windows Phone|Opera Mini', flags: 'i', document: 'mobile' },
		{ userAgent: 'Android', flags: 'i', document: 'tablet' },
	],
	evidence: 'Public classic Wix responses classify desktop browser UAs as Desktop, iPhone/iPod/Android Mobile/BlackBerry/Windows Phone/Opera Mini as Smartphone, and iPad/Android tablet UAs as Tablet. Explicit phone browser families precede Android fallback. Thunderbolt consumes viewMode and deviceInfo.deviceClass; this bounded UA translation does not claim the complete private server classifier.',
};

export function wixDocumentSelection( documents: Readonly<Record<string, string>> ): DeviceDocumentSelection | undefined {
	const desktop = cheerio.load( documents.desktop ?? '' );
	const mobile = cheerio.load( documents.mobile ?? '' );
	if ( desktop( 'meta#wixDesktopViewport[name="viewport"]' ).length !== 1 ||
		mobile( 'meta#wixMobileViewport[name="viewport"]' ).length !== 1 ||
		! mobile( 'body' ).hasClass( 'device-mobile-optimized' ) || mobile( 'body' ).hasClass( 'responsive' ) ) return undefined;
	if ( documents.tablet ) {
		const tablet = cheerio.load( documents.tablet );
		if ( tablet( 'meta#wixTabletViewport[name="viewport"]' ).length !== 1 || ! tablet( 'body' ).hasClass( 'device-mobile-non-optimized' ) ) throw new Error( 'Wix tablet document identity is unproven' );
	}
	return WIX_CLASSIC_DEVICE_SELECTION;
}
