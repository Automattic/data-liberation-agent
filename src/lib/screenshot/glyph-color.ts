/**
 * Rendered glyph colour (#769).
 *
 * Blocks Engine colours single-colour icon glyphs (social-link icons drive
 * `core/social-links` `iconColorValue`) by decoding image bytes in PHP, so the
 * result depends on which formats the import host's GD can read. The browser
 * has already decoded and painted every icon, so capture records the rendered
 * colour instead: for small images, inline SVGs and background-image glyphs
 * inside links and buttons, the dominant opaque colour of the painted box,
 * sampled from rendered pixels. It is written as `data-blocks-engine-capture-glyph-color` on the
 * glyph element, so it travels with the captured HTML.
 *
 * Each distinct glyph — its serialized markup plus computed colour inputs — is
 * sampled once and its colour applied to every copy, and a run-scoped
 * `GlyphColorCache` carries known glyphs across routes, so an identical shared
 * footer serializes identically on every route whatever its position (#924).
 *
 * A glyph is sampled from a clip screenshot taken while only the glyphs are
 * visible: every other element is `visibility: hidden` and the page background
 * is transparent, so the clip holds the glyph's own pixels with their alpha.
 * Neither change affects layout, and both are removed before the page is
 * serialized. The monochrome test mirrors Blocks Engine's
 * `MonochromeGlyphColor` so both paths agree on the same glyph.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { withEvaluateTimeout } from './page-helpers.js';

export const GLYPH_COLOR_ATTRIBUTE = 'data-blocks-engine-capture-glyph-color';

/** Temporary capture-time markers; never serialized. */
const PROBE_ATTRIBUTE = 'data-blocks-engine-capture-glyph-probe';
const PROBE_STYLE_ATTRIBUTE = 'data-blocks-engine-capture-glyph-probe-style';
const CANDIDATE_ATTRIBUTE = 'data-blocks-engine-capture-glyph-probe-candidate';

export const GLYPH_COLOR_LIMITS = {
	/** Largest rendered box edge, in CSS px, that counts as an icon glyph. */
	maxEdge: 64,
	/** Smallest rendered box edge, in CSS px. */
	minEdge: 8,
	/** New distinct glyphs sampled per document, in document order. */
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
	/** Clip screenshots taken: one per new distinct glyph, bounded by `maxGlyphs` and `budgetMs`. */
	sampled: number;
	/** Glyphs that received `data-blocks-engine-capture-glyph-color`. */
	recorded: number;
}

/**
 * Deferred-glyph marker: a glyph whose key was not sampled within this
 * document's bounds, when a run cache may still learn it from another route.
 * `GlyphColorCache.resolveHtml` replaces it with the colour or removes it.
 */
export const GLYPH_PENDING_ATTRIBUTE = 'data-blocks-engine-capture-glyph-pending';
const PENDING_PATTERN = new RegExp( ` ${ GLYPH_PENDING_ATTRIBUTE }="([0-9a-f]+)"`, 'g' );

/**
 * Run-scoped glyph colour evidence (#924). A glyph's key is its serialized
 * markup plus its computed colour inputs, so identical glyphs on different
 * routes (a shared footer) receive the same colour whichever document sampled
 * it first, and a known key costs no screenshot. `''` records "not monochrome".
 */
export class GlyphColorCache {
	private readonly colors = new Map< string, string >();
	private readonly deferred = new Set< string >();

	static keyOf( glyph: string ): string {
		return createHash( 'sha256' ).update( glyph ).digest( 'hex' ).slice( 0, 32 );
	}

	get( key: string ): string | undefined {
		return this.colors.get( key );
	}

	set( key: string, color: string ): void {
		this.colors.set( key, color );
	}

	/** Replace deferred-glyph markers with the learned colour; unknown keys lose the marker. */
	resolveHtml( html: string ): string {
		return html.replace( PENDING_PATTERN, ( _, key: string ) => {
			const color = this.colors.get( key );
			return color ? ` ${ GLYPH_COLOR_ATTRIBUTE }="${ color }"` : '';
		} );
	}

