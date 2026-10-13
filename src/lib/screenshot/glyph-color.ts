/**
 * Rendered glyph colour (#769).
 *
 * Blocks Engine colours single-colour icon glyphs (social-link icons drive
 * `core/social-links` `iconColorValue`) by decoding image bytes in PHP, so the
 * result depends on which formats the import host's GD can read. The browser
 * has already decoded and painted every icon, so capture records the rendered
 * colour instead: for small images, inline SVGs and background-image glyphs
 * inside links and buttons, the dominant opaque colour of the painted box,
 * sampled from rendered pixels. It is written as `data-dla-glyph-color` on the
 * glyph element, so it travels with the captured HTML.
 *
 * Each glyph is sampled from a clip screenshot taken while only the glyphs are
 * visible: every other element is `visibility: hidden` and the page background
 * is transparent, so the clip holds the glyph's own pixels with their alpha.
 * Neither change affects layout, and both are removed before the page is
 * serialized. The monochrome test mirrors Blocks Engine's
 * `MonochromeGlyphColor` so both paths agree on the same glyph.
 */
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { withEvaluateTimeout } from './page-helpers.js';

export const GLYPH_COLOR_ATTRIBUTE = 'data-dla-glyph-color';

/** Temporary capture-time markers; never serialized. */
const PROBE_ATTRIBUTE = 'data-dla-glyph-probe';
const PROBE_STYLE_ATTRIBUTE = 'data-dla-glyph-probe-style';

export const GLYPH_COLOR_LIMITS = {
	/** Largest rendered box edge, in CSS px, that counts as an icon glyph. */
	maxEdge: 64,
	/** Smallest rendered box edge, in CSS px. */
	minEdge: 8,
	/** Glyphs sampled per document, in document order. */
	maxGlyphs: 24,
	/** Wall-clock bound for one document's sampling, including the restore. */
	budgetMs: 4_000,
	/** Bound for one clip screenshot. */
	screenshotTimeoutMs: 1_000,
	/** Bound for each in-page step (isolate, paint, restore). */
	evaluateTimeoutMs: 2_000,
} as const;

// Same constants as Blocks Engine `MonochromeGlyphColor`.
const MIN_OPAQUE = 8;
const CHANNEL_DELTA = 18;
const CLUSTER_SHARE = 0.85;
/** GD treats alpha 0..16 of 127 as opaque; the same share of the clip's peak alpha. */
const OPAQUE_SHARE = ( 127 - 16 ) / 127;
/** A clip whose most opaque pixel is fainter than this holds no glyph. */
const MIN_PEAK_ALPHA = 32;

/**
 * Dominant opaque colour of RGBA pixels as `#rrggbb`, or `''` when they are not
 * a single-colour glyph. Mirrors `MonochromeGlyphColor::inspect()`: the mode
 * colour must cover at least 85% of opaque pixels within a per-channel delta of
 * 18, and near-white and near-black snap to `#ffffff` and `#000000`.
 *
 * "Opaque" is relative to the clip's most opaque pixel, so anti-aliased edges
 * are excluded and a uniformly translucent glyph keeps its own colour.
 */
