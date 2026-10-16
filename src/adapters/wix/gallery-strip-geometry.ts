// src/adapters/wix/gallery-strip-geometry.ts
//
// A Pro Gallery horizontal strip (`one-row … slider` around a
// `gallery-horizontal-scroll`) is sized by its runtime in pixels on every
// resize: `.pro-gallery-parent-container` is the host's width, and the gallery
// container and its scroll strip are the host plus a constant (10 px in the
// ketatov.com desktop document, 4 px in its mobile one). The runtime re-lays
// out too late for the width sweep to see, so the sweep learns the capture
// width's pixels as constants and the copy keeps that scrollport at every
// width. At serialize time the relationship is carried as host-relative CSS
// instead, when the page proves it at the capture width; the learned constants
// are released for exactly those widths.
//
import type { Page } from 'playwright';
import { FLUID_RELEASE_ATTRIBUTE } from '../../lib/screenshot/fluid-baseline.js';

/** One strip as read from the page, before anything is rewritten. */
export interface WixGalleryStripReading {
	/** Width of the element the parent container is laid out in. */
	hostWidth: number;
	parent: WixGalleryStripPart;
	container: WixGalleryStripPart;
	scroll: WixGalleryStripPart;
}

export interface WixGalleryStripPart {
	className: string;
	/** Inline `width` declaration as written by the runtime. */
	width: string;
	important: boolean;
	/** Content-box width of the element's parent: what `100%` resolves to. */
	base: number;
}

/** The inline widths a strip's runtime pixels stand for. */
export interface WixGalleryStripGeometry {
	parent: string;
	container: string;
	scroll: string;
}

const pixels = ( value: string ): number | null => /^\d+(?:\.\d+)?px$/.test( value ) ? parseFloat( value ) : null;
const classes = ( className: string ) => new Set( className.split( /\s+/ ).filter( Boolean ) );
const relative = ( width: number, base: number ) => {
	const delta = Math.round( ( width - base ) * 100 ) / 100;
	return delta === 0 ? '100%' : `calc(100% ${ delta < 0 ? '-' : '+' } ${ Math.abs( delta ) }px)`;
};

/**
 * The host-relative widths a horizontal strip's inline pixels stand for, or
 * null when the markup is not a strip or the pixels are not the host's width
 * (parent container) and the host plus one shared delta (container and scroll
 * strip). Each width is written against its own containing box, so the copy
 * reproduces the capture width exactly and follows the host at every other.
 *
 * Pure, so the markup and the relationship this depends on are testable
 * without a browser.
 */
export function wixGalleryStripGeometry( reading: WixGalleryStripReading ): WixGalleryStripGeometry | null {
	const { hostWidth, parent, container, scroll } = reading;
	if ( ! classes( parent.className ).has( 'pro-gallery-parent-container' ) ) return null;
	const containerClasses = classes( container.className );
	if ( ! containerClasses.has( 'one-row' ) || ! containerClasses.has( 'slider' ) ) return null;
	if ( ! classes( scroll.className ).has( 'gallery-horizontal-scroll' ) ) return null;
	if ( parent.important || container.important || scroll.important ) return null;
	const parentWidth = pixels( parent.width );
	const containerWidth = pixels( container.width );
	const scrollWidth = pixels( scroll.width );
	if ( parentWidth === null || containerWidth === null || scrollWidth === null || ! ( hostWidth > 0 ) ) return null;
	if ( Math.abs( parentWidth - hostWidth ) > 0.5 ) return null;
	const delta = containerWidth - hostWidth;
	if ( Math.abs( scrollWidth - hostWidth - delta ) > 0.5 ) return null;
	return {
		parent: relative( parentWidth, parent.base ),
		container: relative( containerWidth, container.base ),
		scroll: relative( scrollWidth, scroll.base ),
	};
}

const STRIP_PARENT = '.pro-gallery-parent-container';