	/** Remember a saved document that still carries deferred-glyph markers. */
	defer( path: string, html: string ): void {
		if ( html.includes( GLYPH_PENDING_ATTRIBUTE ) ) this.deferred.add( path );
	}

	/**
	 * The final pass: resolve every deferred document once the run's routes are
	 * captured, so a glyph learned on a later route reaches earlier ones too.
	 */
	resolveDeferred(): void {
		for ( const path of this.deferred ) {
			try {
				if ( ! existsSync( path ) ) continue;
				const html = readFileSync( path, 'utf8' );
				const resolved = this.resolveHtml( html );
				if ( resolved !== html ) writeFileSync( path, resolved );
			} catch {
				/* best-effort — a miss loses only that colour evidence */
			}
		}
		this.deferred.clear();
	}
}

interface GlyphCandidate { key: string; x: number; y: number; width: number; height: number }

/**
 * Mark the glyph candidates and return their keys and boxes. Runs in the page.
 * Candidates are, in document order: `<img>` (which also covers `<picture>`),
 * outermost inline `<svg>`, and empty elements whose own `background-image`
 * paints the glyph, each inside `a[href]`, `button` or `[role=button]`, visible,
 * and with a rendered box between `minEdge` and `maxEdge` CSS px on each side.
 * Each candidate carries `candidate="<index>"` until the restore.
 */
function markGlyphs( args: { maxEdge: number; minEdge: number; attribute: string; pending: string; candidate: string } ): GlyphCandidate[] {
	const { maxEdge, minEdge, attribute, pending, candidate } = args;
	// Only capture-recorded evidence may carry the attributes.
	for ( const node of document.querySelectorAll( `[${ attribute }],[${ pending }]` ) ) {
		node.removeAttribute( attribute );
		node.removeAttribute( pending );
	}
	const isGlyph = ( element: Element ): boolean => {
		const tag = element.localName;
		if ( tag === 'img' ) return true;
		if ( tag === 'svg' ) return ! element.parentElement?.closest( 'svg' );
		if ( element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ) return false;
		if ( ! /url\(/i.test( getComputedStyle( element ).backgroundImage ) ) return false;
		return ! ( element.textContent ?? '' ).trim() && ! element.querySelector( 'img,svg,picture,video,canvas,iframe' );
	};
	const glyphs: GlyphCandidate[] = [];
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
		// Serialized before the candidate marker is set, so the key never holds capture markup.
		const key = JSON.stringify( [ element.outerHTML, style.color, style.fill, style.stroke, style.backgroundImage ] );
		element.setAttribute( candidate, String( glyphs.length ) );
		glyphs.push( { key, x, y, width: rect.width, height: rect.height } );
	}
	return glyphs;
}

