// src/lib/fidelity/check.ts
//
// Compare a liberated copy against its live source at viewports the capture
// sweep never sampled. Measuring only at the capture width would certify the
// freeze we already shipped once.
//
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { mapPool } from '../concurrency.js';
import * as cheerio from 'cheerio';
import { replayBrowserIdentity } from '../screenshot/capture-profiles.js';
import { sourceContextOptions } from '../browser-kit/browser-kit.js';
import { load } from 'cheerio';
import { boundaryIdentity, validateExternalBoundary, type ExternalBoundary } from '../source-navigation.js';
import type { CapturedRouteNavigation } from '../screenshot/interaction-capture.js';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import {
	dismissOverlays,
	triggerLazyLoad,
	waitForStable,
	type DismissedOverlay,
	type OverlayTarget,
} from '../screenshot/page-helpers.js';
import { applySourceCleanup, readSourceCleanup, validateCleanupPolicy, type CleanupPolicy, type CleanupReport } from '../source-cleanup.js';
import { runFidelityChecks } from './checks.js';
import { readPortableMotion } from '../portable-motion.js';
import { observeViewportEntrances } from '../viewport-entrances.js';
import { validateMotionContract, verifyCandidateMotion, type MotionContract, type MotionEvidence } from './candidate-motion.js';
import { probeDialogs } from './dialog-probe.js';
import { checkInternalRoute, type InternalRouteOutcome } from './internal-route.js';
import { writePixelEvidence } from './evidence.js';
import { captureViewportScreenshot } from './viewport-screenshot.js';
import { checkSelfConsistency, type SelfConsistencyReport } from './self-consistency.js';
import { REFERENCE_WIDTHS, readFrozenObservation, readReferenceArtifact, type FidelityReference, type FidelityStage } from './reference.js';
import {
	scoreReport,
	scoreViewport,
	normalizeImageKey,
	ambiguousRenderedImages,
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

// Keep the gate's unsampled-width baseline stable when the capture sweep gains
// extra learning points; those points must remain independently verified.
const DEFAULT_CAPTURE_WIDTHS_FOR_CHECK = [ 390, 600, 768, 1024, 1280, 1440, 1920 ];

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
	viewport: number,
	/** A learned source startup duration; the source is observed only once it has settled. */
	sourceSettleMs?: number
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
	/** Frozen capture by default; candidateUrl defaults to materialization. Live origin is visited only in drift mode. */
	stage?: FidelityStage;
	/** Required states. Unsupported or absent states are pending, never silently skipped. Default: baseline. */
	states?: string[];
	widths?: number[];
	/** Named document identities in frozen evidence. Default: all declared profile cells. */
	profiles?: string[];
	/** Portable pathnames to check. Frozen default: all declared routes; drift default: spread sample. */
	routes?: string[];
	settleMs?: number;
	/** Frozen comparison cells in flight. Default: 3; integer from 1 to 4. Drift remains serial. */
	concurrency?: number;
	/** How many routes to compare against the live source. */
	sampleSize?: number;
	/** Write source/liberated/diff PNGs. Never used as pass/fail. */
	screenshots?: boolean;
	log?: ( ( message: string ) => void ) | undefined;
	observe?: ObservePair;
	/**
	 * Base URL of another rendered copy. Defaults to portable capture → candidate
	 * at each required route/viewport/state. Explicit stage:'drift' instead compares
	 * the live source to the candidate. Offline checks always describe the capture.
	 */
	candidateUrl?: string;
	/** Explicit observable source/candidate interactions; never changes the static capture's diagnosis. */
	motionContract?: MotionContract;
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
export type RouteScore = ViewportScore & { route: string; stage?: FidelityStage; state?: string; profile?: string };

export interface FidelityReport {
	stage?: FidelityStage;
	status?: 'proven' | 'failed' | 'unproven';
	pending?: Array<{ stage: FidelityStage; route: string; viewport: number; state: string; profile?: string; reason: string }>;
	coverage?: { required: number; measured: number; observedOutcomes?: number; unknowns: string[]; profiles?: Record<string, { required: number; measured: number; pending: number }> };
	/** Boundary proof is distinct from local document geometry/raster scores. */
	outcomes?: Array<{ sourceUrl: string; viewport: number; state: string; profile?: string; kind: 'external-redirect' }>;
	/** Authored portable runtime was verified during this comparison, not inferred from source scripts. */
	portableMotion?: { verified: boolean; routes: string[]; origin: 'authored' | 'learned' };
	cleanup?: { policy: CleanupPolicy; source: CleanupReport[] };
	/** Overlays dismissed per side before measuring. Evidence, never a gate. */
	overlays: OverlayRecord[];
	sourceUrl: string;
	websiteDir: string;
	widths: number[];
	profiles?: string[];
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
	/** Independent live source/candidate behavior evidence. The HTML capture remains motion-incomplete. */
	motionEvidence?: MotionEvidence[];
	pass: boolean;
	failed: number;
	passed: number;
}

interface CaptureReceipt {
	sourceOutcomes?: ExternalBoundary[];
	cleanup?: { policy: CleanupPolicy; complete: boolean; evidencePath?: string };
	sourceInteractivity?: { schema: string; path: string; unreproduced_route_count: number };
	source?: { url?: string };
	websiteRoot?: string;
	routes?: Array< { url?: string; path?: string; documentSelection?: { kind: string }; accessGate?: unknown } >;
	duplicateRoutes?: Array< { url?: string; canonicalUrl?: string; path?: string } >;
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

/** True when this exact URL was captured or the receipt proves it shares a
 * portable file with a retained canonical route. URL normalization alone is
 * deliberately insufficient: aliases must be explicit in duplicateRoutes. */
export function receiptCoversSourceUrl( receipt: CaptureReceipt, url: string ): boolean {
	if ( receipt.routes?.some( route => route.url === url && route.path ) ) return true;
	return ( receipt.duplicateRoutes ?? [] ).some( alias =>
		alias.url === url && !!alias.canonicalUrl && !!alias.path &&
		receipt.routes?.some( route => route.url === alias.canonicalUrl && route.path === alias.path )
	);
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

export function checkWidthsFor( sampled: number[] = DEFAULT_CAPTURE_WIDTHS_FOR_CHECK ): number[] {
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

export async function observePage(
	page: Page,
	url: string,
	viewport: number,
	settleMs: number,
	localOrigin: string | null,
	cleanup?: CleanupPolicy,
	onBaseline?: () => Promise<void>,
	/** Observe the already-cleaned capture session without navigation or interaction probes. */
	captureSession = false,
	/** Skip scroll probes for frozen baseline observations; drift observations keep them enabled. */
	skipScrollProbe = false
): Promise< LayoutObservation > {
	const external = new Set< string >();
	const onRequest = ( request: { url: () => string } ): void => {
		const host = externalRequestHost( request.url(), localOrigin );
		if ( host ) external.add( host );
	};
	page.on( 'request', onRequest );
	try {
		if ( ! captureSession ) {
			await page.addInitScript( observeViewportEntrances );
			const response = await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 60_000 } );
			if ( response && ! response.ok() ) throw new Error( `Observation HTTP ${ response.status() }: ${ url }` );
		}
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
		// Baseline capture already completed its lazy-load sweep. Repeating it
		// while collecting frozen evidence can relatch scroll-driven page state;
		// candidate baseline observation likewise preserves the visitor's pose.
		// Drift observations keep the controlled sweep for lazy content/motion.
		if ( ! skipScrollProbe ) await triggerLazyLoad( page, false, { expandContent: !captureSession } );
		dismissedOverlays.push( ...( await dismissOverlays( page, { kinds: COMPARED_OVERLAY_KINDS } ) ) );
		// Evidence describes the settled baseline, not the page left behind by
		// anchor/dialog probes (which can scroll or leave a popup open).
		await onBaseline?.();
		const measured = await page.evaluate( async ( { clickUnresolved, skipScrollProbe }: { clickUnresolved: boolean; skipScrollProbe: boolean } ) => {
			const globalWithName = globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown };
			if (typeof globalWithName.__name === 'undefined') globalWithName.__name = fn => fn;
			// Perceptual identity for one image: fetch the bytes (cache-warm —
			// the page just rendered them), decode locally, downscale to 8x8
			// grayscale, threshold at the mean. Fetching keeps this
			// cross-origin safe where canvas reads of the element would taint;
			// any failure leaves null and the key-only matcher covers it.
			const hashCache = new Map< string, Promise< { contentHash: string; assetHash: string | null } | null > >();
			const contentHashFor = ( src: string ): Promise< { contentHash: string; assetHash: string | null } | null > => {
				const cached = hashCache.get( src );
				if ( cached ) return cached;
				const pending = ( async () => {
					try {
						if ( ! src || src.startsWith( 'data:' ) || src.startsWith( 'blob:' ) ) return null;
						const response = await fetch( src, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout( 5000 ) } );
						if ( ! response.ok ) return null;
						const blob = await response.blob();
						const bytes = await blob.arrayBuffer();
						const digest = await globalThis.crypto?.subtle?.digest( 'SHA-256', bytes );
						const assetHash = digest ? Array.from( new Uint8Array( digest ), byte => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' ) : null;
						const bitmap = await createImageBitmap( blob );
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
						return { contentHash: value, assetHash };
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
			const semanticRole = ( image: HTMLImageElement ): string => {
				const parts: string[] = [];
				for ( let element: Element | null = image; element; element = element.parentElement ) {
					if ( element !== image && ! element.matches( 'dialog,[role],nav,main,header,footer,figure,section[aria-label]' ) ) continue;
					parts.push( `${ element.getAttribute( 'role' ) || element.tagName.toLowerCase() }:${ element.getAttribute( 'aria-label' ) || element.getAttribute( 'alt' ) || '' }` );
				}
				return parts.join( '/' );
			};
			const images = await Promise.all(
				[ ...document.querySelectorAll< HTMLImageElement >( 'img' ) ]
					.map( ( image ) => ( {
						rect: image.getBoundingClientRect(),
						src: image.currentSrc || image.getAttribute( 'src' ) || '',
						role: semanticRole( image ),
						decoded: image.complete && image.naturalWidth > 0,
						renditions: renditionUrls( image ),
						hidden: getComputedStyle( image ).visibility === 'hidden',
					} ) )
					.filter( ( { rect, hidden } ) => ! hidden && rect.width > 50 && rect.height > 50 )
					.map( async ( { rect, src, renditions, role, decoded } ) => ( {
						key: src,
						role,
						decoded,
						renditions,
						x: Math.round( rect.x ),
						y: Math.round( rect.y ),
						width: Math.round( rect.width ),
						height: Math.round( rect.height ),
						...( await contentHashFor( src ) ?? { contentHash: null, assetHash: null } ),
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
			// Canonicalize painted inline flow, not DOM serialization boundaries.
			// Keep raw whitespace until the complete run is assembled; comments and
			// equivalent inline wrappers add no glyphs, while blocks/replaced boxes,
			// positioning and style changes must remain separate observations.
			const styleProperties = [ 'fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing',
				'fontStretch', 'fontVariant', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning',
				'whiteSpace', 'textTransform', 'wordSpacing', 'direction', 'writingMode', 'verticalAlign',
				'color', 'textDecorationLine', 'textDecorationStyle', 'textDecorationColor' ] as const;
			let run: { text: string; style: CSSStyleDeclaration; signature: string; last: DOMRect; width: number } | undefined;
			const flush = () => {
				if ( ! run ) return;
				const { style, width } = run;
				const text = run.text.replace( /\s+/g, ' ' ).trim();
				run = undefined;
				if ( ! text || typography.length >= 120 ) return;
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
					advance: Math.round( ( context?.measureText( text ).width ?? width ) * 100 ) / 100,
					loaded: document.fonts.check( font, text ),
				} );
			};
			const visit = ( node: Node ) => {
				if ( typography.length >= 120 ) return;
				if ( node.nodeType === Node.COMMENT_NODE ) return;
				if ( node instanceof Element ) {
					const style = getComputedStyle( node );
					if ( node.matches( 'script,style,noscript,template' ) || style.display === 'none' || style.visibility === 'hidden' ) {
						flush();
						return;
					}
					const inline = ( style.display === 'inline' || style.display === 'contents' ) &&
						style.position === 'static' && style.cssFloat === 'none' && style.transform === 'none' &&
						style.translate === 'none' && style.rotate === 'none' && style.scale === 'none' &&
						[ style.marginLeft, style.marginRight, style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth ]
							.every( value => Number.parseFloat( value ) === 0 );
					const boundary = ! inline || ! node.childNodes.length;
					if ( boundary ) flush();
					for ( const child of node.childNodes ) visit( child );
					if ( boundary ) flush();
					return;
				}
				const parent = node.parentElement;
				if ( node.nodeType !== Node.TEXT_NODE || ! parent || ! node.textContent ) return;
				const range = document.createRange();
				range.selectNodeContents( node );
				const rect = range.getBoundingClientRect();
				const style = getComputedStyle( parent );
				const signature = JSON.stringify( styleProperties.map( property => style[ property ] ) );
				const parentRect = parent.getBoundingClientRect();
				const clippedLabel = parentRect.width <= 1.5 && parentRect.height <= 1.5 &&
					( style.position === 'absolute' || style.position === 'fixed' ) &&
					( style.overflow === 'hidden' || style.clip !== 'auto' || style.clipPath !== 'none' );
				// A collapsed inter-word space at a soft wrap has no painted width,
				// but still separates words in the canonical text of this flow.
				if ( rect.width === 0 && /^\s+$/.test( node.textContent ) && ! clippedLabel ) {
					if ( run?.signature === signature ) run.text += node.textContent;
					else flush();
					return;
				}
				if (
					rect.width <= 0 ||
					rect.height <= 0 ||
					clippedLabel ||
					style.display === 'none' ||
					style.visibility === 'hidden'
				) {
					flush();
					return;
				}
				const rects = [ ...range.getClientRects() ].filter( part => part.width > 0 && part.height > 0 );
				const first = rects[ 0 ] ?? rect;
				const last = rects.at( -1 ) ?? rect;
				const adjacent = ! run || ( style.writingMode === 'horizontal-tb' && style.direction === 'ltr' &&
					( Math.abs( first.y - run.last.y ) < 1 ? Math.abs( first.left - run.last.right ) <= 2 :
						first.y > run.last.y && first.y - run.last.y <= ( Number.parseFloat( style.lineHeight ) || rect.height * 1.2 ) + 2 ) );
				if ( run && ( run.signature !== signature || ! adjacent ) ) flush();
				if ( run ) { run.text += node.textContent; run.last = last; run.width += rect.width; }
				else run = { text: node.textContent, style, signature, last, width: rect.width };
			};
			visit( document.body );
			flush();

			// Animation names are not identities. Removing an earlier same-name
			// effect must not make a still-paused sibling look scroll-responsive.
			const identities = new Map< Animation, number >();
			const identity = ( animation: Animation ) => {
				if ( ! identities.has( animation ) ) identities.set( animation, identities.size );
				return identities.get( animation )!;
			};
			const animationsBefore = document
				.getAnimations()
				.filter( ( animation ) => animation.effect?.getComputedTiming().iterations !== Infinity )
				.map( ( animation ) => {
					const name = ( animation as Animation & { animationName?: string } ).animationName;
					if ( ! name || name === 'none' ) return null;
					return {
						key: identity( animation ),
						name,
						time: animation.currentTime?.toString() ?? 'null',
						state: animation.playState,
					};
				} )
				.filter( ( animation ): animation is NonNullable< typeof animation > => animation !== null );
			const animationStateBefore = new Map(
				animationsBefore.map( ( animation ) => [ animation.key, animation ] )
			);
			let responsiveAnimations: string[] = [];
			if ( ! skipScrollProbe ) {
				const originalScroll = { x: scrollX, y: scrollY };
				const root = document.documentElement;
				const scrollBehavior = root.style.scrollBehavior;
				root.style.scrollBehavior = 'auto';
				window.scrollTo( 0, Math.min( document.documentElement.scrollHeight - innerHeight, innerHeight * 1.5 ) );
				await new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) );
				await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
				const animationsAfter = document
					.getAnimations()
					.filter( ( animation ) => animation.effect?.getComputedTiming().iterations !== Infinity )
					.map( ( animation ) => {
						const name = ( animation as Animation & { animationName?: string } ).animationName;
						if ( ! name || name === 'none' ) return null;
						return {
							key: identity( animation ),
							name,
							time: animation.currentTime?.toString() ?? 'null',
							state: animation.playState,
						};
					} )
					.filter( ( animation ): animation is NonNullable< typeof animation > => animation !== null );
				responsiveAnimations = animationsAfter
					.filter( ( animation ) => {
						const before = animationStateBefore.get( animation.key );
						return ! before || before.time !== animation.time || before.state !== animation.state;
					} )
					.map( ( animation ) => animation.name )
					.sort();
				window.scrollTo( originalScroll.x, originalScroll.y );
				root.style.scrollBehavior = scrollBehavior;
			}
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
			// innerText still includes a clipped 1×1 keyboard skip link. It is
			// useful content when focused, but not rendered body copy at rest.
			// Remove only a direct, focus-only fragment link occupying the text
			// prefix; editorial links with the same label remain counted.
			let bodyText = document.body?.innerText ?? '';
			// innerText reports text in overflow-clipped offstage content. Remove
			// a text node only when none of its actual range boxes intersects an
			// ancestor clip; any partly painted run remains counted. Do not use
			// carousel selectors, aria-hidden, or viewport position.
			bodyText = bodyText.replace( /\s+/g, ' ' ).trim();
			const textNodes: Array< { text: string; clipped: boolean } > = [];
			const textWalker = document.createTreeWalker( document.body, NodeFilter.SHOW_TEXT );
			let candidateText: Node | null;
			while ( ( candidateText = textWalker.nextNode() ) ) {
				const value = candidateText.textContent ?? '';
				if ( ! value.trim() || candidateText.parentElement?.closest( 'script,style,noscript,template' ) ) continue;
				if ( candidateText.parentElement && getComputedStyle( candidateText.parentElement ).fontSize === '0px' ) continue;
				const range = document.createRange(); range.selectNodeContents( candidateText );
				const rects = [ ...range.getClientRects() ];
				if ( ! rects.length ) continue;
				const parent = candidateText.parentElement;
				if ( ! parent ) continue;
				if ( getComputedStyle( parent ).visibility === 'hidden' ) continue;
				const painted = rects.some( rect => {
					if ( rect.width <= 0 || rect.height <= 0 ) return false;
					let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
					for ( let ancestor: HTMLElement | null = parent; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement ) {
						const style = getComputedStyle( ancestor );
						if ( style.display === 'contents' ) continue;
						if ( ! [ 'hidden', 'clip' ].includes( style.overflowX ) && ! [ 'hidden', 'clip' ].includes( style.overflowY ) ) continue;
						const box = ancestor.getBoundingClientRect();
						if ( [ 'hidden', 'clip' ].includes( style.overflowX ) ) { left = Math.max( left, box.left ); right = Math.min( right, box.right ); }
						if ( [ 'hidden', 'clip' ].includes( style.overflowY ) ) { top = Math.max( top, box.top ); bottom = Math.min( bottom, box.bottom ); }
					}
					return right > left && bottom > top;
				} );
				textNodes.push( { text: value, clipped: ! painted } );
			}
			let textSearchFrom = 0;
			for ( const { text, clipped } of textNodes ) {
				// Map each DOM text node in document order to the normalized
				// innerText stream. Advancing for visible nodes prevents identical
				// later text from being mistaken for an earlier occurrence.
				const normalizedText = text.replace( /\s+/g, ' ' ).trim();
				if ( ! normalizedText ) continue;
				const at = bodyText.indexOf( normalizedText, textSearchFrom );
				if ( at >= 0 ) {
					if ( clipped ) {
						bodyText = `${ bodyText.slice( 0, at ) } ${ bodyText.slice( at + normalizedText.length ) }`;
						// The stream shrinks on deletion; resume after the replacement
						// separator while preserving later identical occurrences.
						textSearchFrom = at + 1;
					} else textSearchFrom = at + normalizedText.length;
				}
			}
			for ( const element of document.body?.children ?? [] ) {
				if ( ! ( element instanceof HTMLAnchorElement ) || ! element.hash || element.matches( ':focus' ) ) continue;
				const style = getComputedStyle( element );
				const box = element.getBoundingClientRect();
				if ( box.width > 1.5 || box.height > 1.5 || style.overflow !== 'hidden' || ( style.clipPath === 'none' && style.clip === 'auto' ) ) continue;
				const label = element.innerText.replace( /\s+/g, ' ' ).trim();
				const prefix = bodyText.trimStart();
				if ( label && prefix.startsWith( label ) && /^\s/.test( prefix.slice( label.length ) ) ) bodyText = prefix.slice( label.length );
			}
			// A native decorative glyph may be replaced visually by source SVG
			// artwork while its save-valid text remains in the DOM at font-size:0.
			// innerText counts that unpainted text. Remove only a zero-font, leaf,
			// explicitly decorative fragment at its actual position in its parent;
			// identical visible symbols in an editorial label remain counted.
			const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
			bodyText = normalized(bodyText);
			for (const element of document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')) {
				if (element.childElementCount || getComputedStyle(element).fontSize !== '0px') continue;
				const parent = element.parentElement, label = normalized(element.innerText);
				if (!parent || !label || !parent.getBoundingClientRect().height) continue;
				const context = normalized(parent.innerText);
				const range = document.createRange(); range.selectNodeContents(parent); range.setEndBefore(element);
				const prefix = normalized(range.toString());
				if (prefix && !context.startsWith(prefix)) continue;
				const offset = context.indexOf(label, prefix.length);
				if (offset < 0) continue;
				bodyText = bodyText.replace(context, normalized(context.slice(0, offset) + context.slice(offset + label.length)));
			}
			const textChars = bodyText.replace( /\s+/g, ' ' ).trim().length;
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
				entranceTransitions: ( window as typeof window & { __dlaEntrances?: { transitions: string[] } } ).__dlaEntrances?.transitions ?? [],
				entranceLosses: Array.from( document.querySelectorAll( '[data-dla-viewport-entrance-loss]' ) ).filter( element => element.getClientRects().length )
					.map( element => `${ element.id || 'anonymous target' }: ${ element.getAttribute( 'data-dla-viewport-entrance-loss' ) }` ),
				docWidth: document.documentElement.scrollWidth,
				overflow: document.documentElement.scrollWidth > window.innerWidth,
				hashTargets,
				internalPaths,
			};
		}, { clickUnresolved: ! localOrigin && ! captureSession, skipScrollProbe } );

		const internalRoutes: InternalRouteOutcome[] = [];
		if ( localOrigin ) {
			for ( const path of measured.internalPaths.slice( 0, MAX_ROUTE_CHECKS ) ) {
				internalRoutes.push( await checkInternalRoute( page.request, localOrigin, path ) );
			}
		}

		const dialogs = captureSession ? [] : await probeDialogs( page );

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
			entranceTransitions: measured.entranceTransitions,
			entranceLosses: measured.entranceLosses,
			docWidth: measured.docWidth,
			overflow: measured.overflow,
			externalHosts: [ ...external ].sort(),
			hashTargets: measured.hashTargets as HashTarget[],
			internalRoutes,
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

async function verifyCapturedRouteTabs(
	page: Page,
	localHref: string,
	width: number,
	observations: CapturedRouteNavigation[],
	sources: Map< string, string >
): Promise< string[] > {
	const sourceRoutes = new Map( [ ...sources ].map( ( [ route, url ] ) => [ normalizedUrl( url ), route ] ) );
	const tabs = new Map< string, { route: string; siblings: string[] } >();
	for ( const observation of observations ) {
		const route = sourceRoutes.get( normalizedUrl( observation.url ) );
		if ( route && observation.siblings.length >= 2 && ! tabs.has( observation.label ) )
			tabs.set( observation.label, { route, siblings: observation.siblings } );
	}
	if ( ! tabs.size ) return [];
	const failures: string[] = [];
	const origin = new URL( localHref ).origin;
	await page.setViewportSize( { width, height: 900 } );
	for ( const [ label, target ] of [ ...tabs ].slice( 0, 4 ) ) {
		await page.goto( localHref );
		// Editable-block destination conversions nest each observed tab inside
		// arbitrary wrappers and may split it into an icon link plus a
		// paragraph-wrapped labeled link, so direct anchor/button siblings no
		// longer exist. The group is identified by the labels the source was
		// observed to show — every one of them must still be present among the
		// navigation's bounded descendants — and the verified link is the
		// visible labeled one, wherever the conversion nested it.
		const matched = await page.evaluate( `(() => {
			const { label, siblings } = ${ JSON.stringify( { label, siblings: target.siblings } ) };
			function name(element) { return (element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim(); }
			// The same rule a real click applies: a display:contents anchor
			// generates no box of its own, so it is visible when a child
			// element or text node paints in its place (WordPress import
			// lowering wraps each bottom-tab label as a > mark this way).
			// Children of a display:none or visibility:hidden link never
			// paint, so hidden links stay rejected.
			function visible(element) {
				const style = getComputedStyle(element);
				if (style.display === 'none' || style.visibility === 'hidden') return false;
				const rect = element.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) return true;
				if (style.display !== 'contents') return false;
				for (const child of element.children) if (visible(child)) return true;
				for (const node of element.childNodes) {
					if (node.nodeType !== 3 || !node.textContent.trim()) continue;
					const range = document.createRange();
					range.selectNode(node);
					const textRect = range.getBoundingClientRect();
					if (textRect.width > 0 && textRect.height > 0) return true;
				}
				return false;
			}
			for ( const nav of Array.from(document.querySelectorAll('nav,[role="navigation"]')).slice(0, 4) ) {
				const members = Array.from(nav.querySelectorAll('a,button')).slice(0, 64);
				const names = members.map(name);
				if (!siblings.every(sibling => names.includes(sibling))) continue;
				const link = members.find(member => member.tagName === 'A' && member.hasAttribute('href') && name(member) === label && visible(member));
				if (!link) continue;
				link.setAttribute('data-dla-check-route-tab', '');
				return link.href;
			}
			return null;
		})()` ) as string | null;
		if ( matched === null ) {
			failures.push( `route tab ${ label } @ ${ width }px missing native link` );
			continue;
		}
		// Destination checking: the matched link must point at the copy's own
		// file for the route the source click produced, before any click.
		let destination: URL;
		try {
			destination = new URL( matched );
		} catch {
			failures.push( `route tab ${ label } @ ${ width }px links to ${ matched }, expected ${ target.route }` );
			continue;
		}
		const linkedRoute = destination.origin === origin ? canonicalRoutePath( destination.pathname ) : destination.href;
		if ( linkedRoute !== target.route ) {
			failures.push( `route tab ${ label } @ ${ width }px links to ${ linkedRoute }, expected ${ target.route }` );
			continue;
		}
		try {
			await page.locator( '[data-dla-check-route-tab]' ).click( { timeout: 2_000 } );
			if ( canonicalRoutePath( new URL( page.url() ).pathname ) !== target.route )
				failures.push( `route tab ${ label } @ ${ width }px landed on ${ new URL( page.url() ).pathname }, expected ${ target.route }` );
		} catch {
			failures.push( `route tab ${ label } @ ${ width }px click blocked` );
		}
	}
	return failures;
}

export async function checkFidelity( options: FidelityCheckOptions ): Promise< FidelityReport > {
	const stage = options.stage ?? ( options.candidateUrl ? 'materialization' : 'capture' );
	if ( options.profiles && ( ! options.profiles.length || options.profiles.some( profile => ! /^[a-z][a-z0-9-]*$/.test( profile ) ) ) ) throw new Error( 'profiles requires valid source document identities' );
	if ( stage === 'drift' && options.profiles ) throw new Error( 'Named source profile replay requires frozen evidence' );
	if ( ! [ 'capture', 'materialization', 'drift' ].includes( stage ) ) throw new Error( 'Unknown fidelity stage' );
	if ( stage !== 'drift' ) return checkFrozenFidelity( options, stage );
	const log = options.log ?? ( () => {} );
	const { websiteDir, receiptPath } = resolveCheckDirectory( options.directory );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as CaptureReceipt;
	const motionPages = receipt.sourceInteractivity?.schema === 'data-liberation/source-interactivity/v1'
		&& receipt.sourceInteractivity.path === 'source-interactivity.json'
		? JSON.parse( readFileSync( join( dirname( receiptPath ), receipt.sourceInteractivity.path ), 'utf8' ) ) as { pages?: Array< { url: string; status: string; signals: string[] } > }
		: undefined;
	const unreproducedMotion = new Map( ( motionPages?.pages ?? [] )
		.filter( ( page ) => page.status === 'unreproduced' )
		.map( ( page ) => [ page.url, page.signals ] ) );
	if (receipt.cleanup) validateCleanupPolicy(receipt.cleanup.policy);
	const cleanupReports: CleanupReport[] = [];
	const sourceUrl = receipt.source?.url;
	if ( ! sourceUrl ) throw new Error( `capture-receipt.json has no source.url: ${ receiptPath }` );

	const widths = options.widths ?? checkWidthsFor();
	const settleMs = options.settleMs ?? 4000;

	const sources = routeSourceMap( receipt );
	const interactionPath = join( dirname( receiptPath ), 'interaction-states.json' );
	const observedRoutes: CapturedRouteNavigation[] = existsSync( interactionPath )
		? ( JSON.parse( readFileSync( interactionPath, 'utf8' ) ) as { pages?: Array< { routeNavigation?: CapturedRouteNavigation[] } > } )
			.pages?.flatMap( page => page.routeNavigation ?? [] ) ?? []
		: [];
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

	// A provider-gated route was captured as a placeholder over the site shell
	// (see access-gate.ts). The live source only ever shows its login there, so
	// replaying it would report the placeholder itself as drift.
	const gatedUrls = new Set( ( receipt.routes ?? [] ).filter( ( route ) => route?.accessGate && route.url ).map( ( route ) => route.url! ) );
	const gated = [ ...sources ].filter( ( [ , url ] ) => gatedUrls.has( url ) ).map( ( [ route ] ) => route );
	for ( const route of gated ) sources.delete( route );
	if ( gated.length > 0 ) {
		log( `[compare] ${ gated.length } access-gated route(s) were captured as placeholders and are not compared against the live source: ${ gated.sort().join( ', ' ) }` );
	}

	const captured = [ ...sources.keys() ].sort( ( left, right ) =>
		left === '/' ? -1 : right === '/' ? 1 : left.localeCompare( right )
	);
	const requested = options.routes?.map( canonicalRoutePath );
	for ( const route of requested ?? [] ) {
		if ( sources.has( route ) ) continue;
		if ( gated.includes( route ) ) throw new Error( `Route ${ route } was captured as an access-gate placeholder; the live source cannot be compared` );
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
	const portable = candidate || options.motionContract ? null : readPortableMotion( dirname( receiptPath ), websiteDir );
	const motionContract = options.motionContract ?? portable?.contract;
	if ( motionContract ) {
		if ( ( ! candidate && ! portable ) || options.observe ) throw new Error( 'Motion contract requires a live --candidate browser comparison or a portable runtime receipt' );
		validateMotionContract( motionContract );
	}
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
		observe = async ( sourceHref, localHref, viewport, sourceSettleMs = 0 ) => {
			if ( ! page ) throw new Error( 'browser page missing' );
			await page.setViewportSize( { width: viewport, height: 900 } );
			let sourcePng: Buffer | undefined;
			let liberatedPng: Buffer | undefined;
			const source = await observePage( page, sourceHref, viewport, Math.max( settleMs, sourceSettleMs ), null, receipt.cleanup?.policy,
				options.screenshots ? async () => { sourcePng = await page!.screenshot(); } : undefined );
			if (receipt.cleanup) {
				const report = await readSourceCleanup(page);
				cleanupReports.push(report);
				if (report.failures.length || report.residual) throw new Error('Comparison source cleanup incomplete');
			}
			// Leave the source before observing the copy in this same tab. Sources
			// send analytics beacons as they are left (beforeunload, in-flight
			// batches — Substack's /api/v1/firehose/batch); navigating straight to
			// the copy fires them after the copy's request listener is attached, so
			// a clean copy was reported as requesting the source's hosts.
			await page.goto( 'about:blank' ).catch( () => {} );
			if ( candidate ) {
				// Measure the candidate as a visitor sees it, then ask the cleanup
				// policy what it would still remove. Removing it first would hide
				// exactly what is being measured.
				const liberated = await observePage( page, localHref, viewport, settleMs, new URL( localHref ).origin, undefined,
					options.screenshots ? async () => { liberatedPng = await page!.screenshot(); } : undefined );
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
				receipt.cleanup?.policy,
				options.screenshots ? async () => { liberatedPng = await page!.screenshot(); } : undefined
			);
			if (receipt.cleanup) {
				const candidateCleanup = await readSourceCleanup(page);
				if (candidateCleanup.removed || candidateCleanup.failures.length || candidateCleanup.residual) {
					throw new Error('Liberated artifact retains advertising/source attribution or its cleanup audit failed');
				}
			}
			return { source, liberated, sourcePng, liberatedPng };
		};
	}

	const scores: RouteScore[] = [];
	const motionEvidence: MotionEvidence[] = [];
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
			const signals = unreproducedMotion.get( sourceHref );
			const contract = signals && motionContract?.routes[ route ];
			if ( signals && contract && browser ) {
				for ( const width of motionContract!.widths ) {
					log( `[compare] ${ route } @ ${ width }px source/candidate motion` );
					motionEvidence.push( await verifyCandidateMotion( browser, route, width, sourceHref, localHref, contract, signals ) );
				}
			}
			const candidateMotionVerified = !! signals && !! contract && [ 390, 768, 1440 ].every( ( width ) =>
				motionEvidence.some( ( evidence ) => evidence.route === route && evidence.viewport === width && evidence.pass )
			);
			for ( const width of widths ) {
				log( `[compare] ${ route } @ ${ width }px` );
				const pair = await observe( sourceHref, localHref, width, contract ? contract.ready.sourceSettleMs : undefined );
				recordOverlays( route, width, sourceHref, localHref, pair );
				const evidenceDir = join(
					dirname( receiptPath ),
					'compare',
					evidenceSlug( route ),
					String( width )
				);
				// Every check, built-in and contributed, runs through the registry.
				const checked = await runFidelityChecks( {
					stage: 'drift',
					state: 'baseline',
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
				if ( signals && ! candidateMotionVerified ) checked.failures.push( `source motion not reproduced by capture: ${ signals.join( ', ' ) }; candidate behavior unverified` );
				for ( const residual of portable?.unsupported?.[ route ] ?? [] ) checked.failures.push( `source behavior not translated${ residual.selector ? ` (${ residual.selector })` : '' }: ${ residual.reason }` );
				if ( candidateMotionVerified ) checked.notes.push( portable ? `raw source/capture motion unreproduced; ${ portable.origin ?? 'authored' } portable runtime independently verified at 390/768/1440px` : 'source/capture motion unreproduced; independent source/candidate interaction verified at 390/768/1440px' );
				const score: RouteScore = {
					stage: 'drift',
					state: 'baseline',
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
				const pair = await observe( sourceHref, localHref, 390, contract ? contract.ready.sourceSettleMs : undefined );
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
					internalRoutes: [],
				} );
				const score = {
					stage: 'drift' as const,
					state: 'dialogs',
					...scoreViewport( dialogOnly( pair.source ), dialogOnly( pair.liberated ) ),
					route,
				};
				if ( page && observedRoutes.length ) {
					// Route-tab evidence was observed on the source during capture. Verify
					// the visitor's real click on the portable counterpart, not just href.
					for ( const width of [ 390, 768 ] ) {
						const failures = await verifyCapturedRouteTabs( page, localHref, width, observedRoutes, sources );
						if ( failures.length ) {
							score.failures.push( ...failures );
							score.pass = false;
						}
						score.notes.push( `route tabs @ ${ width }px: ${ failures.length ? 'failed' : 'clicks verified' }` );
					}
				}
				if ( signals && ! candidateMotionVerified ) {
					score.failures.push( `source motion not reproduced by capture: ${ signals.join( ', ' ) }; candidate behavior unverified` );
					score.pass = false;
				}
				if ( candidateMotionVerified ) score.notes.push( portable ? `raw capture motion unreproduced; ${ portable.origin ?? 'authored' } portable runtime verified` : 'source/capture motion unreproduced; independent candidate interaction verified' );
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
		if ( motionContract ) writeFileSync( join( evidenceDir, 'candidate-motion-evidence.json' ),
			JSON.stringify( { schema: 'data-liberation/candidate-motion/v1', completed: comparisonCompleted, observations: motionEvidence }, null, 2 ) );
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
		stage: 'drift',
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
		...( motionContract ? { motionEvidence } : {} ),
		...( portable ? { portableMotion: { verified: motionEvidence.length > 0 && motionEvidence.every( ( evidence ) => evidence.pass ), routes: Object.keys( portable.routes ), origin: portable.origin ?? 'authored' } } : {} ),
		...summary,
	};
}

/** Frozen stages share the live observer and registered scoring path; no source browser is created. */
async function checkFrozenFidelity( options: FidelityCheckOptions, stage: 'capture' | 'materialization' ): Promise<FidelityReport> {
	const concurrency = options.concurrency ?? 3;
	if ( ! Number.isInteger( concurrency ) || concurrency < 1 || concurrency > 4 ) throw new Error( 'Frozen comparison concurrency must be an integer from 1 to 4' );
	if ( options.observe || options.motionContract ) throw new Error( 'Frozen comparison requires real browser baseline evidence; observe/motionContract are drift-only' );
	if ( options.sampleSize !== undefined ) throw new Error( 'sampleSize is drift-only; select explicit routes for bounded frozen comparison' );
	if ( stage === 'materialization' && ! options.candidateUrl ) throw new Error( 'Materialization stage requires candidateUrl' );
	if ( stage === 'capture' && options.candidateUrl ) throw new Error( 'candidateUrl requires materialization or drift stage' );
	const { websiteDir, receiptPath } = resolveCheckDirectory( options.directory );
	const directory = dirname( receiptPath );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as CaptureReceipt;
	const sources = routeSourceMap( receipt );
	let widths = options.widths ?? [ ...REFERENCE_WIDTHS ];
	const states = options.states ?? [ 'baseline' ];
	const routes = options.routes?.map( canonicalRoutePath ) ?? [ ...sources.keys() ];
	const selfConsistency = checkSelfConsistency( websiteDir, routeFiles( receipt ) );
	const scores: RouteScore[] = [];
	const pending: NonNullable<FidelityReport['pending']> = [];
	const outcomes: NonNullable<FidelityReport['outcomes']> = [];
	let manifest: FidelityReference | undefined;
	let invalid: string | undefined;
	try {
		manifest = JSON.parse( readFileSync( join( directory, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		if ( manifest.schema !== 'data-liberation/fidelity-reference/v1' || manifest.sourceUrl !== receipt.source?.url || ! manifest.captureId ) throw new Error( 'Invalid reference schema or source identity' );
		if ( manifest.scope.cells ) {
			const keys = new Set<string>();
			for ( const cell of manifest.scope.cells ) {
				const key = JSON.stringify( [ cell.sourceUrl, cell.profile, cell.viewport, cell.state ] );
				if ( keys.has( key ) || ! /^[a-z][a-z0-9-]*$/.test( cell.profile ) || ! Number.isInteger( cell.viewport ) || cell.viewport <= 0 ) throw new Error( 'Invalid or duplicate reference profile cell' );
				keys.add( key );
			}
		}
		if ( manifest.receipt.path !== 'capture-receipt.json' ) throw new Error( 'Invalid reference receipt identity' );
		readReferenceArtifact( directory, manifest.receipt );
		if ( stage === 'materialization' ) {
			if ( ! manifest.capture.length ) throw new Error( 'Portable capture hashes missing' );
			for ( const artifact of manifest.capture ) readReferenceArtifact( directory, artifact );
		}
	} catch ( error ) { invalid = `Frozen reference unproven: ${ String( error ) }`; }
	if ( ! options.widths && manifest?.scope.cells ) widths = manifest.scope.widths;
	const required: Array<{ route: string; viewport: number; state: string; profile?: string }> = [];
	for ( const route of routes ) {
		const declared = manifest?.scope.cells?.filter( cell => cell.sourceUrl === sources.get( route ) );
		if ( declared ) {
			for ( const cell of declared ) {
				if ( ! widths.includes( cell.viewport ) || ! states.includes( cell.state ) || options.profiles && ! options.profiles.includes( cell.profile ) ) continue;
				required.push( { route, viewport: cell.viewport, state: cell.state, profile: cell.profile } );
			}
			// Explicit caller requirements outside declared cells stay pending.
			for ( const viewport of widths ) for ( const state of states ) {
				const profiles = options.profiles ?? [ undefined ];
				for ( const profile of profiles ) {
					if ( required.some( cell => cell.route === route && cell.viewport === viewport && cell.state === state && ( profile === undefined || cell.profile === profile ) ) ) continue;
					if ( ! options.widths && ! options.profiles && state === 'baseline' && declared.length ) continue;
					if ( ! options.widths && profile !== undefined && declared.some( cell => cell.profile === profile && cell.state === state ) ) continue;
					required.push( { route, viewport, state, ...( profile ? { profile } : {} ) } );
				}
			}
		} else for ( const viewport of widths ) for ( const state of states ) for ( const profile of options.profiles ?? [ undefined ] ) required.push( { route, viewport, state, ...( profile ? { profile } : {} ) } );
	}
	const unknowns = manifest?.scope?.unknowns ?? [ 'Capture has no valid frozen source evidence.' ];
	// Discovery failures cannot disappear simply because no portable route was written.
	let missingRequired = 0;
	for ( const url of options.routes ? [] : manifest?.scope?.sourceUrls ?? [] ) {
		if ( [ ...sources.values() ].includes( url ) || receiptCoversSourceUrl( receipt, url ) ) continue;
		const declared = manifest?.scope.cells?.filter( cell => cell.sourceUrl === url && widths.includes( cell.viewport ) && states.includes( cell.state ) && ( ! options.profiles || options.profiles.includes( cell.profile ) ) );
		const missingCells: Array<{ viewport: number; state: string; profile?: string }> = declared?.length
			? declared.map( cell => ( { viewport: cell.viewport, state: cell.state, profile: cell.profile } ) )
			: widths.flatMap( viewport => states.flatMap( state => ( options.profiles ?? [ undefined ] ).map( profile => ( { viewport, state, ...( profile ? { profile } : {} ) } ) ) ) );
		// One capture profile observes each initial document; legacy width-only
		// evidence used the desktop and mobile capture devices.
		const outcomeProfiles = new Set( manifest?.scope.cells?.filter( cell => cell.sourceUrl === url ).map( cell => cell.profile ) );
		for ( const { viewport, state, profile } of missingCells ) {
			missingRequired++;
			try {
				if (invalid) throw new Error(invalid);
				const captured = (receipt.sourceOutcomes ?? []).filter(outcome => outcome.requestedUrl === url);
				if (!captured.length) throw new Error('Declared source route has no portable capture or frozen boundary');
				if (state !== 'baseline' || !manifest!.scope.states.includes(state) || !manifest!.scope.widths.includes(viewport)) throw new Error('Required outcome viewport/state is outside frozen scope');
				for (const boundary of captured) validateExternalBoundary(boundary, readReferenceArtifact(directory, boundary.evidence));
				const deviceCount = outcomeProfiles.size || 2;
				if (new Set(captured.map(boundaryIdentity)).size !== 1 || captured.length !== deviceCount || new Set(captured.map(boundary => JSON.stringify(boundary.browserProfile))).size !== deviceCount) throw new Error('Captured external boundaries disagree or have incomplete device coverage');
				const entries = manifest!.entries.filter(entry => entry.sourceUrl === url && entry.viewport === viewport && entry.state === state && (!profile || (entry.profile ?? entry.device) === profile));
				if (entries.length !== 1 || !entries[0]!.outcome || !entries[0]!.readiness.ready || entries[0]!.readiness.reasons.length) throw new Error('Source boundary observation missing, ambiguous or unready');
				const entry = entries[0]!;
				validateExternalBoundary(entry.outcome!, readReferenceArtifact(directory, entry.outcome!.evidence));
				const deviceBoundary = captured.find(boundary => JSON.stringify(boundary.browserProfile) === JSON.stringify(entry.outcome!.browserProfile));
				if (entry.outcome!.viewport !== viewport || entry.outcome!.requestedUrl !== url || boundaryIdentity(entry.outcome!) !== boundaryIdentity(captured[0]!) ||
					!deviceBoundary || JSON.stringify(entry.browserProfile) !== JSON.stringify(entry.outcome!.browserProfile) || entry.route || entry.observation || entry.screenshot || entry.document) throw new Error('Frozen external boundary identity mismatch');
				outcomes.push({sourceUrl: url, viewport, state, ...(profile ? {profile} : {}), kind: 'external-redirect'});
			} catch (error) { pending.push({stage, route: url, viewport, state, ...(profile ? {profile} : {}), reason: String(error)}); }
		}
	}
	let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
	let browser: Awaited<ReturnType<typeof import('playwright')['chromium']['launch']>> | undefined;
	// Cache the promise before yielding: parallel cells must not launch competing
	// servers/browsers. Keep startup lazy so wholly unproven scope needs neither.
	let resources: Promise<void> | undefined;
	const startResources = () => resources ??= ( async () => {
		server = await startStaticServer( websiteDir );
		browser = await ( await import( 'playwright' ) ).chromium.launch();
	} )();
	// Keep legacy evidence paths, including their last-writer semantics. Duplicate
	// caller selections or slug aliases are not independent evidence writers.
	const evidenceKeys = required.map( cell => JSON.stringify( [ evidenceSlug( cell.route ), cell.profile ? evidenceSlug( cell.profile ) : null, cell.viewport, cell.state ] ) );
	const poolSize = new Set( evidenceKeys ).size === evidenceKeys.length ? concurrency : 1;
	try {
		const cellResults = await mapPool( required, poolSize, async cell => {
			const { route, viewport, state, profile } = cell;
			const attribution = { stage, ...cell };
			let score: RouteScore | undefined;
			try {
				options.log?.( `[compare] ${ stage } ${ route } ${ profile ?? '' } @ ${ viewport }px ${ state }` );
				if ( invalid ) throw new Error( invalid );
				if ( ! manifest || ! sources.has( route ) ) throw new Error( 'Required route was not captured' );
				if ( state !== 'baseline' || ! manifest.scope.states.includes( state ) || ! manifest.scope.widths.includes( viewport ) ) throw new Error( 'Required viewport/state is outside frozen scope' );
				const entries = manifest.entries.filter( entry => entry.route === route && entry.sourceUrl === sources.get( route ) && entry.viewport === viewport && entry.state === state && ( profile === undefined || ( entry.profile ?? entry.device ) === profile ) );
				if ( entries.length !== 1 ) throw new Error( 'Source observation missing or ambiguous' );
				const frozen = readFrozenObservation( directory, entries[0]! );
				// Validate all source evidence even for materialization: stale evidence cannot certify a chain.
				await startResources();
				const entry = entries[ 0 ]!;
				if ( typeof entry.browserProfile?.isMobile !== 'boolean' || typeof entry.browserProfile?.hasTouch !== 'boolean' ) throw new Error( 'Source browser profile unproven' );
				const page = await browser!.newPage( {
					...replayBrowserIdentity( entry.context ?? {} ),
					viewport: { width: viewport, height: entry.viewportHeight },
					deviceScaleFactor: entry.deviceScaleFactor ?? 1,
					...( entry.userAgent ? { userAgent: entry.userAgent } : {} ),
					isMobile: entry.browserProfile.isMobile,
					hasTouch: entry.browserProfile.hasTouch,
					serviceWorkers: 'block',
				} );
				try {
					await page.addInitScript( observeViewportEntrances );
					// Portable replay cannot reach the origin, including redirects and media requests.
					const local = `${ server!.url }${ route }`;
					const candidate = stage === 'materialization' ? `${ candidateBase( options.candidateUrl! ) }${ route }` : local;
					await page.context().route( '**/*', async request => {
						const origin = new URL( request.request().url() ).origin;
						if ( origin === new URL( server!.url ).origin || ( stage === 'materialization' && origin !== new URL( manifest!.sourceUrl ).origin ) ) await request.continue();
						else await request.abort();
					} );
					let source = frozen.observation;
					let sourcePng = frozen.png;
					const deviceSelected = receipt.routes?.some( row => row.url === sources.get( route ) && row.documentSelection?.kind === 'device' );
					const sourceDocument = deviceSelected && entry.viewportMeta === undefined ? cheerio.load( readReferenceArtifact( directory, entry.document! ).toString() ) : undefined;
					let sourceViewport = entry.viewportMeta ?? sourceDocument?.( 'meta[name="viewport"]' ).attr( 'content' );
					const readViewport = () => page.evaluate( () => document.querySelector( 'meta[name="viewport"]' )?.getAttribute( 'content' ) ?? undefined );
					const measure = async ( url: string ): Promise<LayoutObservation> => {
						const response = await page.goto( url, { waitUntil: 'domcontentloaded' } );
						if ( response && ! response.ok() ) throw new Error( `Observation HTTP ${ response.status() }` );
						return observePage( page, url, viewport, options.settleMs ?? 800, new URL( url ).origin, undefined, undefined, true, false );
					};
					if ( stage === 'materialization' ) { source = await measure( local ); sourcePng = await captureViewportScreenshot( page ); sourceViewport = await readViewport(); }
					const liberated = await measure( candidate );
					if ( ambiguousRenderedImages( source.images, liberated.images ).length ) throw new Error( 'Repeated image correspondence ambiguous: structural role/state does not uniquely identify occurrences' );
					const evidenceDir = join( directory, 'compare', stage, evidenceSlug( route ), ...( profile ? [ evidenceSlug( profile ) ] : [] ), String( viewport ), state );
					const candidatePng = options.screenshots ? await captureViewportScreenshot( page ) : undefined;
					const checked = await runFidelityChecks( { ...attribution, sourceUrl: stage === 'capture' ? `frozen:${ entries[0]!.observation!.path }` : local, candidateUrl: candidate, source, candidate: liberated, evidenceDir } );
					// The foreign document is outside scope, but authored links to the
					// requested source route must retain their query/hash meaning in both stages.
					const boundaryUrls = new Set((receipt.sourceOutcomes ?? []).map(outcome => normalizedUrl(outcome.requestedUrl)));
					if (boundaryUrls.size) {
						const html = readReferenceArtifact(directory, entry.document!).toString();
						const $ = load(html);
						const documentUrl = new URL($('base[href]').first().attr('href') ?? entry.sourceUrl, entry.sourceUrl).href;
						const requiredLinks: string[] = [];
						$('a[href],area[href]').each((_index, element) => {
							try { const href = new URL($(element).attr('href')!, documentUrl); if (boundaryUrls.has(normalizedUrl(href.href))) requiredLinks.push(href.href); } catch { /* Non-network authored links have no boundary identity. */ }
						});
						const actual = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>('a[href],area[href]')].map(link => link.href));
						for (const href of requiredLinks) { const index = actual.indexOf(href); if (index < 0) checked.failures.push('Authored external-boundary source link meaning was lost'); else actual.splice(index, 1); }
					}
					if ( deviceSelected ) {
						const actualViewport = await readViewport();
						const directives = ( value: string | undefined ) => value?.split( ',' ).map( directive => directive.trim().toLowerCase() ).sort().join( ',' );
						if ( ! sourceViewport || directives( actualViewport ) !== directives( sourceViewport ) ) checked.failures.push( `source-selected viewport metadata differs: ${ actualViewport ?? 'absent' } !== ${ sourceViewport ?? 'unproven' }` );
					}
					if ( receipt.cleanup ) {
						const retained = await applySourceCleanup( page, receipt.cleanup.policy );
						if ( retained.removed || retained.residual || retained.failures.length ) checked.failures.push( 'Rendered artifact retains source attribution/advertising or cleanup audit failed' );
					}
					if ( candidatePng ) {
						const pixels = writePixelEvidence( evidenceDir, sourcePng, candidatePng );
						checked.notes.push( 'score' in pixels ? `pixel evidence → ${ pixels.diffPath }` : pixels.error );
					}
					score = { ...attribution, source, liberated, pass: ! checked.failures.length, failures: checked.failures, notes: checked.notes };
					return { score };
				} finally { await page.context().close(); }
			} catch ( error ) { return { score, pending: { ...attribution, reason: String( error ) } }; }
		} );
		// Publication is input-ordered, never completion-ordered. Every cell catches
		// its own failure, so the pool drains before shared resources are closed.
		for ( const result of cellResults ) {
			if ( result.score ) scores.push( result.score );
			if ( result.pending ) pending.push( result.pending );
		}
	} finally { try { await browser?.close(); } finally { await server?.close(); } }
	if ( ! routes.length || ! widths.length || ! states.length ) pending.push( { stage, route: '/', viewport: 0, state: 'baseline', reason: 'Empty required scope' } );
	const summary = scoreReport( scores );
	const pass = summary.pass && selfConsistency.pass && pending.length === 0;
	const profileCoverage = Object.fromEntries( [ ...new Set( [ ...required, ...pending, ...outcomes ].flatMap( cell => cell.profile ? [ cell.profile ] : [] ) ) ].map( profile => [ profile, {
		required: scores.filter( cell => cell.profile === profile ).length + pending.filter( cell => cell.profile === profile ).length + outcomes.filter( cell => cell.profile === profile ).length,
		measured: scores.filter( cell => cell.profile === profile ).length,
		pending: pending.filter( cell => cell.profile === profile ).length,
	} ] ) );
	const report: FidelityReport = { ...summary, pass, stage, status: pending.length ? 'unproven' : pass ? 'proven' : 'failed', pending,
		coverage: { required: required.length + missingRequired, measured: scores.length, observedOutcomes: outcomes.length, unknowns, profiles: profileCoverage }, outcomes,
		profiles: [ ...new Set( required.flatMap( cell => cell.profile ? [ cell.profile ] : [] ) ) ],
		sourceUrl: receipt.source?.url ?? '', websiteDir, widths, routes, routesAvailable: sources.size, routesCleanupUnproven: [], selfConsistency, scores, overlays: [] };
	mkdirSync( join( directory, 'compare', stage ), { recursive: true } );
	writeFileSync( join( directory, 'compare', stage, 'report.json' ), `${ JSON.stringify( report, null, 2 ) }\n` );
	return report;
}
