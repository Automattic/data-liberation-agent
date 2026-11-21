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

import type { ElementHandle, Frame, Page } from 'playwright';

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
 * The FAQ app keeps querying its server after it has rendered, so no request
 * says it is done: its questions count as complete once they have not
 * changed for this long.
 */
const FAQ_QUIET_MILLISECONDS = 1_000;
/** Bounds on what a frame's answer tree may carry before it is refused outright. */
const FAQ_LIMITS = { nodes: 5_000, depth: 24, text: 20_000, question: 500, href: 2_048 };

/** Wix FAQ, the App Market app whose widget frame renders the site's questions and answers. */
export const WIX_FAQ_APP_DEF_ID = '14c92d28-031e-7910-c9a8-a670011e062d';

/** Elements an answer keeps; anything else is unwrapped to its children, or dropped with them. */
const FAQ_KEPT_TAGS = new Set( [ 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre' ] );
const FAQ_DROPPED_TAGS = new Set( [ 'script', 'style', 'template', 'svg', 'button', 'iframe', 'noscript', 'object', 'embed' ] );
const FAQ_LINK_PROTOCOLS = new Set( [ 'http:', 'https:', 'mailto:', 'tel:' ] );

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
	const url = parseUrl( src, base );
	const instance = url?.searchParams.get( 'instance' ) ?? '';
	const match = /^[\w-]+\.([\w-]+)$/.exec( instance );
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

async function wixMapView( frame: Frame ): Promise< MapView | null > {
	const deadline = Date.now() + MAP_LOCATION_WAIT_MILLISECONDS;
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

async function pointAtGoogleMap( handle: ElementHandle< Element >, embed: string ): Promise< void > {
	const loaded = handle
		.contentFrame()
		.then( ( frame ) => frame?.waitForURL( ( url ) => url.href === embed, { waitUntil: 'load', timeout: MAP_EMBED_LOAD_MILLISECONDS } ) )
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
		return FAQ_LINK_PROTOCOLS.has( url.protocol ) ? url.href : undefined;
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
 * Read one Wix FAQ frame and port it once its questions are complete: every
 * question has an answer, the frame paints, and nothing has changed for
 * `FAQ_QUIET_MILLISECONDS`. A frame still incomplete at the deadline gets the note.
 */
async function stepWixFaqFrame( handle: ElementHandle< Element >, seen: Map< number, { signature: string; since: number } >, quietMilliseconds: number ): Promise< void > {
	const key = await handle.evaluate( frameKey ).catch( () => 0 );
	if ( ! key || ! await handle.evaluate( ( frame ) => frame.isConnected ).catch( () => false ) ) return;
	// Re-resolved on every read: the frame can navigate while it loads.
	const frame = await handle.contentFrame().catch( () => null );
	const items = wixFaqItems( frame ? await frame.evaluate( readWixFaqFrame ).catch( () => null ) : null );
	if ( ! Array.isArray( items ) || ! await handle.evaluate( framePaints ).catch( () => false ) ) {
		seen.delete( key );
		return;
	}
	const signature = JSON.stringify( items );
	const previous = seen.get( key );
	if ( previous?.signature !== signature ) {
		seen.set( key, { signature, since: Date.now() } );
		return;
	}
	if ( Date.now() - previous.since >= quietMilliseconds ) await handle.evaluate( installWixFaq, { items, attribute: WIX_PORTED_EMBED_ATTRIBUTE } ).catch( () => false );
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

const IFRAME_ELEMENT = /<iframe\b([^>]*)>[\s\S]*?<\/iframe\s*>/gi;
const VISUAL_IFRAME_WIDTH = 'data-blocks-engine-capture-visual-iframe-width';
const VISUAL_IFRAME_HEIGHT = 'data-blocks-engine-capture-visual-iframe-height';

function serializedAttribute( attributes: string, name: string ): string | undefined {
	const match = new RegExp( `\\s${ name.replace( /[-]/g, '\\-' ) }\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i' ).exec( attributes );
	const value = match ? match[ 1 ] ?? match[ 2 ] ?? match[ 3 ] : undefined;
	return value?.replace( /&quot;/g, '"' ).replace( /&#39;/g, "'" ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' ).replace( /&amp;/g, '&' );
}

const escapeHtml = ( text: string ) => text.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ).replace( /"/g, '&quot;' );

/**
 * The one place no App Market frame's signed token can be saved, whatever the
 * live document did after the runtime port (a same-URL reload, a remount): run
 * on every serialized HTML string. A frame the serializer recorded as painted
 * (its visual-iframe width and height) becomes the note at that size; any
 * other app frame is dropped. Ordinary embeds and ported maps carry no token
 * and are kept byte for byte.
 */
export function sealWixAppFrameHtml( html: string ): string {
	if ( ! html.includes( 'instance=' ) ) return html;
	return html.replace( IFRAME_ELEMENT, ( element, attributes: string ) => {
		const src = serializedAttribute( attributes, 'src' ) ?? '';
		if ( ! wixAppInstance( src ) ) return element;
		const width = Number( serializedAttribute( attributes, VISUAL_IFRAME_WIDTH ) );
		const height = Number( serializedAttribute( attributes, VISUAL_IFRAME_HEIGHT ) );
		if ( ! ( width > 0 && height > 0 ) ) return '';
		const nodeId = serializedAttribute( attributes, 'data-blocks-engine-node-id' );
		const label = ( serializedAttribute( attributes, 'title' ) ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 80 );
		const style = [ ...NOTE_STYLE, `max-width:${ Math.round( width ) }px`, `min-height:${ Math.round( height ) }px`, 'font-family:inherit' ].join( ';' );
		return `<div ${ WIX_UNPORTED_EMBED_ATTRIBUTE }="wix" role="note" style="${ escapeHtml( style ) }"${ nodeId ? ` data-blocks-engine-node-id="${ escapeHtml( nodeId ) }"` : '' }>${ escapeHtml( wixEmbedNote( label || undefined ) ) }</div>`;
	} );
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
	await page.waitForFunction( wixEventMapsMounted, WIX_EVENT_MAP_SELECTOR, { timeout: mountMilliseconds, polling: 100 } ).catch( () => undefined );
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

/** Point Wix map frames at Google Maps embeds; frames already pointed elsewhere no longer match. */
async function portWixMapFrames( page: Page ): Promise< void > {
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
			const view = frame ? await wixMapView( frame ) : null;
			const language = parseUrl( src, page.url() )?.searchParams.get( 'language' ) ?? undefined;
			const embed = view ? googleMapsEmbedUrl( view, language ) : null;
			if ( embed ) await pointAtGoogleMap( handle, embed );
			else await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( title || 'Google Maps' ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE, style: NOTE_STYLE } );
		} else if ( wixAppMapView( src, page.url() ) ) {
			const url = parseUrl( src, page.url() );
			const language = ( url?.searchParams.get( 'locale' ) || url?.searchParams.get( 'language' ) ) ?? undefined;
			const embed = googleMapsEmbedUrl( wixAppMapView( src, page.url() )!, language );
			if ( embed ) await pointAtGoogleMap( handle, embed );
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
export async function portWixRuntimeEmbeds( page: Page, { faqRenderMilliseconds = FAQ_RENDER_MILLISECONDS, faqQuietMilliseconds = FAQ_QUIET_MILLISECONDS } = {} ): Promise< void > {
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
		// A page with a FAQ frame is reconciled until one shared deadline: frames
		// Wix mounts, remounts or reveals meanwhile are read too, and a map that
		// mounts during the wait is still pointed at Google Maps.
		if ( ( await wixFaqFrames( page ) ).length ) {
			const deadline = Date.now() + faqRenderMilliseconds;
			const seen = new Map< number, { signature: string; since: number } >();
			while ( Date.now() < deadline ) {
				for ( const handle of await wixFaqFrames( page ) ) await stepWixFaqFrame( handle, seen, faqQuietMilliseconds );
				await portWixMapFrames( page );
				await new Promise( ( resolve ) => setTimeout( resolve, FAQ_POLL_MILLISECONDS ) );
			}
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
