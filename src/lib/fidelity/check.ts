// src/lib/fidelity/check.ts
//
// Compare a liberated copy against its live source at viewports the capture
// sweep never sampled. Measuring only at the capture width would certify the
// freeze we already shipped once.
//
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { sourceContextOptions } from '../browser-kit/browser-kit.js';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import { DEFAULT_SWEEP_WIDTHS } from '../screenshot/fluid-capture.js';
import {
	dismissOverlays,
	triggerLazyLoad,
	waitForStable,
	type DismissedOverlay,
	type OverlayTarget,
} from '../screenshot/page-helpers.js';
import { applySourceCleanup, readSourceCleanup, validateCleanupPolicy, type CleanupPolicy, type CleanupReport } from '../source-cleanup.js';
import { runFidelityChecks } from './checks.js';
import { probeDialogs } from './dialog-probe.js';
import { writePixelEvidence } from './evidence.js';
import { checkSelfConsistency, type SelfConsistencyReport } from './self-consistency.js';
import {
	scoreReport,
	scoreViewport,
	normalizeImageKey,
	type HashTarget,
	type LayoutObservation,
	type ViewportScore,
} from './score.js';

const MAX_ROUTE_CHECKS = 32;

/** Routes compared against the live source by default. Each costs a browser round trip. */
const BROWSER_ROUTE_SAMPLE = 4;

/**
 * Widths the learning sweep does not visit. 1600 and 1728 sit above the
 * capture width and are what exposed the freeze. 900 is omitted on purpose:
 * per-device sources switch documents by CSS at the detected floor, while a
 * desktop-UA load of the live source does not, so that width compares two
 * different designs.
 */
export const DEFAULT_CHECK_WIDTHS = [ 1600, 1728 ];

/**
 * Overlay kinds this comparison dismisses on both sides before measuring.
 *
 * Capture dismisses takeover modals and consent banners before it serializes a
 * page, so a copy never carries one. Measuring the live source with its banner
 * still up compares two different documents: a source whose consent strip is
 * 355 characters fails every route by exactly 355, and the copy is faultless.
 * The same primitive therefore runs on both sides here.
 *
 * `provider-promotion` is deliberately not in this list. The cleanup policy
 * already removes hosting-platform chrome on both sides, and what a candidate
 * still retains is counted by running that policy over it — dismissing the
 * same chrome first would eat the evidence that check exists to report.
 */
const COMPARED_OVERLAY_KINDS: ReadonlyArray< OverlayTarget[ 'kind' ] > = [ 'takeover', 'consent' ];

/** What one side dismissed before it was measured, for the compare evidence. */
export interface OverlayRecord {
	route: string;
	viewport: number;
	side: 'source' | 'copy';
	url: string;
	dismissed: DismissedOverlay[];
}

/** `kind selector`, once each, in the order they were dismissed. */
function overlayLabels( dismissed: DismissedOverlay[] ): string[] {
	return [ ...new Set( dismissed.map( ( overlay ) => `${ overlay.kind } ${ overlay.selector }` ) ) ];
}

export type ObservePair = (
	sourceUrl: string,
	localUrl: string,
	viewport: number
) => Promise< {
	source: LayoutObservation;
	liberated: LayoutObservation;
	sourcePng?: Buffer;
	liberatedPng?: Buffer;
	/** Source-cleanup matches found on a `candidateUrl` copy, reported rather than rejected. */
	candidateRetained?: number;
} >;

export interface FidelityCheckOptions {
	directory: string;
	widths?: number[];
	/** Pathnames to check, e.g. `/` and `/about/`. Default: homepage only. */
	routes?: string[];
	settleMs?: number;
	/** How many routes to compare against the live source. */
	sampleSize?: number;
	/** Write source/liberated/diff PNGs. Never used as pass/fail. */
	screenshots?: boolean;
	log?: ( ( message: string ) => void ) | undefined;
	observe?: ObservePair;
	/**
	 * Base URL of another rendered copy of the captured site, for example a
	 * WordPress site built from the capture. When set, each sampled route is
	 * compared against `candidateUrl + route` instead of the capture served
	 * locally. Routes still come from the capture receipt, and the offline
	 * self-consistency checks still describe the capture. Source attribution a
	 * candidate retains becomes a failed check instead of rejecting the run,
	 * since the candidate is not this tool's artifact.
	 */
	candidateUrl?: string;
}

function candidateBase( candidateUrl: string ): string {
	let url: URL;
	try {
		url = new URL( candidateUrl );
	} catch {
		throw new Error( `candidateUrl is not a URL: ${ candidateUrl }` );
	}
	if ( ! [ 'http:', 'https:' ].includes( url.protocol ) || url.username || url.password || url.search || url.hash ) {
		throw new Error( `candidateUrl must be an http(s) base URL without credentials, query or fragment: ${ candidateUrl }` );
	}
	return url.href.replace( /\/+$/, '' );
}

/** A score, told which route produced it. */
export type RouteScore = ViewportScore & { route: string };

