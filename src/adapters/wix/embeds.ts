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
// While the live page still has its runtime, a map is pointed at an ordinary
// Google Maps embed of the location the wrapper drew, and an app widget is
// replaced by a visible note the same size, so the gap is honest, not white.

import type { ElementHandle, Frame, Page } from 'playwright';

/** Marks a Wix map that was pointed at a portable Google Maps embed. */
export const WIX_PORTED_MAP_ATTRIBUTE = 'data-dla-ported-embed';
/** Marks the note left where a Wix-only widget could not be copied. */
export const WIX_UNPORTED_EMBED_ATTRIBUTE = 'data-dla-unported-embed';

const MAP_LOCATION_WAIT_MILLISECONDS = 5_000;
const MAP_EMBED_LOAD_MILLISECONDS = 5_000;

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
function installWixEmbedNote( frame: Element, args: { note: string; attribute: string } ): void {
	const bounds = frame.getBoundingClientRect();
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
	note.style.cssText = [
		'box-sizing:border-box',
		'width:100%',
		`max-width:${ Math.round( bounds.width ) }px`,
		`min-height:${ Math.round( bounds.height ) }px`,
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
	].join( ';' );
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
		{ embed, attribute: WIX_PORTED_MAP_ATTRIBUTE }
	);
	// Let the reference screenshot show the map; the copy depends only on `src`.
	await loaded;
}

/**
 * Port Wix map wrappers to Google Maps embeds and replace App Market widgets
 * with a visible note. Runs on the live DOM right before it is frozen.
 */
export async function portWixRuntimeEmbeds( page: Page ): Promise< void > {
	// tsx instruments nested functions with __name(); the built bundle does not.
	await page.evaluate( () => {
		const scope = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
		if ( typeof scope.__name === 'undefined' ) scope.__name = ( fn ) => fn;
	} );
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
			else await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( title || 'Google Maps' ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE } );
		} else if ( wixAppInstance( src, page.url() ) ) {
			await handle.evaluate( installWixEmbedNote, { note: wixEmbedNote( title ), attribute: WIX_UNPORTED_EMBED_ATTRIBUTE } );
		}
	}
}
