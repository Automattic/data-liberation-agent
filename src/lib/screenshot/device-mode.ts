import type { Page } from 'playwright';

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
export const STRUCTURE_IGNORED = [ 'script', 'style', 'noscript', 'template', 'invisible (at most 1 px or visibility:hidden) iframes and images appended directly to <body>, such as tracking pixels', 'elements carrying data-lib-* probe markers or capture evidence attributes' ] as const;

export interface DeviceModeDecision {
	mode: DeviceMode;
	requested: DeviceModeRequest;
	/** Why this mode, in one sentence. */
	reason: string;
	/** The entrypoint the probe rendered. */
	url?: string;
	serverHtml?: 'identical' | 'identical-after-normalization' | 'different' | 'unavailable';
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
	/** Element paths present in one document and not the other, counted as a multiset. */
	differingPaths: number;
	firstDifference?: string;
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

/** Compare two element-path lists, both in document order. */
export function compareStructure( desktop: readonly string[], phone: readonly string[] ): StructureComparison {
	const counts = new Map< string, number >();
	for ( const path of desktop ) counts.set( path, ( counts.get( path ) ?? 0 ) + 1 );
	for ( const path of phone ) counts.set( path, ( counts.get( path ) ?? 0 ) - 1 );
	let differingPaths = 0;
	for ( const count of counts.values() ) differingPaths += Math.abs( count );
	const index = desktop.findIndex( ( path, position ) => phone[ position ] !== path );
	const at = index === -1 && desktop.length !== phone.length ? Math.min( desktop.length, phone.length ) : index;
	return {
		desktopElements: desktop.length,
		phoneElements: phone.length,
		differingPaths,
		...( at === -1 ? {} : { firstDifference: `desktop ${ desktop[ at ] ?? '(end)' } / phone ${ phone[ at ] ?? '(end)' }` } ),
	};
}

/**
 * The rendered element-path structure of a page, in document order. A path is
 * the tag chain from `<html>` with each element's position among its kept
 * same-tag siblings, e.g. `html>body>div[2]>nav[1]`. When `mark` is given,
 * elements whose path is in it get that attribute (used to carry a desktop
 * observation onto the same elements of a structurally identical phone page).
 */
export async function renderedElementPaths( page: Page, mark?: { attribute: string; paths: readonly string[] } ): Promise< string[] > {
	return page.evaluate( ( mark ) => {
		const skipped = new Set( [ 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE' ] );
		// Invisible frames and pixels appended to <body> are tracking and messaging
		// channels that third-party scripts inject on their own schedule, not page
		// structure. Responsive content hidden by CSS sits inside layout containers.
		const hiddenFrame = ( element: Element ) => ( element.tagName === 'IFRAME' || element.tagName === 'IMG' ) && element.parentElement === document.body &&
			( ( rect => rect.width <= 1 || rect.height <= 1 )( element.getBoundingClientRect() ) || getComputedStyle( element ).visibility === 'hidden' );
		const owned = ( element: Element ) => Array.from( element.attributes ).some( attribute => /^data-(?:lib|blocks-engine-capture)-/.test( attribute.name ) && attribute.name !== mark?.attribute );
		const marked = mark ? new Set( mark.paths ) : undefined;
		const paths: string[] = [];
		const walk = ( element: Element, prefix: string ) => {
			const seen = new Map< string, number >();
			for ( const child of Array.from( element.children ) ) {
				if ( skipped.has( child.tagName ) || owned( child ) || hiddenFrame( child ) ) continue;
				const tag = child.tagName.toLowerCase();
				const position = ( seen.get( tag ) ?? 0 ) + 1;
				seen.set( tag, position );
				const path = `${ prefix }>${ tag }[${ position }]`;
				paths.push( path );
				if ( marked?.has( path ) ) child.setAttribute( mark!.attribute, '' );
				walk( child, path );
			}
		};
		paths.push( 'html' );
		walk( document.documentElement, 'html' );
		return paths;
	}, mark );
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
		const paths: string[] = [];
		const walk = ( element: Element, prefix: string ) => {
			const seen = new Map< string, number >();
			for ( const child of Array.from( element.children ) ) {
				if ( skipped.has( child.tagName ) || owned( child ) || hiddenFrame( child ) ) continue;
				const tag = child.tagName.toLowerCase();
				const position = ( seen.get( tag ) ?? 0 ) + 1;
				seen.set( tag, position );
				const path = `${ prefix }>${ tag }[${ position }]`;
				if ( child.matches( control ) && visible( child ) ) paths.push( path );
				walk( child, path );
			}
		};
		walk( document.documentElement, 'html' );
		return paths;
	} );
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

/** One route's decision under a `reflow-only` site, from its cheap phone check. */
export function decideRouteMode( input: {
	serverHtml?: DeviceModeDecision['serverHtml'];
	structure?: StructureComparison;
	bodyClasses?: { desktopOnly: string[]; phoneOnly: string[] };
	error?: string;
} ): Pick< DeviceModeDecision, 'mode' | 'reason' > {
	if ( input.error ) return { mode: 'dual', reason: `the phone check failed: ${ input.error }` };
	if ( input.serverHtml === 'different' ) return { mode: 'dual', reason: 'the route serves different HTML to the desktop and phone identities' };
	if ( input.serverHtml !== 'identical' && input.serverHtml !== 'identical-after-normalization' ) return { mode: 'dual', reason: 'the route server HTML could not be compared' };
	if ( ! input.structure ) return { mode: 'dual', reason: 'the rendered structure could not be compared' };
	const classes = input.bodyClasses ? [ ...input.bodyClasses.desktopOnly.map( token => `-${ token }` ), ...input.bodyClasses.phoneOnly.map( token => `+${ token }` ) ] : [];
	if ( classes.length ) return { mode: 'dual', reason: `the phone identity renders different body classes (${ classes.join( ' ' ) })` };
	if ( input.structure.differingPaths > 0 ) return { mode: 'dual', reason: `the phone profile renders a different DOM (${ input.structure.differingPaths } differing element paths${ input.structure.firstDifference ? `; first: ${ input.structure.firstDifference }` : '' })` };
	return { mode: 'reflow-only', reason: `same HTML and the same ${ input.structure.desktopElements }-element DOM at phone width` };
}

/** Per-route outcome recorded on the manifest entry and summarized in the receipt. */
export interface RouteDeviceDecision {
	mode: DeviceMode;
	reason: string;
	/** Wall time of the cheap phone check (both identities, in parallel). */
	checkMs?: number;
	structure?: StructureComparison;
	/** The first reading differed, so both pages were read again after settling. */
	rechecked?: boolean;
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