/** Isolate the glyphs to be sampled. Runs in the page. */
function isolateGlyphs( args: { indexes: number[]; candidate: string; probe: string; probeStyle: string } ): void {
	const { indexes, candidate, probe, probeStyle } = args;
	for ( const index of indexes ) document.querySelector( `[${ candidate }="${ index }"]` )?.setAttribute( probe, '' );
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

/** Record colours and deferred markers, and remove every probe marker. Runs in the page. */
function restoreGlyphs( args: { colors: Record< string, string >; deferred: Record< string, string >; attribute: string; pending: string; candidate: string; probe: string; probeStyle: string } ): number {
	const { colors, deferred, attribute, pending, candidate, probe, probeStyle } = args;
	for ( const style of document.querySelectorAll( `style[${ probeStyle }]` ) ) style.remove();
	for ( const element of document.querySelectorAll( `[${ probe }]` ) ) element.removeAttribute( probe );
	let recorded = 0;
	for ( const element of document.querySelectorAll( `[${ candidate }]` ) ) {
		const index = element.getAttribute( candidate ) ?? '';
		element.removeAttribute( candidate );
		if ( colors[ index ] ) {
			element.setAttribute( attribute, colors[ index ] );
			recorded++;
		} else if ( deferred[ index ] ) element.setAttribute( pending, deferred[ index ] );
	}
	return recorded;
}

/**
 * Sample the rendered colour of icon glyphs in the current document and record
 * monochrome ones as `data-blocks-engine-capture-glyph-color="#rrggbb"`. Each
 * distinct glyph (same markup and computed colour inputs) is sampled once and
 * its colour applied to every copy. New distinct glyphs are bounded by
 * `GLYPH_COLOR_LIMITS`; glyphs already known to `cache` cost no screenshot and
 * no bound. With a cache, glyphs left unsampled carry a deferred marker that
 * `GlyphColorCache.resolveHtml` settles after the run. The probe markers are
 * always removed, so a failure loses only the colour evidence.
 */
export async function recordGlyphColors(
	page: Page,
	limits: Partial< Record< keyof typeof GLYPH_COLOR_LIMITS, number > > = {},
	cache?: GlyphColorCache
): Promise< GlyphColorCapture > {
	const { maxEdge, minEdge, maxGlyphs, budgetMs, screenshotTimeoutMs, evaluateTimeoutMs } = { ...GLYPH_COLOR_LIMITS, ...limits };
	const deadline = Date.now() + budgetMs;
	const markers = { attribute: GLYPH_COLOR_ATTRIBUTE, pending: GLYPH_PENDING_ATTRIBUTE, candidate: CANDIDATE_ATTRIBUTE, probe: PROBE_ATTRIBUTE, probeStyle: PROBE_STYLE_ATTRIBUTE };
	const colors: Record< string, string > = {};
	const deferred: Record< string, string > = {};
	let sampled = 0;
	let candidates = 0;
	let recorded = 0;
	try {
		const glyphs = await withEvaluateTimeout( page.evaluate( markGlyphs, { maxEdge, minEdge, attribute: markers.attribute, pending: markers.pending, candidate: markers.candidate } ), evaluateTimeoutMs );
		candidates = glyphs.length;
		// Group copies by key, in document order of first appearance.
		const groups = new Map< string, { first: GlyphCandidate; index: number; members: number[] } >();
		glyphs.forEach( ( glyph, index ) => {
			const key = GlyphColorCache.keyOf( glyph.key );
			const group = groups.get( key );
			if ( group ) group.members.push( index );
			else groups.set( key, { first: glyph, index, members: [ index ] } );
		} );
		const learned = new Map< string, string >();
		const toSample: Array< [ string, { first: GlyphCandidate; index: number; members: number[] } ] > = [];
		for ( const [ key, group ] of groups ) {
			const known = cache?.get( key );
			if ( known !== undefined ) learned.set( key, known );
			else if ( toSample.length < maxGlyphs ) toSample.push( [ key, group ] );
		}
		if ( toSample.length ) {
			await withEvaluateTimeout( page.evaluate( isolateGlyphs, { indexes: toSample.map( ( [ , group ] ) => group.index ), candidate: markers.candidate, probe: markers.probe, probeStyle: markers.probeStyle } ), evaluateTimeoutMs );
			// Let the isolation style paint before the first clip.
			await withEvaluateTimeout( page.evaluate( () => new Promise< void >( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) ) ), evaluateTimeoutMs );
			for ( const [ key, { first: box } ] of toSample ) {
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
				learned.set( key, color );
				cache?.set( key, color );
			}
		}
		for ( const [ key, group ] of groups ) {
			const color = learned.get( key );
			for ( const index of group.members ) {
				if ( color ) colors[ String( index ) ] = color;
				else if ( color === undefined && cache ) deferred[ String( index ) ] = key;
			}
		}
	} finally {
		recorded = await withEvaluateTimeout( page.evaluate( restoreGlyphs, { colors, deferred, ...markers } ), evaluateTimeoutMs );
	}
	return { candidates, sampled, recorded };
}