export function monochromeGlyphColor( rgba: Uint8Array, width: number, height: number ): string {
	const pixels = width * height;
	if ( pixels < 1 || rgba.length < pixels * 4 ) return '';
	let peak = 0;
	for ( let i = 3; i < pixels * 4; i += 4 ) if ( rgba[ i ] > peak ) peak = rgba[ i ];
	if ( peak < MIN_PEAK_ALPHA ) return '';
	const threshold = peak * OPAQUE_SHARE;
	const counts = new Map< number, number >();
	let opaque = 0;
	for ( let i = 0; i < pixels * 4; i += 4 ) {
		if ( rgba[ i + 3 ] < threshold ) continue;
		const key = ( rgba[ i ] << 16 ) | ( rgba[ i + 1 ] << 8 ) | rgba[ i + 2 ];
		counts.set( key, ( counts.get( key ) ?? 0 ) + 1 );
		opaque++;
	}
	if ( opaque < MIN_OPAQUE ) return '';
	let mode = 0;
	let modeCount = 0;
	for ( const [ key, count ] of counts ) if ( count > modeCount ) { mode = key; modeCount = count; }
	const red = ( mode >> 16 ) & 0xff, green = ( mode >> 8 ) & 0xff, blue = mode & 0xff;
	let cluster = 0;
	for ( const [ key, count ] of counts ) {
		const distance = Math.max(
			Math.abs( ( ( key >> 16 ) & 0xff ) - red ),
			Math.abs( ( ( key >> 8 ) & 0xff ) - green ),
			Math.abs( ( key & 0xff ) - blue )
		);
		if ( distance <= CHANNEL_DELTA ) cluster += count;
	}
	if ( cluster / opaque < CLUSTER_SHARE ) return '';
	if ( red >= 250 && green >= 250 && blue >= 250 ) return '#ffffff';
	if ( red <= 5 && green <= 5 && blue <= 5 ) return '#000000';
	return `#${ [ red, green, blue ].map( ( channel ) => channel.toString( 16 ).padStart( 2, '0' ) ).join( '' ) }`;
}

export interface GlyphColorCapture {
	/** Icon-like glyphs found inside links and buttons. */
	candidates: number;
	/** Glyphs sampled (bounded by `maxGlyphs` and `budgetMs`). */
	sampled: number;
	/** Glyphs that received `data-dla-glyph-color`. */
	recorded: number;
}

interface GlyphBox { index: number; x: number; y: number; width: number; height: number }

/**
 * Mark the glyph candidates and isolate them for sampling. Runs in the page.
 * Candidates are, in document order: `<img>` (which also covers `<picture>`),
 * outermost inline `<svg>`, and empty elements whose own `background-image`
 * paints the glyph, each inside `a[href]`, `button` or `[role=button]`, visible,
 * and with a rendered box between `minEdge` and `maxEdge` CSS px on each side.
 */
