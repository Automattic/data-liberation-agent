// src/adapters/wix/image-geometry.ts
//
// Wix's `<wow-image>` runtime sizes its `<img>` in pixels to the image's
// container on every resize: `width:1440px;height:715px` at 1440, then
// `width:980px;height:715px` at 390, with `object-fit` already inline. The
// relationship it maintains is declared on the host's `data-image-info`, so
// the copy can carry it as container-relative CSS instead of the width sweep
// rediscovering it from pixels.
//
import type { Page } from 'playwright';

const WIX_IMAGE_HOST = 'wow-image[data-image-info]';

/** Display modes whose rendering is the image filling its container box. */
const OBJECT_FIT: Readonly< Record< string, string > > = { fill: 'cover', fit: 'contain' };

/** Wix `alignType` as the `object-position` the runtime writes for it. */
const OBJECT_POSITION: Readonly< Record< string, string > > = {
	center: '50% 50%',
	top: '50% 0%',
	bottom: '50% 100%',
	left: '0% 50%',
	right: '100% 50%',
	top_left: '0% 0%',
	top_right: '100% 0%',
	bottom_left: '0% 100%',
	bottom_right: '100% 100%',
};

export interface WixImageGeometry {
	objectFit: string;
	objectPosition: string;
}

/**
 * The CSS a `data-image-info` declaration stands for, or null when its display
 * mode or alignment is not one whose container-relative rendering is known.
 *
 * Pure, so the declaration shape this depends on is testable without a browser.
 */
export function wixImageGeometry( imageInfo: string | null ): WixImageGeometry | null {
	let info: unknown;
	try {
		info = JSON.parse( imageInfo ?? '' );
	} catch {
		return null;
	}
	if ( ! info || typeof info !== 'object' ) return null;
	const { displayMode, alignType, imageData } = info as { displayMode?: unknown; alignType?: unknown; imageData?: { displayMode?: unknown } };
	if ( typeof displayMode !== 'string' || typeof alignType !== 'string' ) return null;
	if ( imageData?.displayMode !== undefined && imageData.displayMode !== displayMode ) return null;
	const objectFit = Object.hasOwn( OBJECT_FIT, displayMode ) ? OBJECT_FIT[ displayMode ] : undefined;
	const objectPosition = Object.hasOwn( OBJECT_POSITION, alignType ) ? OBJECT_POSITION[ alignType ] : undefined;
	return objectFit && objectPosition ? { objectFit, objectPosition } : null;
}

/**
 * In-page: replace each declared image's pixel box with `100%` of its host and
 * stop the host re-deriving pixels on resize. An image is left to the runtime
 * unless its inline pixels are its host's box, its inline fit and position are
 * what the declaration stands for, the rewrite renders the same box, and the
 * runtime can be told to stop observing resizes.
 */
function applyWixImageGeometry( { selector, declared }: { selector: string; declared: Array< { info: string | null; geometry: WixImageGeometry | null } > } ): number {
	const hosts = [ ...document.querySelectorAll< HTMLElement & { unobserveResize?: () => void } >( selector ) ];
	const pixels = ( value: string ): number | null => /^\d+(?:\.\d+)?px$/.test( value ) ? parseFloat( value ) : null;
	const near = ( a: DOMRect, b: { x: number; y: number; width: number; height: number } ) =>
		Math.abs( a.x - b.x ) <= 1 && Math.abs( a.y - b.y ) <= 1 && Math.abs( a.width - b.width ) <= 1 && Math.abs( a.height - b.height ) <= 1;
	let applied = 0;
	hosts.forEach( ( host, index ) => {
		const { info, geometry } = declared[ index ] ?? { info: null, geometry: null };
		if ( host.getAttribute( 'data-image-info' ) !== info ) return;
		const image = host.querySelector< HTMLImageElement >( ':scope > img' );
		if ( ! geometry || ! image || typeof host.unobserveResize !== 'function' ) return;
		const { style } = image;
		const width = pixels( style.width );
		const height = pixels( style.height );
		if ( width === null || height === null || style.getPropertyPriority( 'width' ) || style.getPropertyPriority( 'height' ) ) return;
		if ( style.objectFit !== geometry.objectFit || style.objectPosition !== geometry.objectPosition ) return;
		const box = host.getBoundingClientRect();
		if ( Math.abs( box.width - width ) > 1 || Math.abs( box.height - height ) > 1 ) return;
		const before = image.getBoundingClientRect();
		const previous = image.getAttribute( 'style' ) ?? '';
		style.width = '100%';
		style.height = '100%';
		if ( ! near( image.getBoundingClientRect(), before ) ) {
			image.setAttribute( 'style', previous );
			return;
		}
		try {
			host.unobserveResize();
		} catch {
			image.setAttribute( 'style', previous );
			return;
		}
		applied++;
	} );
	return applied;
}

/** Normalize every declared Wix image on the page; returns how many were rewritten. */
export async function normalizeWixImageGeometry( page: Page ): Promise< number > {
	const infos = await page.evaluate( ( selector ) =>
		[ ...document.querySelectorAll( selector ) ].map( host => host.getAttribute( 'data-image-info' ) ), WIX_IMAGE_HOST );
	const declared = infos.map( info => ( { info, geometry: wixImageGeometry( info ) } ) );
	if ( ! declared.some( entry => entry.geometry ) ) return 0;
	return page.evaluate( applyWixImageGeometry, { selector: WIX_IMAGE_HOST, declared } );
}