export interface FidelityReport {
	cleanup?: { policy: CleanupPolicy; source: CleanupReport[] };
	/** Overlays dismissed per side before measuring. Evidence, never a gate. */
	overlays: OverlayRecord[];
	sourceUrl: string;
	websiteDir: string;
	widths: number[];
	/** Routes actually measured. */
	routes: string[];
	/** Routes the capture retained. */
	routesAvailable: number;
	/**
	 * Captured routes left out of source comparison because their capture-time
	 * cleanup is not proven (no evidence, a failure, or residual content), so a
	 * difference there could be leftover provider chrome rather than a copy defect.
	 */
	routesCleanupUnproven: string[];
	/** Offline checks over every route. */
	selfConsistency: SelfConsistencyReport;
	scores: RouteScore[];
	pass: boolean;
	failed: number;
	passed: number;
}

interface CaptureReceipt {
	cleanup?: { policy: CleanupPolicy; complete: boolean; evidencePath?: string };
	source?: { url?: string };
	websiteRoot?: string;
	routes?: Array< { url?: string; path?: string } >;
}

/**
 * One spelling for a route in the copy, so `/about`, `/about/`, and
 * `/about/index.html` are the same place. Extensions other than a directory
 * index are left alone, because `/feed.xml` is a file rather than a directory.
 */
