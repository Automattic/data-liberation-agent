import type { Page } from 'playwright';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { documentsDiffer } from '../responsive-assembly.js';
import { CONSENT_OVERLAY_DIALOG_SELECTOR, CONSENT_VENDOR_RE, isConsentOverlayRoot, type ConsentOverlayElement } from '../consent-overlay.js';

/**
 * Whether a capture renders the phone profile as its own document.
 *
 * - `dual`: desktop and phone profiles are captured per route and assembled at
 *   export (the long-standing behavior).
 * - `reflow-only`: only the desktop profile is captured. The source serves the
 *   phone the same HTML and builds the same DOM at phone width, so its copied
 *   CSS already produces the phone layout.
 *
 * `auto` decides once per capture, on the entrypoint, before any route is
 * captured (see `decideDeviceMode`).
 */
export type DeviceMode = 'dual' | 'reflow-only';
export type DeviceModeRequest = 'auto' | DeviceMode;
export const DEVICE_MODE_REQUESTS: readonly DeviceModeRequest[] = [ 'auto', 'dual', 'reflow-only' ];

/** Per-request noise removed before comparing the two server documents. Everything else must match byte for byte. */
export const SERVER_HTML_IGNORED = [
	'nonce attribute values',
	'values of attributes, meta tags, hidden inputs and JSON keys named like csrf, xsrf, nonce or authenticity token',
	'ISO-8601 date-time stamps',
] as const;

/** Elements left out of the rendered structure comparison. */
export const STRUCTURE_IGNORED = [ 'differences inside <head> (reported, not compared)', 'script', 'style', 'noscript', 'template', 'invisible (at most 1 px or visibility:hidden) iframes and images appended directly to <body>, such as tracking pixels', 'elements carrying data-lib-* probe markers or capture evidence attributes', 'cookie/consent overlay subtrees (consent dialogs and consent vendor elements), which consent managers lay out per viewport', 'the sibling position of empty HTML containers, elements with no child nodes other than void, replaced and form elements (their presence still counts)' ] as const;

export interface DeviceModeDecision {
	mode: DeviceMode;
	requested: DeviceModeRequest;
	/** Why this mode, in one sentence. */
	reason: string;
	/** The entrypoint the probe rendered. */
	url?: string;
	serverHtml?: 'identical' | 'identical-after-normalization' | 'different' | 'unavailable';
	/** A differing first sample was confirmed with paired document-only requests. */
	serverHtmlResampled?: boolean;
	serverHtmlFirstSample?: DeviceModeDecision['serverHtml'];
	structure?: StructureComparison;
	/** Body class tokens only one identity rendered; source CSS can gate a whole layout on them. */
	bodyClasses?: { desktopOnly: string[]; phoneOnly: string[] };
	ignored?: { serverHtml: readonly string[]; structure: readonly string[] };
	/** Reflow-only site: the per-route phone checks and the routes they kept dual. */
	routes?: RouteDeviceSummary;
	/** Reflow-only: the phone-width interaction probe on the entrypoint. */
	phoneProbe?: { status: 'captured' | 'none' | 'skipped' | 'failed'; triggers: number; captured: number; reason?: string };
	durationMs?: number;
}

export interface StructureComparison {
	desktopElements: number;
	phoneElements: number;
	/** Element paths outside `<head>` present in one document and not the other, counted as a multiset. */
	differingPaths: number;
	firstDifference?: string;
	/** Diagnostic only, present when the `<head>` paths differ in content or order. They never make a route dual. */
	headDifferingPaths?: number;
	firstHeadDifference?: string;
}

const TOKEN_NAME = String.raw`[\w:.-]*(?:csrf|xsrf|nonce|authenticity[_-]?token)[\w:.-]*`;