function isolateGlyphs( args: { maxEdge: number; minEdge: number; maxGlyphs: number; attribute: string; probe: string; probeStyle: string } ): { candidates: number; boxes: GlyphBox[] } {
	const { maxEdge, minEdge, maxGlyphs, attribute, probe, probeStyle } = args;
	// Only capture-recorded evidence may carry the attribute.
	for ( const node of document.querySelectorAll( `[${ attribute }]` ) ) node.removeAttribute( attribute );
	const isGlyph = ( element: Element ): boolean => {
		const tag = element.localName;
		if ( tag === 'img' ) return true;
		if ( tag === 'svg' ) return ! element.parentElement?.closest( 'svg' );
		if ( element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ) return false;
		if ( ! /url\(/i.test( getComputedStyle( element ).backgroundImage ) ) return false;
		return ! ( element.textContent ?? '' ).trim() && ! element.querySelector( 'img,svg,picture,video,canvas,iframe' );
	};
	const boxes: GlyphBox[] = [];
	let candidates = 0;
	for ( const element of document.body?.querySelectorAll( '*' ) ?? [] ) {
		if ( ! element.closest( 'a[href],button,[role="button"]' ) || ! isGlyph( element ) ) continue;
		const style = getComputedStyle( element );
		if ( style.visibility !== 'visible' || style.display === 'none' ) continue;
		let transparent = false;
		for ( let node: Element | null = element; node && ! transparent; node = node.parentElement ) transparent = Number( getComputedStyle( node ).opacity ) === 0;
		if ( transparent ) continue;
		const rect = element.getBoundingClientRect();
		if ( rect.width < minEdge || rect.height < minEdge || rect.width > maxEdge || rect.height > maxEdge ) continue;
		const x = rect.left + window.scrollX, y = rect.top + window.scrollY;
		if ( x + rect.width <= 0 || y + rect.height <= 0 ) continue;
		candidates++;
		if ( boxes.length >= maxGlyphs ) continue;
		element.setAttribute( probe, String( boxes.length ) );
		boxes.push( { index: boxes.length, x, y, width: rect.width, height: rect.height } );
	}
	if ( boxes.length ) {
		const style = document.createElement( 'style' );
		style.setAttribute( probeStyle, '' );
		// Hide everything but the glyphs (their descendants inherit), drop the
		// page background, and drop each glyph's own box decoration so only its
		// content paints. Opacity is a fade, not a colour, so the glyph and its
		// ancestors paint opaque; filters stay, since they recolour. None of
		// these properties affects layout.
		style.textContent =
			`html,body{background:transparent!important}` +
			`html *:not([${ probe }]):not([${ probe }] *){visibility:hidden!important}` +
			`:has([${ probe }]),[${ probe }]{opacity:1!important}` +
			`[${ probe }]{visibility:visible!important;background-color:transparent!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important}` +
			`img[${ probe }],svg[${ probe }]{background-image:none!important}`;
		document.head.appendChild( style );
	}
	return { candidates, boxes };
}

/** Record colours and remove every probe marker. Runs in the page. */
function restoreGlyphs( args: { colors: Record< string, string >; attribute: string; probe: string; probeStyle: string } ): void {
	const { colors, attribute, probe, probeStyle } = args;
	for ( const style of document.querySelectorAll( `style[${ probeStyle }]` ) ) style.remove();
	for ( const element of document.querySelectorAll( `[${ probe }]` ) ) {
		const color = colors[ element.getAttribute( probe ) ?? '' ];
		element.removeAttribute( probe );
		if ( color ) element.setAttribute( attribute, color );
	}
}

/**
 * Sample the rendered colour of icon glyphs in the current document and record
 * monochrome ones as `data-dla-glyph-color="#rrggbb"`. Bounded by
 * `GLYPH_COLOR_LIMITS`. The probe markers are always removed, so a failure
 * loses only the colour evidence.
 */
export async function recordGlyphColors( page: Page, limits: Partial< typeof GLYPH_COLOR_LIMITS > = {} ): Promise< GlyphColorCapture > {
	const { maxEdge, minEdge, maxGlyphs, budgetMs, screenshotTimeoutMs, evaluateTimeoutMs } = { ...GLYPH_COLOR_LIMITS, ...limits };
	const deadline = Date.now() + budgetMs;
	const markers = { attribute: GLYPH_COLOR_ATTRIBUTE, probe: PROBE_ATTRIBUTE, probeStyle: PROBE_STYLE_ATTRIBUTE };
	const colors: Record< string, string > = {};
	let sampled = 0;
	let candidates = 0;
	try {
		const isolated = await withEvaluateTimeout( page.evaluate( isolateGlyphs, { maxEdge, minEdge, maxGlyphs, ...markers } ), evaluateTimeoutMs );
		candidates = isolated.candidates;
		if ( ! isolated.boxes.length ) return { candidates, sampled: 0, recorded: 0 };
		// Let the isolation style paint before the first clip.
		await withEvaluateTimeout( page.evaluate( () => new Promise< void >( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) ) ), evaluateTimeoutMs );
		for ( const box of isolated.boxes ) {
			const timeout = Math.min( screenshotTimeoutMs, deadline - Date.now() );
			if ( timeout <= 0 ) break;
			const left = Math.floor( box.x ), top = Math.floor( box.y );
			const png = PNG.sync.read( await page.screenshot( {
				type: 'png',
				fullPage: true,
				omitBackground: true,
				timeout,
				clip: { x: left, y: top, width: Math.ceil( box.x + box.width ) - left, height: Math.ceil( box.y + box.height ) - top },
			} ) );
			sampled++;
			const color = monochromeGlyphColor( png.data, png.width, png.height );
			if ( color ) colors[ String( box.index ) ] = color;
		}
	} finally {
		await withEvaluateTimeout( page.evaluate( restoreGlyphs, { colors, ...markers } ), evaluateTimeoutMs );
	}
	return { candidates, sampled, recorded: Object.keys( colors ).length };
}