/** Route in the copy → its file, relative to the website directory. */
export function routeFiles( receipt: CaptureReceipt ): Map< string, string > {
	const websiteRoot = ( receipt.websiteRoot ?? 'website' ).replace( /\\/g, '/' ).replace( /\/*$/, '' );
	const files = new Map< string, string >();
	for ( const route of receipt.routes ?? [] ) {
		if ( ! route?.url || ! route?.path ) continue;
		const path = route.path.replace( /\\/g, '/' );
		const relative =
			websiteRoot && path.startsWith( `${ websiteRoot }/` )
				? path.slice( websiteRoot.length + 1 )
				: path;
		files.set( canonicalRoutePath( `/${ relative.replace( /^\/*/, '' ) }` ), relative );
	}
	return files;
}

/**
 * Pick `limit` routes spread evenly across the list, entrypoint first.
 *
 * Even spacing is the point. Taking the first N of an alphabetical list on a
 * site with sixty posts and a shop page spends every check inside /blog/ and
 * never reaches /shop/.
 */
export function spreadSample( routes: string[], limit: number ): string[] {
	if ( limit <= 0 ) return [];
	if ( routes.length <= limit ) return [ ...routes ];
	const [ first, ...rest ] = routes as [ string, ...string[] ];
	const picks = [ first ];
	const take = limit - 1;
	// Span both ends of the remainder. Stopping short leaves whatever sorts last
	// — often the very sections a blog was burying — permanently unmeasured.
	for ( let index = 0; index < take; index++ ) {
		const position = take === 1 ? rest.length - 1 : Math.round( ( index * ( rest.length - 1 ) ) / ( take - 1 ) );
		const candidate = rest[ position ];
		if ( candidate && ! picks.includes( candidate ) ) picks.push( candidate );
	}
	return picks;
}

/** Filesystem-safe stem for a route, so per-route evidence cannot collide. */
export function evidenceSlug( route: string ): string {
	const slug = route.replace( /[^a-z0-9]+/gi, '-' ).replace( /^-|-$/g, '' );
	return slug || 'index';
}

export function canonicalRoutePath( route: string ): string {
	const path = route.replace( /\\/g, '/' ).replace( /^\/*/, '/' ).split( /[?#]/ )[ 0 ] ?? '/';
	if ( path === '/index.html' ) return '/';
	if ( path.endsWith( '/index.html' ) ) return path.slice( 0, -'index.html'.length );
	if ( /\.[a-z0-9]+$/i.test( path ) ) return path;
	return path.endsWith( '/' ) ? path : `${ path }/`;
}

/**
 * Route in the copy → the source URL it was captured from.
 *
 * Only the receipt knows this mapping. A source captured at a subpath serves
 * its entrypoint as the copy's `/`, so resolving a route against the source
 * origin asks the live site for a page that was never captured — and a live
 * site is entitled to answer that with a 404 the comparison then treats as
 * the source of truth.
 */
export function routeSourceMap( receipt: CaptureReceipt ): Map< string, string > {
	const websiteRoot = ( receipt.websiteRoot ?? 'website' ).replace( /\\/g, '/' ).replace( /\/*$/, '' );
	const map = new Map< string, string >();
	for ( const route of receipt.routes ?? [] ) {
		if ( ! route?.url || ! route?.path ) continue;
		const path = route.path.replace( /\\/g, '/' );
		const relative =
			websiteRoot && path.startsWith( `${ websiteRoot }/` )
				? path.slice( websiteRoot.length + 1 )
				: path;
		map.set( canonicalRoutePath( `/${ relative.replace( /^\/*/, '' ) }` ), route.url );
	}
	return map;
}

export function resolveCheckDirectory( directory: string ): {
	websiteDir: string;
	receiptPath: string;
} {
	const absolute = resolve( directory );
	if ( ! existsSync( absolute ) || ! statSync( absolute ).isDirectory() ) {
		throw new Error( `Not a directory: ${ absolute }` );
	}
	const nestedReceipt = join( absolute, 'capture-receipt.json' );
	const nestedWebsite = join( absolute, 'website' );
	if ( existsSync( nestedReceipt ) && existsSync( nestedWebsite ) ) {
		return { websiteDir: nestedWebsite, receiptPath: nestedReceipt };
	}
	const parentReceipt = join( absolute, '..', 'capture-receipt.json' );
	if ( existsSync( parentReceipt ) ) {
		return { websiteDir: absolute, receiptPath: parentReceipt };
	}
	throw new Error(
		`No capture-receipt.json next to ${ absolute }. Point check at a liberated run directory.`
	);
}

export function checkWidthsFor( sampled: number[] = DEFAULT_SWEEP_WIDTHS ): number[] {
	return DEFAULT_CHECK_WIDTHS.filter( ( width ) => ! sampled.includes( width ) );
}

/** Return a real network host requested by a local copy, or null for browser-local schemes. */
export function externalRequestHost( href: string, localOrigin: string | null ): string | null {
	if ( ! localOrigin || href.startsWith( 'data:' ) || href.startsWith( 'blob:' ) ) return null;
	try {
		const url = new URL( href );
		if ( url.origin === localOrigin || ! [ 'http:', 'https:', 'ws:', 'wss:' ].includes( url.protocol ) ) return null;
		return url.host || null;
	} catch {
		return null;
	}
}

async function observePage(
	page: Page,
	url: string,
	viewport: number,
	settleMs: number,
	localOrigin: string | null,
	cleanup?: CleanupPolicy
): Promise< LayoutObservation > {
	const external = new Set< string >();
	const onRequest = ( request: { url: () => string } ): void => {
		const host = externalRequestHost( request.url(), localOrigin );
		if ( host ) external.add( host );
	};
	page.on( 'request', onRequest );
	try {
		await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 60_000 } ).catch( () => {} );
		await waitForStable( page, settleMs );
		if (cleanup) {
			const report = await applySourceCleanup(page, cleanup);
			if (localOrigin && report.removed) throw new Error('Liberated artifact retains advertising or source attribution');
		}
		// Dismiss takeover modals and consent banners exactly as capture does
		// (screenshotter.ts), with the same primitive and in the same order:
		// before lazy-load, because a modal's scroll-lock defeats the
		// scroll-through, and again after, because scrolling is what triggers
		// exit-intent popups. Both sides of the comparison run this, so what
		// disappears is only what capture had already decided is not page
		// content — a section the copy actually lost is neither fixed nor
		// sticky, is never a dismissal target, and still fails.
		const dismissedOverlays = await dismissOverlays( page, { kinds: COMPARED_OVERLAY_KINDS } );
		// Decode lazy media and return from a controlled scroll before measuring.
		// Scroll-linked animations are otherwise observed mid-flight, while the
		// source runtime may still be holding the same element at rest.
		await triggerLazyLoad( page );
		dismissedOverlays.push( ...( await dismissOverlays( page, { kinds: COMPARED_OVERLAY_KINDS } ) ) );
		const measured = await page.evaluate( async ( clickUnresolved: boolean ) => {
			// Perceptual identity for one image: fetch the bytes (cache-warm —
			// the page just rendered them), decode locally, downscale to 8x8
			// grayscale, threshold at the mean. Fetching keeps this
			// cross-origin safe where canvas reads of the element would taint;
			// any failure leaves null and the key-only matcher covers it.
			const hashCache = new Map< string, Promise< string | null > >();
			const contentHashFor = ( src: string ): Promise< string | null > => {
				const cached = hashCache.get( src );
				if ( cached ) return cached;
				const pending = ( async () => {
					try {
						if ( ! src || src.startsWith( 'data:' ) || src.startsWith( 'blob:' ) ) return null;
						const response = await fetch( src, { mode: 'cors', credentials: 'omit' } );
						if ( ! response.ok ) return null;
						const bitmap = await createImageBitmap( await response.blob() );
						const side = 8;
						const canvas = new OffscreenCanvas( side, side );
						const context = canvas.getContext( '2d', { willReadFrequently: true } )!;
						context.drawImage( bitmap, 0, 0, side, side );
						bitmap.close();
						const { data } = context.getImageData( 0, 0, side, side );
						const grays: number[] = [];
						for ( let offset = 0; offset < data.length; offset += 4 ) {
							grays.push( 0.299 * data[ offset ] + 0.587 * data[ offset + 1 ] + 0.114 * data[ offset + 2 ] );
						}
						const mean = grays.reduce( ( sum, value ) => sum + value, 0 ) / grays.length;
						let value = '';
						for ( let nibble = 0; nibble < grays.length; nibble += 4 ) {
							let bits = 0;
							for ( let bit = 0; bit < 4; bit++ ) {
								bits = ( bits << 1 ) | ( grays[ nibble + bit ] >= mean ? 1 : 0 );
							}
							value += bits.toString( 16 );
						}
						return value;
					} catch {
						return null;
					}
				} )();
				hashCache.set( src, pending );
				return pending;
			};

			// Images that occupy real layout space at this viewport: wider and
			// taller than 50px (the same floor as widestImage) and not
			// visibility:hidden, so tracking pixels and hidden decorations add
			// no noise. opacity:0 is deliberately kept — a carousel's parked
			// slides are transparent yet still hold the slideshow's layout
			// box, and a copy that drops them all is exactly the regression
			// the image-count gate exists to catch.
			// Candidates the element itself declared, not the one file the viewport
			// happened to load. A density list does not switch on width, so a
			// wider observation can load a different rendition of the same asset.
			const srcsetUrls = ( value: string | null ): string[] => {
				if ( ! value ) return [];
				const urls: string[] = [];
				let offset = 0;
				while ( offset < value.length ) {
					while ( offset < value.length && /[\s,]/.test( value[ offset ] ) ) offset++;
					if ( offset >= value.length ) break;
					const start = offset;
					while ( offset < value.length && ! /\s/.test( value[ offset ] ) ) offset++;
					const url = value.slice( start, offset ).replace( /,+$/, '' );
					if ( url ) urls.push( url );
					while ( offset < value.length && value[ offset ] !== ',' ) offset++;
					if ( offset < value.length ) offset++;
				}
				return urls;
			};
			const renditionUrls = ( image: HTMLImageElement ): string[] => {
				const urls = [
					...srcsetUrls( image.getAttribute( 'srcset' ) ),
					...srcsetUrls( image.getAttribute( 'data-srcset' ) ),
				];
				const picture = image.closest( 'picture' );
				if ( picture ) {
					for ( const source of picture.querySelectorAll( 'source' ) ) {
						urls.push( ...srcsetUrls( source.getAttribute( 'srcset' ) ) );
						urls.push( ...srcsetUrls( source.getAttribute( 'data-srcset' ) ) );
					}
				}
				return urls;
			};
			const images = await Promise.all(
				[ ...document.querySelectorAll< HTMLImageElement >( 'img' ) ]
					.map( ( image ) => ( {
						rect: image.getBoundingClientRect(),
						src: image.currentSrc || image.getAttribute( 'src' ) || '',
						renditions: renditionUrls( image ),
						hidden: getComputedStyle( image ).visibility === 'hidden',
					} ) )
					.filter( ( { rect, hidden } ) => ! hidden && rect.width > 50 && rect.height > 50 )
					.map( async ( { rect, src, renditions } ) => ( {
						key: src,
						renditions,
						x: Math.round( rect.x ),
						y: Math.round( rect.y ),
						width: Math.round( rect.width ),
						height: Math.round( rect.height ),
						contentHash: await contentHashFor( src ),
					} ) )
			);

			const typography: Array< {
				key: string;
				fontFamily: string;
				fontWeight: string;
				fontSize: number;
				lineHeight: number;
				letterSpacing: number;
				advance: number;
				loaded: boolean;
			} > = [];
			const canvas = document.createElement( 'canvas' );
			const context = canvas.getContext( '2d' );
			const walker = document.createTreeWalker( document.body, NodeFilter.SHOW_TEXT );
			const measuredParents = new Set< Element >();
			let textNode: Node | null;
			while ( typography.length < 120 && ( textNode = walker.nextNode() ) ) {
				const parent = textNode.parentElement;
				if (
					parent &&
					parent.childNodes.length > 1 &&
					[ ...parent.childNodes ].every( ( node ) => node.nodeType === Node.TEXT_NODE )
				) {
					if ( measuredParents.has( parent ) ) continue;
					measuredParents.add( parent );
				}
				const text = ( parent && measuredParents.has( parent ) ? parent.textContent : textNode.textContent ?? '' )
					.replace( /\s+/g, ' ' )
					.trim();
				if ( ! parent || ! text || parent.closest( 'script,style,noscript,template' ) ) continue;
				const range = document.createRange();
				range.selectNodeContents( parent && measuredParents.has( parent ) ? parent : textNode );
				const rect = range.getBoundingClientRect();
				const style = getComputedStyle( parent );
				if (
					rect.width <= 0 ||
					rect.height <= 0 ||
					style.display === 'none' ||
					style.visibility === 'hidden'
				) {
					continue;
				}
				const fontSize = Number.parseFloat( style.fontSize ) || 0;
				const font = `${ style.fontStyle } ${ style.fontWeight } ${ style.fontSize } ${ style.fontFamily }`;
				if ( context ) context.font = font;
				typography.push( {
					key: text.slice( 0, 120 ),
					fontFamily: style.fontFamily,
					fontWeight: style.fontWeight,
					fontSize,
					lineHeight: Number.parseFloat( style.lineHeight ) || fontSize * 1.2,
					letterSpacing: Number.parseFloat( style.letterSpacing ) || 0,
					advance: Math.round( ( context?.measureText( text ).width ?? rect.width ) * 100 ) / 100,
					loaded: document.fonts.check( font, text ),
				} );
			}

			const occurrencesBefore = new Map< string, number >();
			const animationsBefore = document
				.getAnimations()
				.filter( ( animation ) => animation.effect?.getComputedTiming().iterations !== Infinity )
				.map( ( animation ) => {
					const name = ( animation as Animation & { animationName?: string } ).animationName;
					if ( ! name || name === 'none' ) return null;
					const occurrence = occurrencesBefore.get( name ) ?? 0;
					occurrencesBefore.set( name, occurrence + 1 );
					return {
						key: `${ name }:${ occurrence }`,
						name,
						time: animation.currentTime?.toString() ?? 'null',
						state: animation.playState,
					};
				} )
				.filter( ( animation ): animation is NonNullable< typeof animation > => animation !== null );
			const animationStateBefore = new Map(
				animationsBefore.map( ( animation ) => [ animation.key, animation ] )
			);
			const originalScroll = { x: scrollX, y: scrollY };
			const root = document.documentElement;
			const scrollBehavior = root.style.scrollBehavior;
			root.style.scrollBehavior = 'auto';
			window.scrollTo( 0, Math.min( document.documentElement.scrollHeight - innerHeight, innerHeight * 1.5 ) );
			await new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) );
			await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
			const occurrencesAfter = new Map< string, number >();
			const animationsAfter = document
				.getAnimations()
				.filter( ( animation ) => animation.effect?.getComputedTiming().iterations !== Infinity )
				.map( ( animation ) => {
					const name = ( animation as Animation & { animationName?: string } ).animationName;
					if ( ! name || name === 'none' ) return null;
					const occurrence = occurrencesAfter.get( name ) ?? 0;
					occurrencesAfter.set( name, occurrence + 1 );
					return {
						key: `${ name }:${ occurrence }`,
						name,
						time: animation.currentTime?.toString() ?? 'null',
						state: animation.playState,
					};
				} )
				.filter( ( animation ): animation is NonNullable< typeof animation > => animation !== null );
			const responsiveAnimations = animationsAfter
				.filter( ( animation ) => {
					const before = animationStateBefore.get( animation.key );
					return ! before || before.time !== animation.time || before.state !== animation.state;
				} )
				.map( ( animation ) => animation.name )
				.sort();
			window.scrollTo( originalScroll.x, originalScroll.y );
			root.style.scrollBehavior = scrollBehavior;
			const animations = animationsBefore.map( ( animation ) => animation.name ).sort();
			const hashTargets: { fragment: string; resolved: boolean; targets: number }[] = [];
			const internalPaths: string[] = [];
			const seen = new Set< string >();
			// `/`, `/index.html` and a trailing slash all name the same document:
			// a copy served at `/` writes its own anchors as `/index.html#id`.
			const documentPath = ( pathname: string ) =>
				pathname.replace( /\/index\.html?$/i, '/' ).replace( /\/+$/, '' ) || '/';
			const samePage = ( target: URL ) =>
				documentPath( target.pathname ) === documentPath( location.pathname ) && target.search === location.search;
			for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ) {
				const href = link.getAttribute( 'href' ) ?? '';
				if ( ! href || href === '#' ) continue;
				let target: URL;
				try {
					target = new URL( href, location.href );
				} catch {
					continue;
				}
				if ( target.origin !== location.origin ) continue;
				// Only a fragment on this document is an in-page anchor. A fragment on
				// another page is a link to that page: following it on a client-routed
				// source navigates away, and the measurements below would describe the
				// wrong page.
				if ( target.hash && samePage( target ) ) {
					let fragment: string;
					try {
						fragment = decodeURIComponent( target.hash.slice( 1 ) );
					} catch {
						continue;
					}
					if ( ! fragment || seen.has( `#${ fragment }` ) ) continue;
					seen.add( `#${ fragment }` );
					const targets = [ ...document.querySelectorAll( '[id],a[name]' ) ].filter(
						( element ) =>
							element.id === fragment || element.getAttribute( 'name' ) === fragment
					).length;
					hashTargets.push( { fragment, resolved: targets > 0, targets } );
				}
				if (
					target.pathname &&
					target.pathname !== location.pathname &&
					! seen.has( target.pathname )
				) {
					seen.add( target.pathname );
					internalPaths.push( target.pathname );
				}
			}

			// Read what describes this page before any probe click can change it.
			const title = document.title;
			const textChars = ( document.body?.innerText ?? '' ).replace( /\s+/g, ' ' ).trim().length;
			if ( clickUnresolved ) {
				const original = { x: scrollX, y: scrollY };
				let clicks = 0;
				for ( const target of hashTargets ) {
					if ( target.resolved || clicks >= 8 ) continue;
					const trigger = [ ...document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ].find(
						( link ) => {
							try {
								return (
									decodeURIComponent( new URL( link.href, location.href ).hash.slice( 1 ) ) ===
									target.fragment
								);
							} catch {
								return false;
							}
						}
					);
					if ( ! trigger || trigger.getClientRects().length === 0 ) continue;
					clicks++;
					trigger.click();
					let previous = scrollY;
					let stable = 0;
					for ( let attempt = 0; attempt < 40 && stable < 4; attempt++ ) {
						await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
						if ( Math.abs( scrollY - previous ) < 1 ) stable++;
						else stable = 0;
						previous = scrollY;
					}
					if ( Math.abs( scrollY - original.y ) > 4 ) target.resolved = true;
					const root = document.documentElement;
					const behavior = root.style.scrollBehavior;
					root.style.scrollBehavior = 'auto';
					window.scrollTo( original.x, original.y );
					root.style.scrollBehavior = behavior;
				}
			}

			return {
				title,
				textChars,
				widestImage: images.length
					? Math.max( ...images.map( ( image ) => image.width ) )
					: null,
				images,
				typography,
				animations,
				responsiveAnimations,
				docWidth: document.documentElement.scrollWidth,
				overflow: document.documentElement.scrollWidth > window.innerWidth,
				hashTargets,
				internalPaths,
			};
		}, ! localOrigin );

		const internalMissing: string[] = [];
		if ( localOrigin ) {
			for ( const path of measured.internalPaths.slice( 0, MAX_ROUTE_CHECKS ) ) {
				const response = await page.request.get( `${ localOrigin }${ path }`, { timeout: 10_000 } );
				if ( ! response.ok() ) internalMissing.push( path );
			}
		}

		const dialogs = await probeDialogs( page );

		return {
			viewport,
			title: measured.title,
			textChars: measured.textChars,
			widestImage: measured.widestImage,
			images: measured.images.map( ( image ) => {
				const key = normalizeImageKey( image.key );
				const renditions: string[] = [];
				for ( const url of image.renditions ?? [] ) {
					const rendition = normalizeImageKey( url );
					if (
						! rendition ||
						rendition === key ||
						renditions.includes( rendition ) ||
						rendition.startsWith( 'data:' ) ||
						rendition.startsWith( 'blob:' )
					) {
						continue;
					}
					renditions.push( rendition );
				}
				return { ...image, key, renditions };
			} ),
			typography: measured.typography,
			animations: measured.animations,
			responsiveAnimations: measured.responsiveAnimations,
			docWidth: measured.docWidth,
			overflow: measured.overflow,
			externalHosts: [ ...external ].sort(),
			hashTargets: measured.hashTargets as HashTarget[],
			internalMissing,
			dialogs,
			dismissedOverlays,
		};
	} finally {
		page.off( 'request', onRequest );
	}
}