/** In-page: read every strip's markup, inline widths and percentage bases. */
function readWixGalleryStrips( selector: string ): Array< WixGalleryStripReading | null > {
	const contentWidth = ( element: Element ) => {
		const style = getComputedStyle( element );
		return element.getBoundingClientRect().width -
			( parseFloat( style.paddingLeft ) || 0 ) - ( parseFloat( style.paddingRight ) || 0 ) -
			( parseFloat( style.borderLeftWidth ) || 0 ) - ( parseFloat( style.borderRightWidth ) || 0 );
	};
	const part = ( element: HTMLElement ) => ( {
		className: element.className,
		width: element.style.width,
		important: element.style.getPropertyPriority( 'width' ) !== '',
		base: element.parentElement ? contentWidth( element.parentElement ) : 0,
	} );
	return [ ...document.querySelectorAll< HTMLElement >( selector ) ].map( parent => {
		const host = parent.parentElement;
		const container = parent.querySelector< HTMLElement >( ':scope > [id^="pro-gallery-container-"]' );
		const scroll = container?.querySelector< HTMLElement >( ':scope > [id^="gallery-horizontal-scroll-"]' );
		if ( ! host || ! container || ! scroll ) return null;
		if ( container.id.slice( 'pro-gallery-container-'.length ) !== scroll.id.slice( 'gallery-horizontal-scroll-'.length ) ) return null;
		return { hostWidth: contentWidth( host ), parent: part( parent ), container: part( container ), scroll: part( scroll ) };
	} );
}

/**
 * In-page: rewrite each proven strip's widths, keeping a strip only when the
 * page still holds the pixels that were read, the parent container, gallery
 * container and scroll strip each render within 1 px of their runtime box, and
 * the rewrite survives the capture's learned-geometry authority (released for
 * these widths). Otherwise the strip is left exactly as the runtime wrote it.
 */
async function applyWixGalleryStripGeometry( { selector, release, strips }: { selector: string; release: string; strips: Array< { reading: WixGalleryStripReading | null; geometry: WixGalleryStripGeometry | null } > } ): Promise< number > {
	const near = ( a: DOMRect, b: DOMRect ) =>
		Math.abs( a.x - b.x ) <= 1 && Math.abs( a.y - b.y ) <= 1 && Math.abs( a.width - b.width ) <= 1 && Math.abs( a.height - b.height ) <= 1;
	const rewritten: Array< Array< [ HTMLElement, string, string ] > > = [];
	[ ...document.querySelectorAll< HTMLElement >( selector ) ].forEach( ( parent, index ) => {
		const { reading, geometry } = strips[ index ] ?? { reading: null, geometry: null };
		if ( ! reading || ! geometry ) return;
		const container = parent.querySelector< HTMLElement >( ':scope > [id^="pro-gallery-container-"]' );
		const scroll = container?.querySelector< HTMLElement >( ':scope > [id^="gallery-horizontal-scroll-"]' );
		if ( ! container || ! scroll ) return;
		const parts: Array< [ HTMLElement, string, string ] > = [
			[ parent, reading.parent.width, geometry.parent ],
			[ container, reading.container.width, geometry.container ],
			[ scroll, reading.scroll.width, geometry.scroll ],
		];
		if ( parts.some( ( [ element, width ] ) => element.style.width !== width ) ) return;
		const before = parts.map( ( [ element ] ) => element.getBoundingClientRect() );
		for ( const [ element, , width ] of parts ) {
			element.setAttribute( release, 'width' );
			element.style.width = width;
		}
		if ( parts.every( ( [ element ], at ) => near( element.getBoundingClientRect(), before[ at ]! ) ) ) {
			rewritten.push( parts );
			return;
		}
		for ( const [ element, width ] of parts ) {
			element.style.width = width;
			element.removeAttribute( release );
		}
	} );
	// Let the authority observe the rewrite (mutation observers run first).
	await Promise.resolve();
	let applied = 0;
	for ( const parts of rewritten ) {
		for ( const [ element ] of parts ) element.removeAttribute( release );
		if ( parts.every( ( [ element, , width ] ) => element.style.width === width ) ) applied++;
		else for ( const [ element, width ] of parts ) element.style.width = width;
	}
	return applied;
}

/** Carry every proven Pro Gallery horizontal strip as host-relative widths; returns how many were rewritten. */
export async function normalizeWixGalleryStrips( page: Page ): Promise< number > {
	const readings = await page.evaluate( readWixGalleryStrips, STRIP_PARENT );
	const strips = readings.map( reading => ( { reading, geometry: reading ? wixGalleryStripGeometry( reading ) : null } ) );
	if ( ! strips.some( strip => strip.geometry ) ) return 0;
	return page.evaluate( applyWixGalleryStripGeometry, { selector: STRIP_PARENT, release: FLUID_RELEASE_ATTRIBUTE, strips } );
}