/** Remove per-request noise from a server document; see `SERVER_HTML_IGNORED`. */
export function normalizeServerHtml( html: string ): string {
	return html
		// nonce="…" (CSP), data-nonce="…", data-csrf-token="…".
		.replace( new RegExp( String.raw`(\s${ TOKEN_NAME }\s*=\s*)(?:"[^"]*"|'[^']*')`, 'gi' ), '$1""' )
		// <meta name="csrf-token" content="…">, <input type="hidden" name="_csrf" value="…">.
		.replace( /<(?:meta|input)\b[^>]*>/gi, ( tag ) =>
			new RegExp( String.raw`\b(?:name|id)\s*=\s*["']?${ TOKEN_NAME }`, 'i' ).test( tag )
				? tag.replace( /(\s(?:content|value)\s*=\s*)(?:"[^"]*"|'[^']*')/gi, '$1""' )
				: tag )
		// Inline configuration: "nonce":"…", "csrfToken": "…".
		.replace( new RegExp( String.raw`(["']${ TOKEN_NAME }["']\s*:\s*)(?:"[^"]*"|'[^']*')`, 'gi' ), '$1""' )
		.replace( /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<timestamp>' );
}

export function compareServerHtml( desktop: string, phone: string ): NonNullable< DeviceModeDecision['serverHtml'] > {
	if ( desktop === phone ) return 'identical';
	return normalizeServerHtml( desktop ) === normalizeServerHtml( phone ) ? 'identical-after-normalization' : 'different';
}

/**
 * Headers a browser navigation sent, made replayable by an API request:
 * HTTP/2 pseudo-headers are not valid header names, the context's jar owns
 * cookies, and the client negotiates its own decodable encodings.
 */
export function replayableRequestHeaders( headers: Record< string, string > ): Record< string, string > {
	return Object.fromEntries( Object.entries( headers ).filter( ( [ name ] ) => ! name.startsWith( ':' ) && name !== 'cookie' && name !== 'accept-encoding' ) );
}

/** Confirm a site-wide HTML difference once, without repeating the browser load. */
export async function resampleSiteServerHtml(
	first: NonNullable< DeviceModeDecision['serverHtml'] >,
	fetchDesktop: () => Promise< string | undefined >,
	fetchPhone: () => Promise< string | undefined >,
): Promise< Pick< DeviceModeDecision, 'serverHtml' | 'serverHtmlResampled' | 'serverHtmlFirstSample' > > {
	if ( first !== 'different' ) return { serverHtml: first };
	// Start both requests together. A failed re-sample cannot disprove the first difference.
	const [ desktop, phone ] = await Promise.all( [
		fetchDesktop().catch( () => undefined ),
		fetchPhone().catch( () => undefined ),
	] );
	return {
		serverHtml: desktop === undefined || phone === undefined ? first : compareServerHtml( desktop, phone ),
		serverHtmlResampled: true,
		serverHtmlFirstSample: first,
	};
}

/** Differing paths of two element-path lists, counted as a multiset, and the first positional divergence. */
function pathDifference( desktop: readonly string[], phone: readonly string[] ): { count: number; first?: string } {
	const counts = new Map< string, number >();
	for ( const path of desktop ) counts.set( path, ( counts.get( path ) ?? 0 ) + 1 );
	for ( const path of phone ) counts.set( path, ( counts.get( path ) ?? 0 ) - 1 );
	let count = 0;
	for ( const value of counts.values() ) count += Math.abs( value );
	const index = desktop.findIndex( ( path, position ) => phone[ position ] !== path );
	const at = index === -1 && desktop.length !== phone.length ? Math.min( desktop.length, phone.length ) : index;
	return { count, ...( at === -1 ? {} : { first: `desktop ${ desktop[ at ] ?? '(end)' } / phone ${ phone[ at ] ?? '(end)' }` } ) };
}

const inHead = ( path: string ) => /^html>head\[\d+\](?:>|$)/.test( path );

/**
 * Compare two element-path lists, both in document order. Only the rendered
 * body decides equivalence, as export's `documentsDiffer` does: `<head>`
 * differences (meta order, a runtime-injected tag) are reported separately.
 */
export function compareStructure( desktop: readonly string[], phone: readonly string[] ): StructureComparison {
	const rendered = pathDifference( desktop.filter( path => ! inHead( path ) ), phone.filter( path => ! inHead( path ) ) );
	const head = pathDifference( desktop.filter( inHead ), phone.filter( inHead ) );
	return {
		desktopElements: desktop.length,
		phoneElements: phone.length,
		differingPaths: rendered.count,
		...( rendered.first ? { firstDifference: rendered.first } : {} ),
		...( head.first ? { headDifferingPaths: head.count, firstHeadDifference: head.first } : {} ),
	};
}

/**
 * Drop empty elements directly under `<body>` from a path list. They are mount
 * points a runtime appends for one identity or width (a portal, a toast host)
 * with nothing rendered in them, so the switch probe does not let one decide
 * which document the phone identity is rendering.
 */
export function withoutEmptyBodyMounts( paths: readonly string[] ): string[] {
	return paths.filter( path => ! /^html>body\[\d+\]>[^>]+\[\]$/.test( path ) );
}

/**
 * Drop the subtrees rooted at `roots` from a document-order path list and
 * renumber the remaining paths, so an excluded element does not shift the
 * position of its later same-tag siblings.
 */
export function withoutSubtrees( paths: readonly string[], roots: readonly string[] ): string[] {
	if ( ! roots.length ) return [ ...paths ];
	const excluded = ( path: string ) => roots.some( root => path === root || path.startsWith( `${ root }>` ) );
	const renamed = new Map< string, string >();
	const positions = new Map< string, number >();
	const kept: string[] = [];
	for ( const path of paths ) {
		if ( excluded( path ) ) continue;
		const cut = path.lastIndexOf( '>' );
		if ( cut === -1 ) { renamed.set( path, path ); kept.push( path ); continue; }
		const parent = renamed.get( path.slice( 0, cut ) ) ?? path.slice( 0, cut );
		const [ , tag, index ] = /^(.*)\[(\d*)\]$/.exec( path.slice( cut + 1 ) ) ?? [ '', path.slice( cut + 1 ), '' ];
		let next = `${ parent }>${ tag }[]`;
		if ( index !== '' ) {
			const key = `${ parent }>${ tag }`;
			const position = ( positions.get( key ) ?? 0 ) + 1;
			positions.set( key, position );
			next = `${ parent }>${ tag }[${ position }]`;
		}
		renamed.set( path, next );
		kept.push( next );
	}
	return kept;
}

/**
 * The rendered element-path structure of a page, in document order. A path is
 * the tag chain from `<html>` with each element's position among its kept
 * same-tag siblings, e.g. `html>body>div[2]>nav[1]`. Consent overlay subtrees
 * (`isConsentOverlayRoot`) are left out. When `mark` is given, elements whose
 * raw path (consent overlays included, as `visibleControlPaths` reads it) is
 * in it get that attribute (used to carry a desktop observation onto the same
 * elements of a structurally identical phone page).
 */
export async function renderedElementPaths( page: Page, mark?: { attribute: string; paths: readonly string[] } ): Promise< string[] > {
	const { paths, overlays } = await page.evaluate( ( { mark, dialogSelector, vendorSource } ) => {
		const skipped = new Set( [ 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE' ] );
		// Invisible frames and pixels appended to <body> are tracking and messaging
		// channels that third-party scripts inject on their own schedule, not page
		// structure. Responsive content hidden by CSS sits inside layout containers.
		const hiddenFrame = ( element: Element ) => ( element.tagName === 'IFRAME' || element.tagName === 'IMG' ) && element.parentElement === document.body &&
			( ( rect => rect.width <= 1 || rect.height <= 1 )( element.getBoundingClientRect() ) || getComputedStyle( element ).visibility === 'hidden' );
		const owned = ( element: Element ) => Array.from( element.attributes ).some( attribute => /^data-(?:lib|blocks-engine-capture)-/.test( attribute.name ) && attribute.name !== mark?.attribute );
		const marked = mark ? new Set( mark.paths ) : undefined;
		// Possible consent overlay roots, classified in Node by the shared consent classifier.
		const vendor = new RegExp( vendorSource, 'i' );
		const className = ( element: Element ) => typeof element.className === 'string' ? element.className : ( element.getAttribute( 'class' ) ?? '' );
		const overlays: Array< { path: string; element: ConsentOverlayElement } > = [];
		// An empty container is compared by presence, not by its place among its
		// siblings, so a script reordering one at another width does not shift
		// every content-bearing sibling. Void, replaced and form elements are
		// content even with no child nodes and keep their position.
		const contentless = new Set( [ 'AREA', 'AUDIO', 'BASE', 'BR', 'CANVAS', 'COL', 'EMBED', 'HR', 'IFRAME', 'IMG', 'INPUT', 'LINK', 'META', 'OBJECT', 'SELECT', 'SOURCE', 'TEXTAREA', 'TRACK', 'VIDEO', 'WBR' ] );
		const emptyContainer = ( element: Element ) => ! element.hasChildNodes() && element.namespaceURI === 'http://www.w3.org/1999/xhtml' && ! contentless.has( element.tagName );
		const paths: string[] = [];
		const walk = ( element: Element, prefix: string ) => {
			const seen = new Map< string, number >();
			for ( const child of Array.from( element.children ) ) {
				if ( skipped.has( child.tagName ) || owned( child ) || hiddenFrame( child ) ) continue;
				const tag = child.tagName.toLowerCase();
				const empty = emptyContainer( child );
				const position = empty ? 0 : ( seen.get( tag ) ?? 0 ) + 1;
				if ( ! empty ) seen.set( tag, position );
				const path = empty ? `${ prefix }>${ tag }[]` : `${ prefix }>${ tag }[${ position }]`;
				paths.push( path );
				if ( marked?.has( path ) ) child.setAttribute( mark!.attribute, '' );
				// An empty container has no subtree, and its path is shared by its empty siblings.
				if ( ! empty && ( child.matches( dialogSelector ) || vendor.test( `${ child.id } ${ className( child ) }` ) ) ) {
					overlays.push( { path, element: { tag, id: child.id, className: className( child ), role: child.getAttribute( 'role' ), ariaModal: child.getAttribute( 'aria-modal' ) === 'true', ariaLabel: child.getAttribute( 'aria-label' ), text: ( child.textContent ?? '' ).slice( 0, 4000 ) } } );
				}
				walk( child, path );
			}
		};
		paths.push( 'html' );
		walk( document.documentElement, 'html' );
		return { paths, overlays };
	}, { mark, dialogSelector: CONSENT_OVERLAY_DIALOG_SELECTOR, vendorSource: CONSENT_VENDOR_RE.source } );
	return withoutSubtrees( paths, overlays.filter( overlay => isConsentOverlayRoot( overlay.element ) ).map( overlay => overlay.path ) );
}

/** Class tokens on `<body>` that one identity rendered and the other did not. */
export function compareBodyClasses( desktop: readonly string[], phone: readonly string[] ): { desktopOnly: string[]; phoneOnly: string[] } {
	return { desktopOnly: desktop.filter( token => ! phone.includes( token ) ), phoneOnly: phone.filter( token => ! desktop.includes( token ) ) };
}

export async function renderedBodyClasses( page: Page ): Promise< string[] > {
	return page.evaluate( () => [ ...( document.body?.classList ?? [] ) ] );
}

/** Paths of interactive controls that are laid out and visible at this page's current width. */
export async function visibleControlPaths( page: Page ): Promise< string[] > {
	return page.evaluate( () => {
		const skipped = new Set( [ 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE' ] );
		// Invisible frames and pixels appended to <body> are tracking and messaging
		// channels that third-party scripts inject on their own schedule, not page
		// structure. Responsive content hidden by CSS sits inside layout containers.
		const hiddenFrame = ( element: Element ) => ( element.tagName === 'IFRAME' || element.tagName === 'IMG' ) && element.parentElement === document.body &&
			( ( rect => rect.width <= 1 || rect.height <= 1 )( element.getBoundingClientRect() ) || getComputedStyle( element ).visibility === 'hidden' );
		const owned = ( element: Element ) => Array.from( element.attributes ).some( attribute => /^data-(?:lib|blocks-engine-capture)-/.test( attribute.name ) );
		const control = 'button,[role="button"],[role="combobox"],[aria-haspopup],summary';
		const visible = ( element: Element ) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		};
		// Same walk as `renderedElementPaths`, so desktop-control paths name the
		// same nodes on the phone page: an empty container is compared by presence,
		// not by its place among its siblings.
		const contentless = new Set( [ 'AREA', 'AUDIO', 'BASE', 'BR', 'CANVAS', 'COL', 'EMBED', 'HR', 'IFRAME', 'IMG', 'INPUT', 'LINK', 'META', 'OBJECT', 'SELECT', 'SOURCE', 'TEXTAREA', 'TRACK', 'VIDEO', 'WBR' ] );
		const emptyContainer = ( element: Element ) => ! element.hasChildNodes() && element.namespaceURI === 'http://www.w3.org/1999/xhtml' && ! contentless.has( element.tagName );
		const paths: string[] = [];
		const walk = ( element: Element, prefix: string ) => {
			const seen = new Map< string, number >();
			for ( const child of Array.from( element.children ) ) {
				if ( skipped.has( child.tagName ) || owned( child ) || hiddenFrame( child ) ) continue;
				const tag = child.tagName.toLowerCase();
				const empty = emptyContainer( child );
				const position = empty ? 0 : ( seen.get( tag ) ?? 0 ) + 1;
				if ( ! empty ) seen.set( tag, position );
				const path = empty ? `${ prefix }>${ tag }[]` : `${ prefix }>${ tag }[${ position }]`;
				if ( child.matches( control ) && visible( child ) ) paths.push( path );
				walk( child, path );
			}
		};
		walk( document.documentElement, 'html' );
		return paths;
	} );
}

/** A selector re-expressed for another page, with the node's ID when both renderings agree on it. */
export interface CarriedSelector { selector: string; id?: string }

/**
 * Re-express selectors recorded on one page for a structurally identical page.
 * Runtime ID counters number elements in render order, so one control can
 * carry a different ID in each rendering: an ID selector recorded at phone
 * width can name another control, or nothing, at desktop width. Only an ID
 * both renderings give the node is an identity; any other is per-rendering.
 * A selector that names the node at the same position on both pages is kept;
 * any other becomes the node's agreed ID or, failing that, its position.
 * Selectors that name nothing on `from`, or nothing at the same position on
 * `to`, are not carried.
 */
export async function carrySelectors( from: Page, to: Page, selectors: readonly string[] ): Promise< Map< string, CarriedSelector > > {
	const unique = [ ...new Set( selectors ) ];
	if ( ! unique.length ) return new Map();
	const observed = await from.evaluate( ( selectors ) => selectors.map( selector => {
		let element: Element | null = null;
		try { element = document.querySelector( selector ); } catch { return null; }
		if ( ! element || ! document.body.contains( element ) || element === document.body ) return null;
		const parts: string[] = [];
		for ( let node: Element = element; node !== document.body; node = node.parentElement! ) {
			const index = Array.from( node.parentElement!.children ).filter( sibling => sibling.tagName === node.tagName ).indexOf( node ) + 1;
			parts.unshift( `${ node.tagName.toLowerCase() }:nth-of-type(${ index })` );
		}
		return { position: `body > ${ parts.join( ' > ' ) }`, id: element.id };
	} ), unique );
	const carried = await to.evaluate( ( pairs ) => pairs.map( ( [ selector, seen ] ) => {
		if ( ! seen ) return null;
		const target = document.querySelector( seen.position );
		if ( ! target ) return null;
		let named: Element | null = null;
		try { named = document.querySelector( selector ); } catch { /* An unparseable selector names nothing. */ }
		const id = target.id && target.id === seen.id && document.querySelectorAll( `#${ CSS.escape( target.id ) }` ).length === 1 ? target.id : undefined;
		const next = named === target ? selector : id ? `#${ CSS.escape( id ) }` : seen.position;
		if ( next === selector && ( id ?? '' ) === seen.id ) return null;
		return { selector: next, ...( id ? { id } : {} ) };
	} ), unique.map( ( selector, index ) => [ selector, observed[ index ] ] as [ string, { position: string; id: string } | null ] ) );
	return new Map( unique.flatMap( ( selector, index ) => carried[ index ] ? [ [ selector, carried[ index ]! ] as const ] : [] ) );
}

/** Every string recorded under a key named `…selector`, anywhere in `value`. */
export function recordedSelectors( value: unknown ): string[] {
	if ( Array.isArray( value ) ) return value.flatMap( recordedSelectors );
	if ( ! value || typeof value !== 'object' ) return [];
	return Object.entries( value as Record< string, unknown > ).flatMap( ( [ key, child ] ) =>
		typeof child === 'string' ? ( /selector$/i.test( key ) ? [ child ] : [] ) : recordedSelectors( child ) );
}

/**
 * Apply `carrySelectors` to recorded evidence. A node record whose `selector`
 * is carried keeps its `id` only when both renderings agree on it.
 */
export function withCarriedSelectors< T >( value: T, carried: ReadonlyMap< string, CarriedSelector > ): T {
	if ( ! carried.size ) return value;
	const walk = ( node: unknown ): unknown => {
		if ( Array.isArray( node ) ) return node.map( walk );
		if ( ! node || typeof node !== 'object' ) return node;
		const record = node as Record< string, unknown >;
		const next: Record< string, unknown > = {};
		for ( const [ key, child ] of Object.entries( record ) ) {
			const moved = typeof child === 'string' && /selector$/i.test( key ) ? carried.get( child ) : undefined;
			next[ key ] = moved ? moved.selector : walk( child );
		}
		const own = typeof record.selector === 'string' ? carried.get( record.selector ) : undefined;
		if ( own?.id ) next.id = own.id;
		else if ( own ) delete next.id;
		return next;
	};
	return walk( value ) as T;
}

/** A short scroll through the document so viewport-triggered content renders before structure is read. */
export async function shortScroll( page: Page ): Promise< void > {
	await page.evaluate( async () => {
		const pause = () => new Promise< void >( resolve => setTimeout( resolve, 120 ) );
		const steps = 6;
		const height = Math.max( document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0 );
		for ( let step = 1; step <= steps; step++ ) {
			window.scrollTo( { top: Math.round( ( height * step ) / steps ), left: 0, behavior: 'instant' } );
			await pause();
		}
		window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
		await pause();
	} );
}

/**
 * The site-level gate, decided on the entrypoint. It never looks at rendered
 * structure: each route's structure is checked before that route is captured
 * (`decideRouteMode`). Only per-device adapter documents, different server
 * HTML or a failed probe keep the whole capture `dual`.
 */
export function decideSiteMode( input: {
	requested: DeviceModeRequest;
	deviceDocuments?: string;
	serverHtml?: DeviceModeDecision['serverHtml'];
	probeError?: string;
} ): Pick< DeviceModeDecision, 'mode' | 'reason' > {
	if ( input.requested === 'dual' ) return { mode: 'dual', reason: 'dual capture was requested' };
	if ( input.requested === 'reflow-only' ) return { mode: 'reflow-only', reason: 'reflow-only capture was requested; routes are not checked' };
	if ( input.deviceDocuments ) return { mode: 'dual', reason: `the adapter declares per-device documents (${ input.deviceDocuments })` };
	if ( input.probeError ) return { mode: 'dual', reason: `the entrypoint probe failed: ${ input.probeError }` };
	if ( input.serverHtml === 'different' ) return { mode: 'dual', reason: 'the entrypoint serves different HTML to the desktop and phone identities' };
	if ( input.serverHtml !== 'identical' && input.serverHtml !== 'identical-after-normalization' ) return { mode: 'dual', reason: 'the entrypoint server HTML could not be compared' };
	return { mode: 'reflow-only', reason: 'the entrypoint serves the same HTML to the desktop and phone identities; each route is captured at desktop only unless its phone check finds a different document' };
}

/** Detect viewport-dependent text in keyed style elements without treating ordinary head noise as a device variant. */
function runtimeStyleTextDiffers( desktop: Array<[ string, string ]>, phone: Array<[ string, string ]> ): boolean {
	const a = new Map( desktop );
	const b = new Map( phone );
	for ( const [ id, text ] of a ) if ( b.has( id ) && b.get( id ) !== text ) return true;
	return false;
}

/** One route's decision under a `reflow-only` site, from its cheap phone check. */
export function decideRouteMode( input: {
	serverHtml?: DeviceModeDecision['serverHtml'];
	structure?: StructureComparison;
	/** Settled keyed style text, collected directly from both rendered pages. */
	runtimeStyles?: { desktop: Array<[ string, string ]>; phone: Array<[ string, string ]> };
	/** Settled documents, read after the path recheck when paths still differ. */
	renderedDocuments?: { desktop: string; phone: string };
	bodyClasses?: { desktopOnly: string[]; phoneOnly: string[] };
	error?: string;
} ): Pick< DeviceModeDecision, 'mode' | 'reason' > {
	if ( input.error ) return { mode: 'dual', reason: `the phone check failed: ${ input.error }` };
	if ( input.serverHtml === 'different' ) return { mode: 'dual', reason: 'the route serves different HTML to the desktop and phone identities' };
	if ( input.serverHtml !== 'identical' && input.serverHtml !== 'identical-after-normalization' ) return { mode: 'dual', reason: 'the route server HTML could not be compared' };
	if ( ! input.structure ) return { mode: 'dual', reason: 'the rendered structure could not be compared' };
	const classes = input.bodyClasses ? [ ...input.bodyClasses.desktopOnly.map( token => `-${ token }` ), ...input.bodyClasses.phoneOnly.map( token => `+${ token }` ) ] : [];
	if ( classes.length ) return { mode: 'dual', reason: `the phone identity renders different body classes (${ classes.join( ' ' ) })` };
	if ( input.runtimeStyles && runtimeStyleTextDiffers( input.runtimeStyles.desktop, input.runtimeStyles.phone ) ) {
		return { mode: 'dual', reason: 'the phone profile has different runtime-injected style rules' };
	}
	if ( input.structure.differingPaths > 0 && input.renderedDocuments && ! documentsDiffer( input.renderedDocuments.desktop, input.renderedDocuments.phone ) ) {
		return { mode: 'reflow-only', reason: 'the phone DOM differs only in runtime-injected nodes or other differences that export treats as equivalent' };
	}
	if ( input.structure.differingPaths > 0 ) return { mode: 'dual', reason: `the phone profile renders a different DOM (${ input.structure.differingPaths } differing element paths${ input.structure.firstDifference ? `; first: ${ input.structure.firstDifference }` : '' })` };
	return { mode: 'reflow-only', reason: `same HTML and the same ${ input.structure.desktopElements }-element DOM at phone width` };
}

/** Per-route outcome recorded on the manifest entry and summarized in the receipt. */
export interface RouteDeviceDecision {
	mode: DeviceMode;
	reason: string;
	serverHtml?: DeviceModeDecision['serverHtml'];
	/** Request-only evidence; only a rendered pass can populate the covering ledger. */
	inheritedFrom?: string;
	attempts?: number;
	externalScripts?: string[];
	inlineRuntimeHash?: string;
	/** Wall time of the matched-policy desktop/phone check. */
	checkMs?: number;
	/** Milliseconds; navigate and settle are the slower identity's elapsed time (loads run in parallel). */
	checkTimings?: { navigate: number; settle: number; equivalence: number; recheck: number };
	structure?: StructureComparison;
	/** The first reading differed, so both pages were read again after settling. */
	rechecked?: boolean;
	/**
	 * Dual route only: the stylesheet width boundary (a `max-width` value, or
	 * one below a `min-width` value) just above which the phone identity stops
	 * rendering the phone document (see `observeSwitchWidth`). Absent when it
	 * rendered the phone document at every probed width.
	 */
	switchWidth?: number;
	/**
	 * Dual route only: the source renders a third layout, neither the phone nor
	 * the desktop document, from `minWidth` up to `maxWidth` (inclusive; absent
	 * when no later probed boundary changed the rendering). A bounded range is
	 * captured as the `middle` profile at one width inside it, and the copy
	 * selects that document across the range; an unbounded one stays a
	 * `responsive_layout_uncaptured` finding.
	 */
	middleLayout?: MiddleLayout;
}

/** A width-selected source layout between the phone and desktop documents (inclusive bounds). */
export interface MiddleLayout { minWidth: number; maxWidth?: number }

/** Capture profile id of the middle layout's document. */
export const MIDDLE_PROFILE_ID = 'middle';

/** Common tablet widths, preferred in order as the middle range's sample. */
const MIDDLE_SAMPLE_WIDTHS = [ 1024, 768 ];

/**
 * The one viewport width sampled inside a bounded middle range: a common tablet
 * width when the range contains one (so the frozen evidence lands on a width
 * readers and checks actually use), else the range's midpoint. Neither of the
 * source's own boundaries is ever the capture width.
 */
export function middleLayoutSampleWidth( layout: MiddleLayout | undefined ): number | undefined {
	if ( ! layout || layout.maxWidth === undefined || layout.maxWidth < layout.minWidth ) return undefined;
	const inside = ( width: number ): boolean => width > layout.minWidth && width < layout.maxWidth!;
	return MIDDLE_SAMPLE_WIDTHS.find( inside ) ?? Math.floor( ( layout.minWidth + layout.maxWidth ) / 2 );
}

/** Each probe loads the phone identity once more; stop after the nearest few boundaries. */
const SWITCH_PROBE_LIMIT = 4;

/** What the phone identity rendered just above one boundary. */
export type SwitchProbeRendering = 'phone' | 'desktop' | 'other';

/** One probe: its classification against both capture-width documents, plus the rendering itself. */
export interface SwitchProbe< R > {
	rendered: SwitchProbeRendering;
	rendering: R;
}

export interface ObservedSwitch {
	switchWidth: number;
	middleLayout?: MiddleLayout;
}

/**
 * Where a dual route's phone document ends. Candidates are stylesheet width
 * boundaries between the phone and desktop capture widths. The phone identity
 * is loaded just above each one, nearest the phone first, and the first
 * boundary above which it no longer renders the phone document is the switch:
 * the source's own boundary, never a point between the two sampled widths.
 * When that rendering is not the desktop document either, the source has a
 * middle layout. It ends at the first later boundary above which the phone
 * identity stops rendering that middle rendering (`sameRendering`), whether or
 * not what follows matches the desktop identity exactly: a runtime can render
 * the desktop frame for the phone identity with its own injected styles or
 * body classes. The range stays unbounded only when no later boundary changes
 * the rendering. A boundary is never chosen merely for being the widest;
 * rendering the phone document everywhere observes nothing.
 */
export async function observeSwitchWidth< R >(
	candidates: readonly number[],
	range: { phone: number; desktop: number },
	probe: ( width: number ) => Promise< SwitchProbe< R > >,
	sameRendering: ( a: R, b: R ) => boolean,
): Promise< ObservedSwitch | undefined > {
	const widths = [ ...new Set( candidates ) ]
		.filter( width => Number.isInteger( width ) && width >= range.phone && width < range.desktop )
		.sort( ( a, b ) => a - b )
		.slice( 0, SWITCH_PROBE_LIMIT );
	for ( const [ index, width ] of widths.entries() ) {
		const middle = await probe( width + 1 );
		if ( middle.rendered === 'phone' ) continue;
		if ( middle.rendered === 'desktop' ) return { switchWidth: width };
		for ( const wider of widths.slice( index + 1 ) ) {
			const next = await probe( wider + 1 );
			if ( next.rendered === 'desktop' || ! sameRendering( middle.rendering, next.rendering ) ) return { switchWidth: width, middleLayout: { minWidth: width + 1, maxWidth: wider } };
		}
		return { switchWidth: width, middleLayout: { minWidth: width + 1 } };
	}
	return undefined;
}

/**
 * Width boundaries of the page's readable (same-origin) stylesheets, in
 * `max-width` form: a `max-width:N` query switches above N, a `min-width:N`
 * query above N - 1. These are the boundaries `breakpoints.json` records.
 */
export async function stylesheetSwitchBoundaries( page: Page ): Promise< number[] > {
	return page.evaluate( () => {
		const widths = new Set< number >();
		for ( const sheet of Array.from( document.styleSheets ) ) {
			let rules: CSSRuleList;
			try { rules = sheet.cssRules; } catch { continue; }
			for ( const rule of Array.from( rules ) ) {
				if ( ! ( rule instanceof CSSMediaRule ) ) continue;
				for ( const match of rule.conditionText.matchAll( /(min|max)-width:\s*(\d+)px/gi ) ) widths.add( Number( match[ 2 ] ) - ( match[ 1 ]!.toLowerCase() === 'min' ? 1 : 0 ) );
			}
		}
		return [ ...widths ];
	} );
}

export interface RouteDeviceSummary {
	checked: number;
	reflowOnly: number;
	dual: Array< { url: string; reason: string } >;
	checkMs: { total: number; median: number; max: number };
}

export function summarizeRouteDecisions( decisions: ReadonlyArray< { url: string } & RouteDeviceDecision > ): RouteDeviceSummary {
	const times = decisions.map( decision => decision.checkMs ?? 0 ).sort( ( a, b ) => a - b );
	return {
		checked: decisions.length,
		reflowOnly: decisions.filter( decision => decision.mode === 'reflow-only' ).length,
		dual: decisions.filter( decision => decision.mode === 'dual' ).map( ( { url, reason } ) => ( { url, reason } ) ),
		checkMs: { total: times.reduce( ( a, b ) => a + b, 0 ), median: times.length ? times[ Math.floor( ( times.length - 1 ) / 2 ) ]! : 0, max: times.at( -1 ) ?? 0 },
	};
}

/** Resolve real script elements (not strings in comments or inline JavaScript). */
export function externalScriptSources( html: string, url: string ): string[] {
	const $ = load( html );
	const base = new URL( $( 'base[href]' ).first().attr( 'href' ) ?? url, url );
	return [ ...new Set( $( 'script[src]' ).toArray().map( node => new URL( $( node ).attr( 'src' )!, base ).href ) ) ].sort();
}

/** Script types the browser executes; anything else (JSON, ld+json, templates) is data. */
function executesAsScript( type: string | undefined ): boolean {
	const value = ( type ?? '' ).trim().toLowerCase();
	return value === '' || value === 'module' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test( value ) || value === 'text/jscript';
}

/**
 * The shape of inline code. Comments and whitespace are dropped, numbers become
 * a placeholder, and object/array literals built only from literal values
 * (embedded page context, config) collapse innermost-first. String literals in
 * code stay verbatim: a selector or branch string is behaviour. A misread token
 * can only make two shapes differ, which falls back to the rendered check.
 */
export function inlineCodeShape( code: string ): string {
	let out = '';
	for ( let i = 0; i < code.length; ) {
		const char = code[ i ]!;
		const next = code[ i + 1 ];
		if ( char === '/' && next === '/' ) { const end = code.indexOf( '\n', i ); i = end < 0 ? code.length : end; out += ' '; continue; }
		if ( char === '/' && next === '*' ) { const end = code.indexOf( '*/', i + 2 ); i = end < 0 ? code.length : end + 2; out += ' '; continue; }
		if ( char === '"' || char === "'" || char === '`' ) {
			let j = i + 1;
			while ( j < code.length && code[ j ] !== char ) j += code[ j ] === '\\' ? 2 : 1;
			const body = code.slice( i + 1, j );
			// Canonical double-quoted form; templates with substitutions are code.
			out += char === '`' && body.includes( '${' ) ? `\`${ body }\`` : JSON.stringify( body );
			i = j + 1;
			continue;
		}
		if ( /[0-9]/.test( char ) && ! /[\w$]/.test( code[ i - 1 ] ?? '' ) ) {
			const match = /^(?:0[xob][0-9a-f_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[+-]?[0-9]+)?)n?/i.exec( code.slice( i ) )!;
			out += '0';
			i += match[ 0 ].length;
			continue;
		}
		out += char;
		i++;
	}
	out = out.replace( /\s+/g, ' ' );
	const string = String.raw`"(?:[^"\\]|\\.)*"`;
	const value = `(?:${ string }|-?0|true|false|null|D)`;
	const key = `(?:${ string }|[\\w$]+)`;
	const data = new RegExp( String.raw`\{ ?(?:${ key } ?: ?${ value } ?(?:, ?${ key } ?: ?${ value } ?)*,? ?)?\}|\[ ?(?:${ value } ?(?:, ?${ value } ?)*,? ?)?\]`, 'g' );
	for ( let previous = ''; previous !== out; ) { previous = out; out = out.replace( data, 'D' ); }
	// A literal assigned whole to a global is embedded context too (Wix's
	// `window.firstPageId = "c1dmp"`), as the same value inside an object is.
	// Navigation is behaviour, so `location` keeps its target.
	out = out.replace( new RegExp( String.raw`(\bwindow\.(?!location\b)[\w$]+ ?= ?)${ value }(?= ?(?:$|[;,}]|[\w$]))`, 'g' ), '$1D' );
	return out.trim();
}

/**
 * Inline code can be route-specific even with no external script changes.
 * The route's own URL and path are identity, not behaviour, so they are
 * replaced before the shape is taken.
 */
export function inlineRuntimeHash( html: string, url?: string ): string {
	const $ = load( normalizeServerHtml( html ) );
	const self = url ? new URL( url ) : undefined;
	const identities = self ? [ self.href, `${ self.origin }${ self.pathname }`, self.pathname.length > 1 ? self.pathname.replace( /\/$/, '' ) : '' ].filter( Boolean ).sort( ( a, b ) => b.length - a.length ) : [];
	// Whole references only: `/slow` inside `/slow/about` names another route.
	const reference = identities.length ? new RegExp( `(?:${ identities.map( identity => identity.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ).join( '|' ) })(?![\\w%./-])`, 'g' ) : undefined;
	const shape = ( code: string ) => inlineCodeShape( reference ? code.replace( reference, '\u0000ROUTE\u0000' ) : code );
	const code = $( 'script:not([src])' ).toArray().filter( node => executesAsScript( $( node ).attr( 'type' ) ) ).map( node => shape( $( node ).html() ?? '' ) );
	for ( const node of $( '*' ).toArray() ) {
		for ( const [ name, value ] of Object.entries( $( node ).attr() ?? {} ) ) if ( /^on/i.test( name ) ) code.push( `${ name }=${ shape( value ) }` );
	}
	return createHash( 'sha256' ).update( JSON.stringify( code ) ).digest( 'hex' );
}

/** One capture's rendered proofs. A skipped check never creates another proof. */
export class RouteDeviceEvidence {
	private passed = new Map< string, { scripts: readonly string[]; inlineHash: string } >();
	covering( scripts: readonly string[], inlineHash: string ): string | undefined {
		for ( const [ url, known ] of this.passed ) if ( inlineHash === known.inlineHash && scripts.every( src => known.scripts.includes( src ) ) ) return url;
		return undefined;
	}
	record( url: string, scripts: readonly string[], inlineHash: string ): void { this.passed.set( url, { scripts, inlineHash } ); }
}

/** Retry errors and degraded/differing rendered loads once, in fresh contexts. */
export async function retryRouteDeviceCheck( check: () => Promise< RouteDeviceDecision > ): Promise< RouteDeviceDecision > {
	let result: RouteDeviceDecision = { mode: 'dual', reason: 'check unavailable' };
	for ( let attempt = 1; attempt <= 2; attempt++ ) {
		try { result = await check(); }
		catch ( error ) { result = { mode: 'dual', reason: `the phone check failed: ${ String( error ) }` }; }
		result.attempts = attempt;
		if ( result.mode === 'reflow-only' ) break;
	}
	return result;
}