/**
 * Routes whose capture-time cleanup is not proven by the per-page evidence the
 * capture recorded. The receipt's `complete` flag is their conjunction, so the
 * routes behind a `false` are found by reading the evidence itself. Evidence
 * that cannot be read proves nothing, so every route counts as unproven.
 */
function cleanupUnprovenRoutes( receipt: CaptureReceipt, captureDir: string, sources: Map< string, string > ): Set< string > {
	const all = new Set( sources.keys() );
	const cleanup = receipt.cleanup;
	if ( ! cleanup ) return new Set();
	let pages: Array< { url?: string; policy?: unknown; reports?: Array< { failures?: unknown[]; residual?: number } > } >;
	try {
		pages = JSON.parse( readFileSync( join( captureDir, cleanup.evidencePath ?? 'cleanup-evidence.json' ), 'utf8' ) ).pages;
		if ( ! Array.isArray( pages ) ) return all;
	} catch {
		return all;
	}
	const policy = JSON.stringify( cleanup.policy );
	const proven = new Set(
		pages
			.filter( ( page ) => JSON.stringify( page.policy ) === policy && page.reports?.length &&
				page.reports.every( ( report ) => ( report.failures?.length ?? 0 ) === 0 && ( report.residual ?? 0 ) === 0 ) )
			.map( ( page ) => normalizedUrl( page.url ?? '' ) )
	);
	return new Set( [ ...sources ].filter( ( [ , url ] ) => ! proven.has( normalizedUrl( url ) ) ).map( ( [ route ] ) => route ) );
}

