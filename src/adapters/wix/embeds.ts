// src/adapters/wix/embeds.ts
//
// Wix iframes that only work inside Wix's own viewer.
//
// Capture keeps every visible HTTPS iframe with its `src`, which is right for a
// YouTube video or a Wix HTML embed (`*.filesusr.com/html/...`): those are
// public documents that load anywhere. Two Wix iframe kinds are not:
//
// - The Google Maps element embeds Wix's own wrapper page
//   (`static.parastorage.com/.../googleMap.<hash>.html`). The wrapper's URL has
//   no location; the viewer posts the locations to it after load. Outside Wix
//   nothing posts them and the copy shows a blank box.
// - App Market widgets load from the app vendor with a signed `instance` token
//   and talk to the viewer through the Wix SDK. Outside Wix they answer with
//   Wix's "App Unavailable" page, and the token (which carries the owner's site
//   and account ids) would be published with the copy.
//
// Some App Market map widgets (Wix Events' venue map) are app iframes too,
// but their URL already names the location (`lat`/`lng` query parameters), so
// they are pointed at a Google Maps embed rather than replaced by a note.
// Wix FAQ's app frame renders its questions and answers as plain content, so
// they are carried as native `<details>` disclosures rather than a note.
//
// While the live page still has its runtime, a map is pointed at an ordinary
// Google Maps embed of the location the wrapper drew, and an app widget is
// replaced by a visible note the same size, so the gap is honest, not white.

import * as cheerio from 'cheerio';
import type { Element as ParsedElement } from 'domhandler';
import type { ElementHandle, Frame, Page, Request, Response } from 'playwright';
import { PANEL_REPLAY_ATTRIBUTES, rewritePanelReplayHtml } from '../../lib/panel-replay-state.js';

/** Marks a Wix embed that was ported to portable content (a Google Maps embed, FAQ disclosures). */
export const WIX_PORTED_EMBED_ATTRIBUTE = 'data-blocks-engine-capture-ported-embed';
/** Marks the note left where a Wix-only widget could not be copied. */
export const WIX_UNPORTED_EMBED_ATTRIBUTE = 'data-blocks-engine-capture-unported-embed';

/** Wix mounts its site-wide chat widgets in viewport-pinned layers; source cleanup removes them. */
// The assistant opens itself a few seconds after load and can be minimized to
// a launcher; either state is the same provider service.
export const WIX_AI_ASSISTANT_LAYER = '#pinnedBottomLeft > [id$="-pinned-layer"]:has([data-hook="AiAssistantWidgetContainer"], [data-hook="minimizedChat"])';
export const WIX_CHAT_LAUNCHER_LAYER = '#pinnedBottomRight > [id$="-pinned-layer"]:has(iframe[title*="chat" i])';
const WIX_PINNED_CHAT_SELECTOR = `${ WIX_AI_ASSISTANT_LAYER }, ${ WIX_CHAT_LAUNCHER_LAYER }`;

const MAP_LOCATION_WAIT_MILLISECONDS = 5_000;
const MAP_EMBED_LOAD_MILLISECONDS = 5_000;
const EVENT_MAP_MOUNT_MILLISECONDS = 8_000;
/**
 * One budget per call for every Wix FAQ frame on the page: the frame queries
 * its server for the questions after it loads, in pages.
 */
const FAQ_RENDER_MILLISECONDS = 8_000;
const FAQ_POLL_MILLISECONDS = 250;
/**
 * After the last FAQ frame settles, how long to keep watching for Wix
 * mounting, revealing or replacing a frame before leaving early. The full
 * render budget stays the ceiling for frames still pending.
 */
const FAQ_GRACE_MILLISECONDS = 500;
const WIX_FAQ_QUERY_PATH = /\/_api\/faq-server\/v\d+\/question-entries\/query$/;
/** Bounds on what a frame's answer tree may carry before it is refused outright. */
const FAQ_LIMITS = { nodes: 5_000, depth: 24, text: 20_000, question: 500, href: 2_048 };

/** Wix FAQ, the App Market app whose widget frame renders the site's questions and answers. */
export const WIX_FAQ_APP_DEF_ID = '14c92d28-031e-7910-c9a8-a670011e062d';