function normalizedUrl( value: string ): string {
	try {
		const url = new URL( value );
		return `${ url.origin }${ url.pathname.replace( /\/+$/, '' ) || '/' }${ url.search }`;
	} catch {
		return value;
	}
}

export async function checkFidelity( options: FidelityCheckOptions ): Promise< FidelityReport > {
	const log = options.log ?? ( () => {} );
	const { websiteDir, receiptPath } = resolveCheckDirectory( options.directory );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as CaptureReceipt;
	if (receipt.cleanup) validateCleanupPolicy(receipt.cleanup.policy);
	const cleanupReports: CleanupReport[] = [];
	const sourceUrl = receipt.source?.url;
	if ( ! sourceUrl ) throw new Error( `capture-receipt.json has no source.url: ${ receiptPath }` );

	const widths = options.widths ?? checkWidthsFor();
	const settleMs = options.settleMs ?? 4000;

	const sources = routeSourceMap( receipt );
	if ( ! sources.has( '/' ) ) sources.set( '/', sourceUrl );

	// One route whose cleanup could not be proven must not block comparing the
	// rest: set it aside, compare every route whose cleanup is proven, and
	// report the difference. Only a capture with no proven route is refused.
	const unproven = receipt.cleanup && ! receipt.cleanup.complete
		? cleanupUnprovenRoutes( receipt, dirname( receiptPath ), sources )
		: new Set< string >();
	for ( const route of unproven ) sources.delete( route );
	if ( receipt.cleanup && ! receipt.cleanup.complete && sources.size === 0 ) {
		throw new Error( 'Capture cleanup was incomplete for every route; recapture before comparison' );
	}
	if ( unproven.size > 0 ) {
		log( `[compare] cleanup unproven for ${ unproven.size } route(s), excluded from source comparison: ${ [ ...unproven ].sort().join( ', ' ) }` );
	}

	const captured = [ ...sources.keys() ].sort( ( left, right ) =>
		left === '/' ? -1 : right === '/' ? 1 : left.localeCompare( right )
	);
	const requested = options.routes?.map( canonicalRoutePath );
	for ( const route of requested ?? [] ) {
		if ( sources.has( route ) ) continue;
		throw new Error(
			`Route ${ route } was not captured. Captured routes: ${ captured.join( ', ' ) }`
		);
	}

	// Tier one: every route, offline. Anchors, internal links and stray remote
	// assets are pure functions of what is on disk, so there is no reason to
	// sample them.
	const selfConsistency = checkSelfConsistency( websiteDir, routeFiles( receipt ) );
	log(
		`[compare] self-consistency: ${ selfConsistency.routes } route(s), ${ selfConsistency.findings.length } finding(s)`
	);

	// Tier two: the live source, which costs a browser round trip per check, so
	// it runs on a bounded sample. The entrypoint always leads; the rest are
	// spread across the route list rather than taken in order, since ordered
	// selection on a blog spends the whole budget inside /blog/.
	const routes = requested ?? spreadSample( captured, options.sampleSize ?? BROWSER_ROUTE_SAMPLE );
	if ( ! requested && routes.length < captured.length ) {
		log( `[compare] source fidelity: sampling ${ routes.length } of ${ captured.length } route(s)` );
	}

	const candidate = options.candidateUrl === undefined ? null : candidateBase( options.candidateUrl );
	let observe = options.observe;
	const browser = observe ? null : await (await import('playwright')).chromium.launch();
	let server: Awaited<ReturnType<typeof startStaticServer>> | null = null;
	let page: Page | null = null;
	try {
		server = observe || candidate ? null : await startStaticServer( websiteDir );
		page = browser ? await browser.newPage( await sourceContextOptions( browser, sourceUrl ) ) : null;
	} catch (error) {
		await browser?.close();
		await server?.close();
		throw error;
	}
	if ( ! observe ) {
		observe = async ( sourceHref, localHref, viewport ) => {
			if ( ! page ) throw new Error( 'browser page missing' );
			await page.setViewportSize( { width: viewport, height: 900 } );
			const source = await observePage( page, sourceHref, viewport, settleMs, null, receipt.cleanup?.policy );
			if (receipt.cleanup) {
				const report = await readSourceCleanup(page);
				cleanupReports.push(report);
				if (report.failures.length || report.residual) throw new Error('Comparison source cleanup incomplete');
			}
			const sourcePng = options.screenshots ? await page.screenshot() : undefined;
			if ( candidate ) {
				// Measure the candidate as a visitor sees it, then ask the cleanup
				// policy what it would still remove. Removing it first would hide
				// exactly what is being measured.
				const liberated = await observePage( page, localHref, viewport, settleMs, new URL( localHref ).origin );
				const liberatedPng = options.screenshots ? await page.screenshot() : undefined;
				const candidateRetained = receipt.cleanup
					? ( await applySourceCleanup( page, receipt.cleanup.policy ) ).removed
					: 0;
				return { source, liberated, sourcePng, liberatedPng, candidateRetained };
			}
			const liberated = await observePage(
				page,
				localHref,
				viewport,
				settleMs,
				new URL( localHref ).origin,
				receipt.cleanup?.policy
			);
			if (receipt.cleanup) {
				const candidateCleanup = await readSourceCleanup(page);
				if (candidateCleanup.removed || candidateCleanup.failures.length || candidateCleanup.residual) {
					throw new Error('Liberated artifact retains advertising/source attribution or its cleanup audit failed');
				}
			}
			const liberatedPng = options.screenshots ? await page.screenshot() : undefined;
			return { source, liberated, sourcePng, liberatedPng };
		};
	}

	const scores: RouteScore[] = [];
	const overlays: OverlayRecord[] = [];
	// Why the two sides can legitimately differ, recorded per side and per
	// viewport. A reader comparing a shorter copy to a longer source needs to
	// see whether a banner came off the source here, or nothing did.
	const recordOverlays = (
		route: string,
		viewport: number,
		sourceHref: string,
		localHref: string,
		pair: { source: LayoutObservation; liberated: LayoutObservation }
	): void => {
		for ( const [ side, url, observation ] of [
			[ 'source', sourceHref, pair.source ],
			[ 'copy', localHref, pair.liberated ],
		] as const ) {
			const dismissed = observation.dismissedOverlays ?? [];
			if ( dismissed.length ) overlays.push( { route, viewport, side, url, dismissed } );
		}
	};
	let comparisonCompleted = false;
	try {
		for ( const route of routes ) {
			const sourceHref = sources.get( route )!;
			const localHref = `${ candidate ?? server?.url ?? 'http://liberated.invalid' }${ route }`;
			for ( const width of widths ) {
				log( `[compare] ${ route } @ ${ width }px` );
				const pair = await observe( sourceHref, localHref, width );
				recordOverlays( route, width, sourceHref, localHref, pair );
				const evidenceDir = join(
					dirname( receiptPath ),
					'compare',
					evidenceSlug( route ),
					String( width )
				);
				// Every check, built-in and contributed, runs through the registry.
				const checked = await runFidelityChecks( {
					route,
					viewport: width,
					sourceUrl: sourceHref,
					candidateUrl: localHref,
					source: pair.source,
					candidate: pair.liberated,
					evidenceDir,
				} );
				if ( pair.candidateRetained ) {
					checked.failures.push( `candidate retains advertising or source attribution (${ pair.candidateRetained } removable)` );
				}
				const score: RouteScore = {
					route,
					viewport: width,
					pass: checked.failures.length === 0,
					failures: checked.failures,
					notes: checked.notes,
					source: pair.source,
					liberated: pair.liberated,
				};
				const dismissedSource = pair.source.dismissedOverlays ?? [];
				const dismissedCopy = pair.liberated.dismissedOverlays ?? [];
				if ( dismissedSource.length || dismissedCopy.length ) {
					score.notes.push(
						`overlays dismissed — source: ${
							overlayLabels( dismissedSource ).join( ', ' ) || 'none'
						}; copy: ${ overlayLabels( dismissedCopy ).join( ', ' ) || 'none' }`
					);
				}
				for ( const artifact of checked.artifacts ) score.notes.push( `evidence → ${ artifact }` );
				if ( pair.sourcePng && pair.liberatedPng ) {
					const evidence = writePixelEvidence( evidenceDir, pair.sourcePng, pair.liberatedPng );
					if ( 'score' in evidence ) {
						score.notes.push(
							`pixel ${ evidence.score.toFixed( 4 ) } (evidence, not a gate) → ${ evidence.diffPath }`
						);
					} else {
						score.notes.push( evidence.error );
					}
				}
				scores.push( score );
			}
			// The interactivity pass deliberately does not run the check registry.
			// It blanks every field except dialogs so that one narrow question can
			// be asked at a width the layout comparison does not cover, and handing
			// a contributed check a synthetic observation would invite it to draw
			// conclusions from values that were zeroed rather than measured.
			if ( ! widths.includes( 390 ) ) {
				log( `[compare] ${ route } @ 390px interactivity` );
				const pair = await observe( sourceHref, localHref, 390 );
				recordOverlays( route, 390, sourceHref, localHref, pair );
				const dialogOnly = ( observation: LayoutObservation ): LayoutObservation => ( {
					...observation,
					title: 'x',
					textChars: 0,
					widestImage: null,
					images: [],
					overflow: false,
					docWidth: 390,
					externalHosts: [],
					hashTargets: [],
					internalMissing: [],
				} );
				const score = {
					...scoreViewport( dialogOnly( pair.source ), dialogOnly( pair.liberated ) ),
					route,
				};
				score.notes.push( 'interactivity' );
				scores.push( score );
			}
		}
		comparisonCompleted = true;
	} finally {
		await browser?.close();
		await server?.close();
		const evidenceDir = join(dirname(receiptPath), 'compare');
		mkdirSync(evidenceDir, { recursive: true });
		if (receipt.cleanup) {
			writeFileSync(join(evidenceDir, 'cleanup-evidence.json'), JSON.stringify({ completed: comparisonCompleted, policy: receipt.cleanup.policy, source: cleanupReports }, null, 2));
		}
		// Written whether or not anything was dismissed: "we looked and the two
		// sides carried the same overlays" is the reading a zero-length list has
		// to support, and a missing file cannot say that.
		writeFileSync(
			join(evidenceDir, 'overlay-evidence.json'),
			JSON.stringify({ schema: 'data-liberation/compare-overlays/v1', completed: comparisonCompleted, kinds: COMPARED_OVERLAY_KINDS, observations: overlays }, null, 2)
		);
	}

	const summary = scoreReport( scores );
	if (receipt.cleanup) {
		const evidenceDir = join(dirname(receiptPath), 'compare');
		log(`[compare] cleanup: ${cleanupReports.reduce((total, report) => total + report.removed, 0)} source removals; evidence: ${join(evidenceDir, 'cleanup-evidence.json')}`);
	} else log('[compare] legacy capture: no cleanup policy was recorded; comparing the unnormalized source');
	const dismissedBySide = ( side: OverlayRecord[ 'side' ] ): number =>
		overlays.filter( ( record ) => record.side === side ).reduce( ( total, record ) => total + record.dismissed.length, 0 );
	log(
		`[compare] overlays: ${ dismissedBySide( 'source' ) } dismissed on the source, ${ dismissedBySide(
			'copy'
		) } on the copy; evidence: ${ join( dirname( receiptPath ), 'compare', 'overlay-evidence.json' ) }`
	);
	summary.pass = summary.pass && selfConsistency.pass;
	return {
		sourceUrl,
		...(receipt.cleanup ? { cleanup: { policy: receipt.cleanup.policy, source: cleanupReports } } : {}),
		overlays,
		websiteDir,
		widths,
		routes,
		routesAvailable: captured.length,
		routesCleanupUnproven: [ ...unproven ].sort(),
		selfConsistency,
		scores,
		...summary,
	};
}