/** Elements an answer keeps; anything else is unwrapped to its children, or dropped with them. */
const FAQ_KEPT_TAGS = new Set( [ 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre' ] );
const FAQ_DROPPED_TAGS = new Set( [ 'script', 'style', 'template', 'svg', 'button', 'iframe', 'noscript', 'object', 'embed' ] );
const FAQ_LINK_PROTOCOLS = new Set( [ 'http:', 'https:' ] );

/** A validated answer node: text, or an allowlisted element with an optional absolute link. */
export type WixFaqNode = { text: string } | { tag: string; href?: string; children: WixFaqNode[] };

export interface WixFaqItem {
	question: string;
	answer: WixFaqNode[];
	open: boolean;
}

/** The note's look; its size comes from the box it replaces. */
const NOTE_STYLE = [
	'box-sizing:border-box',
	'width:100%',
	'display:flex',
	'align-items:center',
	'justify-content:center',
	'padding:12px',
	'border:1px dashed rgba(0,0,0,.35)',
	'background:rgba(0,0,0,.03)',
	'color:inherit',
	'text-align:center',
	'font-size:14px',
	'line-height:1.4',
];

/**
 * Wix Events' venue map on an event details page. Its widget renders the host
 * server-side but mounts the map itself in an effect after the widget's
 * deferred hydration (about five seconds after `load` in Chromium, whatever
 * the page does meanwhile): the desktop host `<div data-hook="map">` then
 * gains an app map iframe, and the phone `<img data-hook="map">` (inside a
 * Google Maps search link) gains a static-map `src` it fetches from the events
 * server. Until then the host is an empty box or a source-less image.
 */
export const WIX_EVENT_MAP_SELECTOR = '#event-details-page-map[data-hook="map"]';

export interface MapView {
	lat: number;
	lng: number;
	zoom?: number;
}

/** The note shown where a Wix-only widget was. */
export function wixEmbedNote( name?: string ): string {
	const label = ( name ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 80 );
	return label
		? `This widget (${ label }) was a Wix embed and couldn’t be copied.`
		: 'This widget was a Wix embed and couldn’t be copied.';
}

function parseUrl( value: string, base?: string ): URL | null {
	try {
		return new URL( value, base );
	} catch {
		return null;
	}
}

/** Wix's Google Maps wrapper page, which only draws a map when the Wix viewer posts it locations. */
export function isWixGoogleMapFrame( src: string, base?: string ): boolean {
	const url = parseUrl( src, base );
	return (
		url !== null &&
		url.protocol === 'https:' &&
		url.hostname === 'static.parastorage.com' &&
		/\/googleMap(?:\.[\w-]+)?\.html$/.test( url.pathname )
	);
}

/**
 * The App Market app a Wix widget iframe belongs to, recognised by the signed
 * `instance` token every app widget is loaded with: `<signature>.<base64 JSON>`
 * whose payload names the app (`appDefId`). Null for any other iframe.
 */
export function wixAppInstance( src: string, base?: string ): { appDefId: string } | null {
	return signedWixInstance( parseUrl( src, base )?.searchParams.get( 'instance' ) ?? '' );
}

/** The app a signed Wix `instance` value (`signature.base64url(JSON)`) names, if it is one. */
function signedWixInstance( instance: string ): { appDefId: string } | null {
	const match = /^[\w-]+\.([\w-]+)$/.exec( instance.trim() );
	if ( ! match ) return null;
	try {
		const payload: unknown = JSON.parse(
			Buffer.from( match[ 1 ].replace( /-/g, '+' ).replace( /_/g, '/' ), 'base64' ).toString( 'utf8' )
		);
		const appDefId = ( payload as { appDefId?: unknown } | null )?.appDefId;
		return typeof appDefId === 'string' && /^[\w-]{8,64}$/.test( appDefId ) ? { appDefId } : null;
	} catch {
		return null;
	}
}

/**
 * The location an App Market map widget names in its own URL: an app iframe
 * whose path is a map page and whose query carries `lat` and `lng`
 * (Wix Events: `events.wixapps.net/events-server/html/google-map-v2?lat=..&lng=..`).
 */
export function wixAppMapView( src: string, base?: string ): MapView | null {
	const url = parseUrl( src, base );
	if ( ! url || ! wixAppInstance( src, base ) || ! /map/i.test( url.pathname ) ) return null;
	const coordinate = ( name: string ) => {
		const value = url.searchParams.get( name ) ?? '';
		return /^-?\d+(?:\.\d+)?$/.test( value ) ? Number( value ) : Number.NaN;
	};
	const zoom = coordinate( 'zoom' );
	return validMapView( { lat: coordinate( 'lat' ), lng: coordinate( 'lng' ), ...( Number.isFinite( zoom ) ? { zoom } : {} ) } );
}

/** Read a map view from Google's own "Open this area in Google Maps" link (`maps?ll=<lat>,<lng>&z=<zoom>`). */
export function googleMapsViewFromLink( href: string ): MapView | null {
	const url = parseUrl( href );
	if ( ! url || ! /(^|\.)google\.[a-z.]+$/.test( url.hostname ) ) return null;
	const [ lat, lng ] = ( url.searchParams.get( 'll' ) ?? '' ).split( ',' ).map( Number );
	const zoom = Number( url.searchParams.get( 'z' ) ?? '' );
	return validMapView( { lat, lng, ...( Number.isFinite( zoom ) && zoom > 0 ? { zoom } : {} ) } );
}

function validMapView( view: Partial< MapView > | null | undefined ): MapView | null {
	const { lat, lng, zoom } = view ?? {};
	if ( typeof lat !== 'number' || typeof lng !== 'number' ) return null;
	if ( ! Number.isFinite( lat ) || ! Number.isFinite( lng ) || Math.abs( lat ) > 90 || Math.abs( lng ) > 180 ) return null;
	if ( lat === 0 && lng === 0 ) return null;
	const z = typeof zoom === 'number' && Number.isFinite( zoom ) ? Math.min( 21, Math.max( 1, Math.round( zoom ) ) ) : undefined;
	return { lat, lng, ...( z ? { zoom: z } : {} ) };
}

/** Read a location from a Google Maps search link (`maps/search/?api=1&query=<lat>,<lng>`). */
export function googleMapsViewFromSearchLink( href: string ): MapView | null {
	const url = parseUrl( href );
	if ( ! url || ! /(^|\.)google\.[a-z.]+$/.test( url.hostname ) || ! /^\/maps\/search\/?$/.test( url.pathname ) ) return null;
	const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec( url.searchParams.get( 'query' ) ?? '' );
	return match ? validMapView( { lat: Number( match[ 1 ] ), lng: Number( match[ 2 ] ) } ) : null;
}

/**
 * The venue of the one event a Wix page's warmup data describes: the
 * `location.coordinates` of an event record. Null unless every event record
 * in the payload names the same location, so a page listing several events
 * never borrows another event's venue.
 */
export function wixEventVenueView( warmupData: string ): MapView | null {
	let root: unknown;
	try {
		root = JSON.parse( warmupData );
	} catch {
		return null;
	}
	const found = new Map< string, MapView >();
	const seen = new Set< object >();
	const walk = ( node: unknown, depth: number ) => {
		if ( ! node || typeof node !== 'object' || depth > 40 || seen.has( node ) ) return;
		seen.add( node );
		if ( Array.isArray( node ) ) {
			for ( const item of node ) walk( item, depth + 1 );
			return;
		}
		const record = node as { id?: unknown; location?: { coordinates?: { lat?: unknown; lng?: unknown } } };
		const coordinates = record.location?.coordinates;
		if ( typeof record.id === 'string' && coordinates && typeof coordinates.lat === 'number' && typeof coordinates.lng === 'number' ) {
			const view = validMapView( { lat: coordinates.lat, lng: coordinates.lng } );
			if ( view ) found.set( `${ view.lat },${ view.lng }`, view );
		}
		for ( const value of Object.values( node ) ) walk( value, depth + 1 );
	};
	walk( root, 0 );
	return found.size === 1 ? [ ...found.values() ][ 0 ] : null;
}

/** A keyless Google Maps embed of one location, which loads in any page. */
export function googleMapsEmbedUrl( view: MapView, language?: string ): string | null {
	const valid = validMapView( view );
	if ( ! valid ) return null;
	const round = ( value: number ) => Number( value.toFixed( 6 ) );
	const url = new URL( 'https://maps.google.com/maps' );
	url.searchParams.set( 'q', `${ round( valid.lat ) },${ round( valid.lng ) }` );
	url.searchParams.set( 'z', String( valid.zoom ?? 15 ) );
	if ( language && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test( language ) ) url.searchParams.set( 'hl', language );
	url.searchParams.set( 'output', 'embed' );
	return url.href;
}

/**
 * Runs inside Wix's map wrapper. The wrapper keeps the map and its markers on
 * `window`; the first marker is the owner's location, the zoom is the map's.
 * Without those, Google's own view link carries the centre and zoom.
 *
 * Known limit: a keyless Google Maps embed shows one pin, so a Wix map with
 * several locations keeps only its first marker. The others are not carried.
 */
function readWixMapView(): { lat?: number; lng?: number; zoom?: number; link?: string } | null {
	const scope = window as unknown as Record< string, unknown >;
	const value = ( input: unknown ): unknown => ( typeof input === 'function' ? ( input as () => unknown )() : input );
	const point = ( input: unknown ): { lat?: number; lng?: number } | null => {
		if ( ! input || typeof input !== 'object' ) return null;
		const candidate = input as { lat?: unknown; lng?: unknown };
		try {
			const lat = Number( typeof candidate.lat === 'function' ? candidate.lat.call( input ) : candidate.lat );
			const lng = Number( typeof candidate.lng === 'function' ? candidate.lng.call( input ) : candidate.lng );
			return { lat, lng };
		} catch {
			return null;
		}
	};
	const markers = scope.googleMapsMarkerInstances;
	const list = Array.isArray( markers ) ? markers : markers && typeof markers === 'object' ? Object.values( markers ) : [];
	const marker = list[ 0 ] as { getPosition?: () => unknown; position?: unknown } | undefined;
	const map = scope.googleMapsInstance as { getZoom?: () => unknown; getCenter?: () => unknown } | undefined;
	let position: unknown;
	let zoom: unknown;
	try {
		position = marker ? ( typeof marker.getPosition === 'function' ? marker.getPosition() : value( marker.position ) ) : undefined;
		if ( ! position && map && typeof map.getCenter === 'function' ) position = map.getCenter();
		zoom = map && typeof map.getZoom === 'function' ? map.getZoom() : undefined;
	} catch {
		position = undefined;
	}
	const located = point( position );
	if ( located && Number.isFinite( located.lat ) && Number.isFinite( located.lng ) ) {
		return { lat: located.lat, lng: located.lng, ...( typeof zoom === 'number' ? { zoom } : {} ) };
	}
	const link = [ ...document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ]
		.map( ( anchor ) => anchor.href )
		.find( ( href ) => /[?&]ll=-?\d/.test( href ) );
	return link ? { link } : null;
}

/** `until` caps the wait at an absolute time, so a caller's own deadline holds. */
async function wixMapView( frame: Frame, until = Infinity ): Promise< MapView | null > {
	const deadline = Math.min( Date.now() + MAP_LOCATION_WAIT_MILLISECONDS, until );
	for ( ;; ) {
		const read = await frame.evaluate( readWixMapView ).catch( () => null );
		const view = read?.link ? googleMapsViewFromLink( read.link ) : validMapView( read );
		if ( view ) return view;
		if ( Date.now() >= deadline ) return null;
		await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
	}
}

/** Runs in the page: swap an iframe for a visible note of the same size. */
function installWixEmbedNote( frame: Element, args: { note: string; attribute: string; style: string[]; sizedByHost?: boolean } ): void {
	// A custom element's Wix host owns its box; the element itself may be an
	// empty inline placeholder until the vendor script renders into it.
	const bounds = ( args.sizedByHost && frame.parentElement ? frame.parentElement : frame ).getBoundingClientRect();
	if ( bounds.width <= 0 || bounds.height <= 0 ) {
		// Invisible here (another viewport's copy, a collapsed panel): nothing
		// would show, and capture drops hidden iframes anyway. Do not keep the token.
		frame.remove();
		return;
	}
	const note = document.createElement( 'div' );
	note.setAttribute( args.attribute, 'wix' );
	note.setAttribute( 'role', 'note' );
	const font = getComputedStyle( frame.parentElement ?? document.body ).fontFamily;
	note.style.cssText = [ ...args.style, `max-width:${ Math.round( bounds.width ) }px`, `min-height:${ Math.round( bounds.height ) }px` ].join( ';' );
	if ( font ) note.style.fontFamily = font;
	note.textContent = args.note;
	frame.replaceWith( note );
}

async function pointAtGoogleMap( handle: ElementHandle< Element >, embed: string, until = Infinity ): Promise< void > {
	// Playwright reads a zero timeout as none at all, so a passed deadline waits one millisecond.
	const timeout = Math.max( 1, Math.min( MAP_EMBED_LOAD_MILLISECONDS, until - Date.now() ) );
	const loaded = handle
		.contentFrame()
		.then( ( frame ) => frame?.waitForURL( ( url ) => url.href === embed, { waitUntil: 'load', timeout } ) )
		.catch( () => undefined );
	await handle.evaluate(
		( frame, args ) => {
			frame.setAttribute( 'src', args.embed );
			frame.setAttribute( args.attribute, 'wix-google-map' );
			frame.removeAttribute( 'data-src' );
		},
		{ embed, attribute: WIX_PORTED_EMBED_ATTRIBUTE }
	);
	// Let the reference screenshot show the map; the copy depends only on `src`.
	await loaded;
}

/**
 * Runs in the Wix FAQ frame and returns plain data, never markup: the frame's
 * script owns this realm and its DOM, so whatever comes back is validated in
 * Node (`wixFaqItems`) before anything is built in the page. Self-contained,
 * because a frame that navigated has lost the page's `__name` helper.
 */
function readWixFaqFrame(): unknown {
	const scope = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof scope.__name === 'undefined' ) scope.__name = ( fn ) => fn;
	const root = document.querySelector( '[data-hook="faq-root"]' );
	if ( ! root ) return { layout: 'pending', items: [] };
	// Category tabs render one category at a time: the rest is not on the page.
	if ( root.querySelector( '[data-hook="faq-tabs"], [role="tablist"]' ) ) return { layout: 'unsupported', items: [] };
	const headers = [ ...root.querySelectorAll( '[data-hook="accordion-item-header"]' ) ];
	if ( headers.some( ( header ) => ! header.closest( '[data-hook="widget-accordion-wrapper"]' ) ) ) return { layout: 'unsupported', items: [] };
	const tree = ( node: Node ): unknown => node.nodeType === Node.TEXT_NODE
		? { text: node.textContent ?? '' }
		: node instanceof Element
			? { tag: node.localName, href: node.getAttribute( 'href' ) ?? undefined, children: [ ...node.childNodes ].map( tree ) }
			: { text: '' };
	return {
		layout: 'accordion',
		items: headers.map( ( header ) => {
			const panel = document.getElementById( header.getAttribute( 'aria-controls' ) ?? '' );
			return {
				question: ( header.querySelector( '[data-hook="title"]' ) ?? header ).textContent ?? '',
				open: header.getAttribute( 'aria-expanded' ) === 'true',
				answer: panel ? [ ...panel.childNodes ].map( tree ) : null,
			};
		} ),
	};
}

/**
 * Validate what a FAQ frame returned. Items when every question has a
 * non-empty answer; `pending` while the frame may still be rendering;
 * `unsupported` for a layout this cannot carry whole or a tree over the
 * limits. Only allowlisted tags and absolute http(s)/mailto/tel links survive.
 */
export function wixFaqItems( raw: unknown ): WixFaqItem[] | 'pending' | 'unsupported' {
	const read = raw as { layout?: unknown; items?: unknown } | null;
	if ( ! read || typeof read !== 'object' ) return 'pending';
	if ( read.layout === 'unsupported' ) return 'unsupported';
	if ( read.layout !== 'accordion' || ! Array.isArray( read.items ) || ! read.items.length ) return 'pending';
	const budget = { nodes: FAQ_LIMITS.nodes };
	const nodes = ( input: unknown, depth: number ): WixFaqNode[] | null => {
		if ( ! Array.isArray( input ) || depth > FAQ_LIMITS.depth ) return null;
		const out: WixFaqNode[] = [];
		for ( const node of input as unknown[] ) {
			if ( --budget.nodes < 0 || ! node || typeof node !== 'object' ) return null;
			const { text, tag, href, children } = node as { text?: unknown; tag?: unknown; href?: unknown; children?: unknown };
			if ( typeof text === 'string' ) {
				if ( text.length > FAQ_LIMITS.text ) return null;
				if ( text ) out.push( { text } );
				continue;
			}
			if ( typeof tag !== 'string' ) return null;
			if ( FAQ_DROPPED_TAGS.has( tag ) ) continue;
			const inner = nodes( children ?? [], depth + 1 );
			if ( ! inner ) return null;
			const link = tag === 'a' ? faqLink( href ) : undefined;
			if ( ! FAQ_KEPT_TAGS.has( tag ) || ( tag === 'a' && ! link ) ) out.push( ...inner );
			else out.push( { tag, ...( link ? { href: link } : {} ), children: inner } );
		}
		return out;
	};
	const hasText = ( list: WixFaqNode[] ): boolean => list.some( ( node ) => 'text' in node ? node.text.trim() !== '' : hasText( node.children ) );
	const items: WixFaqItem[] = [];
	for ( const item of read.items as unknown[] ) {
		const { question, open, answer } = ( item ?? {} ) as { question?: unknown; open?: unknown; answer?: unknown };
		const title = typeof question === 'string' ? question.replace( /\s+/g, ' ' ).trim() : '';
		if ( ! title || title.length > FAQ_LIMITS.question ) return 'pending';
		// A question whose answer has not rendered would export as a disclosure that opens empty.
		if ( answer === null ) return 'pending';
		const body = nodes( answer, 0 );
		if ( ! body ) return 'unsupported';
		if ( ! hasText( body ) ) return 'pending';
		items.push( { question: title, open: open === true, answer: body } );
	}
	return items;
}

/** An absolute link the copy can keep. The frame is the app host's, so a relative link would point there, not at the site. */
function faqLink( href: unknown ): string | undefined {
	if ( typeof href !== 'string' || href.length > FAQ_LIMITS.href ) return undefined;
	try {
		const url = new URL( href );
		// An answer can link to an app page by its signed address: only a plain
		// http(s) address whose every query and fragment field decodes cleanly and
		// carries no credential keeps its address; otherwise the text stays alone.
		return FAQ_LINK_PROTOCOLS.has( url.protocol ) && plainLinkAddress( url ) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs in the page: swap the FAQ frame for its questions as native
 * disclosures, built only with createElement, textContent and setAttribute.
 * False when the frame is gone (Wix replaced it) and nothing was installed.
 */
function installWixFaq( frame: Element, args: { items: WixFaqItem[]; attribute: string } ): boolean {
	if ( ! frame.isConnected ) return false;
	const bounds = frame.getBoundingClientRect();
	const build = ( parent: Element, list: WixFaqNode[] ) => {
		for ( const node of list ) {
			if ( 'text' in node ) {
				parent.append( document.createTextNode( node.text ) );
				continue;
			}
			const element = document.createElement( node.tag );
			if ( node.href ) element.setAttribute( 'href', node.href );
			build( element, node.children );
			parent.append( element );
		}
	};
	const faq = document.createElement( 'div' );
	faq.setAttribute( args.attribute, 'wix-faq' );
	faq.style.cssText = `box-sizing:border-box;width:100%;max-width:${ Math.round( bounds.width ) }px`;
	const font = getComputedStyle( frame.parentElement ?? document.body ).fontFamily;
	if ( font ) faq.style.fontFamily = font;
	for ( const item of args.items ) {
		const details = document.createElement( 'details' );
		details.open = item.open;
		const summary = document.createElement( 'summary' );
		summary.textContent = item.question;
		const answer = document.createElement( 'div' );
		build( answer, item.answer );
		details.append( summary, answer );
		faq.append( details );
	}
	frame.replaceWith( faq );
	return true;
}

/**
 * Runs in the page: whether a frame paints, by the same test the serializer
 * uses to keep a frame's visual evidence (a box, and visible by
 * `display`, `visibility` and `opacity`). Wix keeps an app frame hidden until
 * it has loaded, so this is asked again on every read rather than once.
 */
function framePaints( frame: Element ): boolean {
	const bounds = frame.getBoundingClientRect();
	return bounds.width > 0 && bounds.height > 0 && frame.checkVisibility( { checkOpacity: true, checkVisibilityCSS: true } );
}

/** Runs in the page: a stable per-element number, kept as a property so it is never serialized. */
function frameKey( frame: Element ): number {
	const scope = window as unknown as { blocksEngineWixFrameKeys?: number };
	const element = frame as Element & { blocksEngineWixFrameKey?: number };
	element.blocksEngineWixFrameKey ??= ( scope.blocksEngineWixFrameKeys = ( scope.blocksEngineWixFrameKeys ?? 0 ) + 1 );
	return element.blocksEngineWixFrameKey;
}

/**
 * What a FAQ frame's question queries have established. `total` is the
 * question count of the latest clean, complete cursor chain, or `null` when
 * there is none or anything since made it uncertain; `chains` holds the
 * running totals of chains still paging, by the cursor their next page will
 * be asked with (`null` once that cursor is ambiguous); `inFlight` the
 * queries not answered yet. A frame is countable only with a total and
 * nothing in flight.
 */
interface FaqQueryState {
	total: number | null;
	chains: Map< string, number | null >;
	inFlight: Set< Request >;
	lastSequence: number;
}
interface FaqQueryTracker {
	frames: Map< Frame, FaqQueryState >;
	/** Bumped when a frame navigates, so answers to the previous document's queries are ignored. */
	generations: WeakMap< Frame, number >;
	requests: WeakMap< Request, { generation: number; sequence: number } >;
	sequence: number;
}
const faqQueryTrackers = new WeakMap< Page, FaqQueryTracker >();
/** A question page larger than this is not read; the frame then has no total and gets the note. */
const FAQ_QUERY_BYTES = 2_000_000;

/** The paging cursor a question query asks with (`query.cursorPaging.cursor`), if it continues a chain. */
function queryCursor( postData: string | null ): string | undefined {
	try {
		const cursor = ( JSON.parse( postData ?? '' ) as { query?: { cursorPaging?: { cursor?: unknown } }; cursor?: unknown } | null );
		const value = cursor?.query?.cursorPaging?.cursor ?? cursor?.cursor;
		return typeof value === 'string' && value ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The questions a frame's queries counted, when that count is certain and no query is still out. */
export function wixFaqQueryTotal( state: FaqQueryState | undefined ): number | null {
	return state && ! state.inFlight.size ? state.total : null;
}

/**
 * Follow the FAQ app's own completion signal. A question query answers with
 * one page of `questionEntries` and `pagingMetadata` (`hasNext`, and
 * `cursors.next` to ask for the next page with); a chain started without a
 * cursor and followed to `hasNext: false` gives the total. Anything that
 * makes the count uncertain clears it, and the frame then gets the note:
 * a failed or oversized answer, a page whose `count` disagrees with its
 * entries, a reused cursor, a page from a chain begun before tracking,
 * answers arriving out of order, or another query still out when a chain
 * completes. State is per frame document: a frame that navigates or detaches
 * starts over. Installed before navigation (the adapter's `initScript`), so a
 * frame's startup queries are seen; idempotent per page.
 */
export function trackWixFaqQueries( page: Page ): Map< Frame, FaqQueryState > {
	const existing = faqQueryTrackers.get( page );
	if ( existing ) return existing.frames;
	const tracker: FaqQueryTracker = { frames: new Map(), generations: new WeakMap(), requests: new WeakMap(), sequence: 0 };
	faqQueryTrackers.set( page, tracker );
	const isQuery = ( address: string ) => {
		try {
			return WIX_FAQ_QUERY_PATH.test( new URL( address ).pathname );
		} catch {
			return false;
		}
	};
	const stateOf = ( frame: Frame ) => {
		let state = tracker.frames.get( frame );
		if ( ! state ) tracker.frames.set( frame, state = { total: null, chains: new Map(), inFlight: new Set(), lastSequence: 0 } );
		return state;
	};
	const frameOf = ( request: Request ) => {
		try {
			return request.frame();
		} catch {
			return null; // A service worker request has no frame.
		}
	};
	const forget = ( frame: Frame ) => {
		tracker.frames.delete( frame );
		tracker.generations.set( frame, ( tracker.generations.get( frame ) ?? 0 ) + 1 );
	};
	page.on( 'framenavigated', ( frame ) => {
		if ( frame !== page.mainFrame() ) forget( frame );
	} );
	page.on( 'framedetached', forget );
	page.on( 'request', ( request: Request ) => {
		const frame = isQuery( request.url() ) ? frameOf( request ) : null;
		if ( ! frame ) return;
		tracker.requests.set( request, { generation: tracker.generations.get( frame ) ?? 0, sequence: ++tracker.sequence } );
		stateOf( frame ).inFlight.add( request );
	} );
	page.on( 'requestfailed', ( request: Request ) => {
		const frame = isQuery( request.url() ) ? frameOf( request ) : null;
		const state = frame ? tracker.frames.get( frame ) : undefined;
		if ( ! state || ! state.inFlight.delete( request ) ) return;
		state.total = null;
	} );
	page.on( 'response', ( response: Response ) => {
		const request = response.request();
		const frame = isQuery( response.url() ) ? frameOf( request ) : null;
		if ( ! frame ) return;
		// A query sent before tracking began belongs to the document the frame had then.
		const { generation, sequence } = tracker.requests.get( request ) ?? { generation: 0, sequence: 0 };
		const current = () => generation === ( tracker.generations.get( frame ) ?? 0 ) && ! frame.isDetached();
		if ( ! current() ) return;
		const cursor = queryCursor( request.postData() );
		const size = Number( response.headers()[ 'content-length' ] ?? 0 );
		const body = response.ok() && ! ( size > FAQ_QUERY_BYTES ) ? response.json().catch( () => null ) : Promise.resolve( null );
		void body.then( ( answer ) => {
			if ( ! current() ) return;
			const state = stateOf( frame );
			state.inFlight.delete( request );
			const uncertain = () => {
				state.total = null;
				if ( cursor !== undefined && state.chains.has( cursor ) ) state.chains.set( cursor, null );
			};
			// Answers arriving out of order (or from before tracking) can't be placed in a chain.
			if ( sequence <= state.lastSequence ) return uncertain();
			state.lastSequence = sequence;
			const { questionEntries, pagingMetadata } = ( answer ?? {} ) as { questionEntries?: unknown; pagingMetadata?: { hasNext?: unknown; count?: unknown; cursors?: { next?: unknown } } };
			if ( ! Array.isArray( questionEntries ) || typeof pagingMetadata?.hasNext !== 'boolean' ) return uncertain();
			if ( pagingMetadata.count !== undefined && pagingMetadata.count !== questionEntries.length ) return uncertain();
			const before = cursor === undefined ? 0 : state.chains.get( cursor );
			if ( cursor !== undefined ) state.chains.delete( cursor );
			if ( before === undefined || before === null ) return uncertain();
			const sum = before + questionEntries.length;
			if ( pagingMetadata.hasNext ) {
				// A newer chain is under way: an earlier total no longer stands.
				state.total = null;
				const next = pagingMetadata.cursors?.next;
				if ( typeof next !== 'string' || ! next ) return;
				// A cursor handed out twice can't say which chain its page belongs to.
				state.chains.set( next, state.chains.has( next ) ? null : sum );
				// The app re-queries while on screen; probes it never follows up must not pile up.
				if ( state.chains.size > 32 ) state.chains.delete( state.chains.keys().next().value! );
				return;
			}
			state.total = state.inFlight.size ? null : sum;
		} );
	} );
	return tracker.frames;
}

/**
 * Read one Wix FAQ frame and port it once its questions are complete: the
 * app's latest complete query chain named a total and that many questions
 * have rendered, every question has an answer, the frame paints,
 * and two reads in a row agree. `pending` frames are read again until the
 * deadline, then get the note; `settled` ones need nothing more.
 */
async function stepWixFaqFrame(
	handle: ElementHandle< Element >,
	seen: Map< number, string >,
	queries: Map< Frame, FaqQueryState >
): Promise< { key: number; paints: boolean; state: 'ported' | 'pending' | 'settled' } > {
	const key = await handle.evaluate( frameKey ).catch( () => 0 );
	if ( ! key || ! await handle.evaluate( ( frame ) => frame.isConnected ).catch( () => false ) ) return { key, paints: false, state: 'settled' };
	// Re-resolved on every read: the frame can navigate while it loads.
	const frame = await handle.contentFrame().catch( () => null );
	const items = wixFaqItems( frame ? await frame.evaluate( readWixFaqFrame ).catch( () => null ) : null );
	const paints = await handle.evaluate( framePaints ).catch( () => false );
	if ( items === 'unsupported' ) return { key, paints, state: 'settled' };
	const total = frame ? wixFaqQueryTotal( queries.get( frame ) ) : null;
	if ( ! Array.isArray( items ) || ! paints || total === null || items.length < total ) {
		seen.delete( key );
		return { key, paints, state: 'pending' };
	}
	const signature = JSON.stringify( items );
	if ( seen.get( key ) !== signature ) {
		seen.set( key, signature );
		return { key, paints, state: 'pending' };
	}
	const ported = await handle.evaluate( installWixFaq, { items, attribute: WIX_PORTED_EMBED_ATTRIBUTE } ).catch( () => false );
	return { key, paints, state: ported ? 'ported' : 'pending' };
}

/**
 * Runs in the page: replace each App Market frame that paints (one whose
 * `src` carries a signed `instance` naming an `appDefId`) with the note, so
 * the page shows an honest gap from here on. Frames that do not paint are
 * left for the serialized-HTML seal (`sealWixAppFrameHtml`), which decides
 * on the document as it is saved. Pinned chat layers are left to source
 * cleanup, which removes them whole.
 */
function noteWixAppFrames( args: { attribute: string; pinned: string; named: string; plain: string; style: string[] } ): void {
	const scope = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof scope.__name === 'undefined' ) scope.__name = ( fn ) => fn;
	const appFrame = ( frame: Element ) => {
		try {
			const instance = new URL( frame.getAttribute( 'src' ) ?? '', location.href ).searchParams.get( 'instance' ) ?? '';
			const match = /^[\w-]+\.([\w-]+)$/.exec( instance );
			if ( ! match ) return false;
			const payload = JSON.parse( atob( match[ 1 ].replace( /-/g, '+' ).replace( /_/g, '/' ) ) ) as { appDefId?: unknown } | null;
			return typeof payload?.appDefId === 'string' && /^[\w-]{8,64}$/.test( payload.appDefId );
		} catch {
			return false;
		}
	};
	for ( const frame of document.querySelectorAll( 'iframe[src]' ) ) {
		if ( frame.closest( args.pinned ) || ! appFrame( frame ) ) continue;
		const bounds = frame.getBoundingClientRect();
		if ( ! ( bounds.width > 0 && bounds.height > 0 && frame.checkVisibility( { checkOpacity: true, checkVisibilityCSS: true } ) ) ) continue;
		const label = ( frame.getAttribute( 'title' ) ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 80 );
		const note = document.createElement( 'div' );
		note.setAttribute( args.attribute, 'wix' );
		note.setAttribute( 'role', 'note' );
		note.style.cssText = [ ...args.style, `max-width:${ Math.round( bounds.width ) }px`, `min-height:${ Math.round( bounds.height ) }px` ].join( ';' );
		const font = getComputedStyle( frame.parentElement ?? document.body ).fontFamily;
		if ( font ) note.style.fontFamily = font;
		note.textContent = label ? args.named.replace( '\u0000', label ) : args.plain;
		frame.replaceWith( note );
	}
}

const VISUAL_IFRAME_SRC = 'data-blocks-engine-capture-visual-iframe-src';
const VISUAL_IFRAME_WIDTH = 'data-blocks-engine-capture-visual-iframe-width';
const VISUAL_IFRAME_HEIGHT = 'data-blocks-engine-capture-visual-iframe-height';
/** Hosts that serve Wix app frames; an `instance` credential on one is sealed even when it is not a decodable signed token. */
const WIX_APP_FRAME_HOST = /(?:^|\.)(?:wixapps\.net|wix\.com|wixsite\.com|wixstudio\.com|editorx\.io|parastorage\.com)$/i;
/**
 * Stands in for the document URL a saved string does not carry. A relative
 * address resolves to it, and since the real host is unknown it is treated as
 * a Wix host.
 */
const UNKNOWN_DOCUMENT = 'https://document.invalid/';
const UNKNOWN_HOST = new URL( UNKNOWN_DOCUMENT ).hostname;
/** How many nested `srcdoc` or panel replay levels are sealed; anything deeper is removed, not passed through. */
const SEAL_DEPTH = 8;
/** How deep a replay attribute's JSON is walked; deeper values are left as they are. */
const REPLAY_JSON_DEPTH = 64;
/** How many times a key or value is percent-decoded (`%2569nstance` is `instance` after two). */
const DECODE_ROUNDS = 4;
const SEAL_SCAN = /<iframe|srcdoc|capture-dialog-panel-state|capture-existing-panel/i;
const SIGNED_INSTANCE = /instance\s*=\s*([\w-]+\.[\w-]+)/gi;

const escapeHtml = ( text: string ) => text.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ).replace( /"/g, '&quot;' );

/** Percent-decode up to `DECODE_ROUNDS` times; `null` when a round meets a malformed sequence. */
function decodeStrictly( text: string ): string | null {
	let value = text;
	for ( let round = 0; round < DECODE_ROUNDS; round++ ) {
		let next: string;
		try {
			next = decodeURIComponent( value.replace( /\+/g, ' ' ) );
		} catch {
			return null;
		}
		if ( next === value ) break;
		value = next;
	}
	return value;
}

/** Like `decodeStrictly`, but a malformed sequence only stops decoding: each well-formed `%XX` is still read. */
function decodeLeniently( text: string ): string {
	let value = text;
	for ( let round = 0; round < DECODE_ROUNDS; round++ ) {
		const next = decodeStrictly( value ) ?? value.replace( /%([0-9a-f]{2})/gi, ( sequence, hex: string ) => {
			const code = parseInt( hex, 16 );
			return code < 0x80 ? String.fromCharCode( code ) : sequence;
		} );
		if ( next === value ) break;
		value = next;
	}
	return value;
}

/** Each query and fragment field of an address as raw key and value text, split on its own. */
function addressFields( url: URL ): Array< [ string, string ] > {
	const fragment = url.hash.slice( 1 );
	const parts = [ url.search.slice( 1 ), fragment ];
	if ( fragment.includes( '?' ) ) parts.push( fragment.slice( fragment.indexOf( '?' ) + 1 ) );
	return parts.flatMap( ( part ) => part.split( '&' ).filter( Boolean ).map( ( pair ): [ string, string ] => {
		const split = pair.indexOf( '=' );
		return split < 0 ? [ pair, '' ] : [ pair.slice( 0, split ), pair.slice( split + 1 ) ];
	} ) );
}

const signedInstanceIn = ( text: string ) => [ ...text.matchAll( SIGNED_INSTANCE ) ].some( ( match ) => signedWixInstance( match[ 1 ] ) );

/**
 * Whether an FAQ answer link's address is plain enough to keep: every query
 * and fragment field decodes cleanly, none is an `instance` key, and none
 * carries a signed Wix instance token.
 */
function plainLinkAddress( url: URL ): boolean {
	return addressFields( url ).every( ( [ rawKey, rawValue ] ) => {
		const key = decodeStrictly( rawKey );
		const value = decodeStrictly( rawValue );
		if ( key === null || value === null ) return false;
		return key.trim().toLowerCase() !== 'instance' && ! signedWixInstance( value ) && ! signedInstanceIn( value );
	} );
}

/**
 * Whether a frame address carries a Wix app credential under any of the
 * bases it could resolve against. Each query and fragment field is decoded
 * on its own (a malformed field elsewhere does not hide one): an `instance`
 * key in any case carrying a signed token, a signed token nested in another
 * field, or any `instance` value on a Wix app host, or on an unknown host
 * when nothing resolved the address.
 */
function carriesWixAppCredential( value: string | undefined, bases: readonly string[] ): boolean {
	if ( ! value?.trim() ) return false;
	return bases.some( ( base ) => {
		let url: URL;
		try {
			url = new URL( value.trim(), base );
		} catch {
			return false;
		}
		const wixHost = WIX_APP_FRAME_HOST.test( url.hostname ) || url.hostname === UNKNOWN_HOST;
		return addressFields( url ).some( ( [ rawKey, rawValue ] ) => {
			const key = decodeLeniently( rawKey ).trim().toLowerCase();
			const entry = decodeLeniently( rawValue ).trim();
			if ( key === 'instance' && entry && ( wixHost || signedWixInstance( entry ) ) ) return true;
			return signedInstanceIn( entry );
		} );
	} );
}

/**
 * For markup that is not parsed any further (past the nesting bound, or
 * malformed replay JSON), whether it holds an app frame credential: entity,
 * JSON and percent escapes are undone loosely, and a frame next to a signed
 * instance token, or to an `instance` field on a Wix app host, counts. A
 * public frame is kept, as it was before sealing.
 */
function deepMarkupMayCarryCredential( markup: string ): boolean {
	let text = markup;
	for ( let round = 0; round < 64; round++ ) {
		const next = decodeLeniently( text
			.replace( /&quot;|&#0*34;|&#x0*22;/gi, '"' ).replace( /&lt;|&#0*60;|&#x0*3c;/gi, '<' ).replace( /&gt;|&#0*62;|&#x0*3e;/gi, '>' ).replace( /&amp;|&#0*38;|&#x0*26;/gi, '&' )
			.replace( /\\u([0-9a-f]{4})/gi, ( _sequence, hex: string ) => String.fromCharCode( parseInt( hex, 16 ) ) ).replace( /\\(["\\/])/g, '$1' ) );
		if ( next === text ) break;
		text = next;
	}
	if ( ! /<iframe/i.test( text ) ) return false;
	if ( signedInstanceIn( text ) ) return true;
	return [ ...text.matchAll( /\/\/([^\/\s"'<>?#:]+)[^\s"'<>]*/g ) ].some( ( [ address, host ] ) => WIX_APP_FRAME_HOST.test( host.replace( /\.$/, '' ) ) && /[?&#]instance\s*=/i.test( address ) );
}

/**
 * The addresses relative URLs in a parsed document could resolve against: its
 * first `<base href>` (never one inside a `<template>`) as a browser resolves
 * it, with and without `<noscript>` content (which only parses as markup with
 * scripting off), each against the owner document's own bases.
 */
function documentBases( $: cheerio.CheerioAPI, owner: readonly string[] ): string[] {
	// Template content is its own fragment under the template, which `closest` does not cross.
	const within = ( element: { parent: unknown }, name: string ) => {
		for ( let node = element.parent as { name?: string; parent: unknown } | null; node; node = node.parent as typeof node ) if ( node.name === name ) return true;
		return false;
	};
	const candidates = $( 'base[href]' ).filter( ( _index, element ) => ! within( element, 'template' ) );
	const hrefs = new Set< string >();
	const first = candidates.first().attr( 'href' );
	const scripted = candidates.filter( ( _index, element ) => ! within( element, 'noscript' ) ).first().attr( 'href' );
	const bases = new Set< string >();
	for ( const href of [ first, scripted ] ) if ( href !== undefined ) hrefs.add( href );
	for ( const ownerBase of owner ) {
		if ( ! hrefs.size ) bases.add( ownerBase );
		for ( const href of hrefs ) {
			try {
				bases.add( new URL( href.trim(), ownerBase ).href );
			} catch {
				bases.add( ownerBase );
			}
		}
	}
	return [ ...bases ];
}

/**
 * The one place no App Market frame's credential can be saved, whatever the
 * live document did after the runtime port (a same-URL reload, a remount): run
 * on every serialized HTML string. The string is parsed with source offsets
 * (and with `<noscript>` content as markup, as a browser without scripting
 * renders it), and only affected ranges are rewritten, so everything else
 * stays byte for byte. A frame whose `src`, `data-src` or serializer-recorded
 * address carries a credential becomes the note at the size the serializer
 * recorded it painting, or is dropped when it did not paint. `srcdoc`
 * documents and captured panel replay markup (`PANEL_REPLAY_ATTRIBUTES`) are
 * sealed the same way, recursively, against the owner document's base, and
 * re-encoded. `ownerDocument` is the page a captured fragment came from.
 */
export function sealWixAppFrameHtml( html: string, ownerDocument?: string ): string {
	if ( ! SEAL_SCAN.test( html ) ) return html;
	return sealHtml( html, ownerBases( ownerDocument ), 0 );
}

/** The owner document's bases, parsed once per document (a report seals many fragments of one page). */
let lastOwner: { document: string; bases: string[] } | undefined;
function ownerBases( ownerDocument: string | undefined ): string[] {
	if ( ! ownerDocument || ! /<base/i.test( ownerDocument ) ) return [ UNKNOWN_DOCUMENT ];
	if ( lastOwner?.document !== ownerDocument ) lastOwner = { document: ownerDocument, bases: documentBases( cheerio.load( ownerDocument, { scriptingEnabled: false } ), [ UNKNOWN_DOCUMENT ] ) };
	return lastOwner.bases;
}

/** The address the serializer recorded a frame resolving to, when it is an absolute http(s) URL. */
function recordedFrameAddress( value: string | undefined ): string | undefined {
	try {
		const url = value ? new URL( value ) : undefined;
		return url && /^https?:$/.test( url.protocol ) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function sealHtml( html: string, owner: readonly string[], depth: number ): string {
	if ( ! SEAL_SCAN.test( html ) ) return html;
	const $ = cheerio.load( html, { sourceCodeLocationInfo: true, scriptingEnabled: false } );
	const bases = documentBases( $, owner );
	const edits: Array< { start: number; end: number; text: string } > = [];
	const attributeRange = ( element: ParsedElement, name: string ) =>
		// parse5 records each attribute's range; domhandler's typings leave it out.
		( element.sourceCodeLocation as { attrs?: Record< string, { startOffset: number; endOffset: number } > } | null | undefined )?.attrs?.[ name ];
	const rewriteAttribute = ( element: ParsedElement, name: string, value: string | null ) => {
		const location = attributeRange( element, name );
		if ( location ) edits.push( { start: location.startOffset, end: location.endOffset, text: value === null ? '' : `${ name }="${ escapeHtml( value ) }"` } );
	};
	// Nested markup beyond the depth bound is kept unless it holds a frame credential, which is removed.
	const nested = depth >= SEAL_DEPTH ? ( markup: string ) => deepMarkupMayCarryCredential( markup ) ? null : markup : ( markup: string ) => sealHtml( markup, bases, depth + 1 );
	$( 'iframe' ).each( ( _index, element ) => {
		const frame = $( element );
		const location = element.sourceCodeLocation;
		if ( ! location ) return;
		// The browser's resolved address, when the serializer recorded it, decides; the bases only stand in for it.
		const recorded = recordedFrameAddress( frame.attr( VISUAL_IFRAME_SRC ) );
		const credential = recorded
			? [ VISUAL_IFRAME_SRC, 'src', 'data-src' ].some( ( name ) => carriesWixAppCredential( frame.attr( name ), [ recorded ] ) )
			: [ 'src', 'data-src', VISUAL_IFRAME_SRC ].some( ( name ) => carriesWixAppCredential( frame.attr( name ), bases ) );
		if ( credential ) {
			const width = Number( frame.attr( VISUAL_IFRAME_WIDTH ) );
			const height = Number( frame.attr( VISUAL_IFRAME_HEIGHT ) );
			let text = '';
			if ( width > 0 && height > 0 ) {
				const nodeId = frame.attr( 'data-blocks-engine-node-id' );
				const label = ( frame.attr( 'title' ) ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 80 );
				const style = [ ...NOTE_STYLE, `max-width:${ Math.round( width ) }px`, `min-height:${ Math.round( height ) }px`, 'font-family:inherit' ].join( ';' );
				text = `<div ${ WIX_UNPORTED_EMBED_ATTRIBUTE }="wix" role="note" style="${ escapeHtml( style ) }"${ nodeId ? ` data-blocks-engine-node-id="${ escapeHtml( nodeId ) }"` : '' }>${ escapeHtml( wixEmbedNote( label || undefined ) ) }</div>`;
			}
			edits.push( { start: location.startOffset, end: location.endOffset, text } );
			return;
		}
		const srcdoc = frame.attr( 'srcdoc' );
		if ( srcdoc ) {
			const sealed = nested( srcdoc );
			if ( sealed !== srcdoc ) rewriteAttribute( element, 'srcdoc', sealed );
		}
	} );
	$( PANEL_REPLAY_ATTRIBUTES.map( ( name ) => `[${ name }]` ).join( ', ' ) ).each( ( _index, element ) => {
		for ( const name of PANEL_REPLAY_ATTRIBUTES ) {
			const value = $( element ).attr( name );
			if ( ! value ) continue;
			let state: unknown;
			try {
				state = JSON.parse( value );
			} catch {
				// Malformed evidence that holds a frame credential is removed; anything else is left for its owning validator.
				if ( deepMarkupMayCarryCredential( value ) ) rewriteAttribute( element as ParsedElement, name, null );
				continue;
			}
			let changed = false;
			let removed = false;
			const sealed = rewritePanelReplayHtml( state, ( markup ) => {
				const next = nested( markup );
				if ( next === null ) removed = true;
				changed ||= next !== markup;
				return next ?? '';
			}, REPLAY_JSON_DEPTH );
			// JSON nested past its bound comes back untouched; it is removed only when it may hold a credential.
			if ( sealed === state ) {
				if ( deepMarkupMayCarryCredential( value ) ) rewriteAttribute( element as ParsedElement, name, null );
			} else if ( removed ) rewriteAttribute( element as ParsedElement, name, null );
			else if ( changed ) rewriteAttribute( element as ParsedElement, name, JSON.stringify( sealed ) );
		}
	} );
	if ( ! edits.length ) return html;
	// Apply in order; an edit inside a range already replaced (an attribute of a dropped frame) is moot.
	edits.sort( ( left, right ) => left.start - right.start || right.end - left.end );
	let result = '';
	let offset = 0;
	for ( const edit of edits ) {
		if ( edit.start < offset ) continue;
		result += html.slice( offset, edit.start ) + edit.text;
		offset = edit.end;
	}
	return result + html.slice( offset );
}

/** Runs in the page: whether every Wix Events venue map has mounted its map. */
function wixEventMapsMounted( selector: string ): boolean {
	return [ ...document.querySelectorAll( selector ) ].every( ( host ) =>
		host instanceof HTMLImageElement
			? Boolean( host.getAttribute( 'src' )?.trim() || host.getAttribute( 'srcset' )?.trim() ) && host.complete
			: Boolean( host.querySelector( 'iframe[src]' ) )
	);
}

/**
 * Runs in the page: put a Google Maps embed where a Wix Events venue map never
 * mounted. The phone's static image link is replaced by the embed (an iframe
 * cannot live inside a link); the desktop host receives the embed as the
 * frame its widget would have mounted.
 */
function installWixEventMapEmbed( host: Element, args: { embed: string; attribute: string } ): void {
	const bounds = host.getBoundingClientRect();
	const frame = document.createElement( 'iframe' );
	frame.setAttribute( 'src', args.embed );
	frame.setAttribute( 'title', 'Map' );
	frame.setAttribute( 'loading', 'lazy' );
	frame.setAttribute( 'allowfullscreen', '' );
	frame.setAttribute( args.attribute, 'wix-google-map' );
	if ( host instanceof HTMLImageElement ) {
		const height = Math.round( bounds.height ) || ( host.width > 0 && host.height > 0 ? Math.round( host.height * ( bounds.width || host.width ) / host.width ) : 0 );
		frame.id = host.id;
		if ( host.className ) frame.className = host.className;
		frame.setAttribute( 'data-hook', 'map' );
		frame.style.cssText = [ 'display:block', 'border:0', 'width:100%', ...( bounds.width > 0 ? [ `max-width:${ Math.round( bounds.width ) }px` ] : [] ), ...( height > 0 ? [ `height:${ height }px` ] : [] ) ].join( ';' );
		const link = host.parentElement;
		const onlyChild = link?.localName === 'a' && [ ...link.childNodes ].every( ( node ) => node === host || ( node.nodeType === Node.TEXT_NODE && ! node.textContent?.trim() ) );
		( onlyChild ? link! : host ).replaceWith( frame );
		return;
	}
	frame.style.cssText = 'display:block;border:0;width:100%;height:100%';
	host.replaceChildren( frame );
}

/**
 * Give every Wix Events venue map on the page its map. Wait (bounded) for the
 * widget's deferred mount, so the copy keeps the source's own map; a map
 * still unmounted at the bound is pointed at a Google Maps embed of the venue
 * the page names (the phone image's search link, else the event's warmup
 * data), or a visible note when it names none. The copy never depends on when
 * hydration landed relative to serialization, and never ships an empty map
 * box or a source-less map image.
 */
export async function portWixEventMaps( page: Page, mountMilliseconds = EVENT_MAP_MOUNT_MILLISECONDS ): Promise< void > {
	if ( ( await page.locator( WIX_EVENT_MAP_SELECTOR ).count().catch( () => 0 ) ) === 0 ) return;
	// A zero budget applies the fallback now (Playwright reads a zero timeout as none at all).
	if ( mountMilliseconds > 0 ) await page.waitForFunction( wixEventMapsMounted, WIX_EVENT_MAP_SELECTOR, { timeout: mountMilliseconds, polling: 100 } ).catch( () => undefined );
	const warmup = await page.evaluate( () => document.getElementById( 'wix-warmup-data' )?.textContent ?? '' ).catch( () => '' );
	for ( const handle of await page.$$( WIX_EVENT_MAP_SELECTOR ) ) {
		const pending = await handle.evaluate( ( host ) => host instanceof HTMLImageElement
			? ! ( host.getAttribute( 'src' )?.trim() || host.getAttribute( 'srcset' )?.trim() )
			: ! host.querySelector( 'iframe[src]' ) ).catch( () => false );
		if ( ! pending ) continue;
		const href = await handle.evaluate( ( host ) => host.closest( 'a[href]' )?.getAttribute( 'href' ) ?? '' ).catch( () => '' );
		const view = googleMapsViewFromSearchLink( href ) ?? ( warmup ? wixEventVenueView( warmup ) : null );
		const language = await page.evaluate( () => document.documentElement.lang ).catch( () => '' );
		const embed = view ? googleMapsEmbedUrl( view, language || undefined ) : null;
		if ( embed ) await handle.evaluate( installWixEventMapEmbed, { embed, attribute: WIX_PORTED_EMBED_ATTRIBUTE } );
		else await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( 'Map' ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE, style: NOTE_STYLE } );
	}
}

/**
 * Point Wix map frames at Google Maps embeds; frames already pointed elsewhere
 * no longer match. `until` bounds the waits for a map's location and load.
 */
async function portWixMapFrames( page: Page, until = Infinity ): Promise< void > {
	for ( const handle of await page.$$( 'iframe[src]' ) ) {
		const src = ( await handle.getAttribute( 'src' ).catch( () => null ) ) ?? '';
		const title = ( await handle.getAttribute( 'title' ).catch( () => null ) ) ?? '';
		if ( isWixGoogleMapFrame( src, page.url() ) ) {
			const frame = await handle.contentFrame().catch( () => null );
			if ( frame ) {
				await frame.evaluate( () => {
					const scope = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
					if ( typeof scope.__name === 'undefined' ) scope.__name = ( fn ) => fn;
				} ).catch( () => undefined );
			}
			const view = frame ? await wixMapView( frame, until ) : null;
			const language = parseUrl( src, page.url() )?.searchParams.get( 'language' ) ?? undefined;
			const embed = view ? googleMapsEmbedUrl( view, language ) : null;
			if ( embed ) await pointAtGoogleMap( handle, embed, until );
			else await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( title || 'Google Maps' ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE, style: NOTE_STYLE } );
		} else if ( wixAppMapView( src, page.url() ) ) {
			const url = parseUrl( src, page.url() );
			const language = ( url?.searchParams.get( 'locale' ) || url?.searchParams.get( 'language' ) ) ?? undefined;
			const embed = googleMapsEmbedUrl( wixAppMapView( src, page.url() )!, language );
			if ( embed ) await pointAtGoogleMap( handle, embed, until );
		}
	}
}

/** The page's live Wix FAQ app frames, outside pinned chat layers. */
async function wixFaqFrames( page: Page ): Promise< ElementHandle< Element >[] > {
	const frames: ElementHandle< Element >[] = [];
	for ( const handle of await page.$$( 'iframe[src]' ) ) {
		const src = ( await handle.getAttribute( 'src' ).catch( () => null ) ) ?? '';
		if ( wixAppInstance( src, page.url() )?.appDefId !== WIX_FAQ_APP_DEF_ID ) continue;
		if ( await handle.evaluate( ( frame, selector ) => Boolean( frame.closest( selector ) ), WIX_PINNED_CHAT_SELECTOR ).catch( () => true ) ) continue;
		frames.push( handle );
	}
	return frames;
}

/**
 * Port Wix map wrappers to Google Maps embeds, carry Wix FAQ frames as
 * disclosures and replace other App Market widgets with a visible note. Runs
 * on the live DOM right before it is frozen; `sealWixAppFrameHtml` then
 * guarantees the saved HTML, whatever the live document does next.
 */
export async function portWixRuntimeEmbeds( page: Page, { faqRenderMilliseconds = FAQ_RENDER_MILLISECONDS, faqGraceMilliseconds = FAQ_GRACE_MILLISECONDS } = {} ): Promise< void > {
	try {
		// tsx instruments nested functions with __name(); the built bundle does not.
		await page.evaluate( () => {
			const scope = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
			if ( typeof scope.__name === 'undefined' ) scope.__name = ( fn ) => fn;
		} );
		// Mounted venue maps become ordinary app map iframes, ported below.
		await portWixEventMaps( page );
		// App Market custom elements are registered by vendor scripts rather than
		// loaded in Wix app iframes. Require the identifying appId/appName URL pair.
		const appName = await page.evaluate( () => {
			for ( const script of document.scripts ) {
				try {
					const url = new URL( script.src, location.href );
					if ( url.searchParams.has( 'appId' ) && url.searchParams.has( 'appName' ) ) return url.searchParams.get( 'appName' );
				} catch { /* Ignore malformed script URLs. */ }
			}
			return null;
		} );
		for ( const handle of await page.$$( '[data-testid="custom-element"] > *' ) ) {
			const tagName = await handle.evaluate( ( element ) => element.localName ).catch( () => '' );
			if ( tagName.includes( '-' ) ) {
				const label = appName || tagName.split( '-' ).filter( Boolean ).map( ( part ) => part.charAt( 0 ).toUpperCase() + part.slice( 1 ) ).join( ' ' );
				await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( label ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE, style: NOTE_STYLE, sizedByHost: true } );
			}
		}
		await portWixMapFrames( page );
		// A page with a FAQ frame is reconciled until every frame has settled and
		// nothing has mounted, been revealed or been replaced for a grace period,
		// or until one shared deadline: frames Wix mounts, remounts or reveals
		// meanwhile are read too, and a map that mounts during the wait is still
		// pointed at Google Maps, within the same deadline.
		const queries = trackWixFaqQueries( page );
		if ( ( await wixFaqFrames( page ) ).length ) {
			const deadline = Date.now() + faqRenderMilliseconds;
			const seen = new Map< number, string >();
			let shape = '';
			let changedAt = Date.now();
			for ( ;; ) {
				let pending = false;
				const keys: string[] = [];
				for ( const handle of await wixFaqFrames( page ) ) {
					const step = await stepWixFaqFrame( handle, seen, queries );
					keys.push( `${ step.key }:${ step.paints }` );
					if ( step.state === 'pending' ) pending = true;
					if ( step.state === 'ported' ) changedAt = Date.now();
				}
				const next = keys.sort().join( ',' );
				if ( next !== shape ) {
					shape = next;
					changedAt = Date.now();
				}
				await portWixMapFrames( page, deadline );
				if ( Date.now() >= deadline || ( ! pending && Date.now() - changedAt >= faqGraceMilliseconds ) ) break;
				await new Promise( ( resolve ) => setTimeout( resolve, FAQ_POLL_MILLISECONDS ) );
			}
			// Venue map hosts that mounted during the wait get the same fallback as
			// those present at the start, and their maps are pointed at Google Maps.
			await portWixEventMaps( page, 0 );
			await portWixMapFrames( page, deadline );
		}
	} finally {
		await page.evaluate( noteWixAppFrames, {
			attribute: WIX_UNPORTED_EMBED_ATTRIBUTE,
			pinned: WIX_PINNED_CHAT_SELECTOR,
			named: wixEmbedNote( '\u0000' ),
			plain: wixEmbedNote(),
			style: NOTE_STYLE,
		} ).catch( () => undefined );
	}
}
