import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { extname, join } from 'node:path';
import { documentRequestUrl, normalizedUrl } from './url/route-key.js';
import { isSecurityServiceRejection } from './screenshot/navigation-rejection.js';
import { sameHttpSite } from './screenshot/same-origin.js';
import type { CanonicalRouteAlias } from './route-aliases.js';
import type { SourceDataScript } from './source-data.js';
import { IntegrityError } from './failure-class.js';

export interface RouteEntry {
	url: string;
	htmlPath: string;
	canonicalUrl?: string;
	canonicalLinkUrl?: string;
	sourceData: SourceDataScript[];
}

function capturedOriginRoot( urls: string[], origin: string ): boolean {
	return urls.some( ( url ) => {
		try {
			const route = new URL( url );
			return sameHttpSite( url, origin ) && ( route.pathname.replace( /\/$/, '' ) || '/' ) === '/';
		} catch {
			return false;
		}
	} );
}

function routeOutputPath( url: string, sourceUrl: string, entrypointUrl: string, originRootCaptured: boolean ): string | undefined {
	const route = new URL( url );
	const source = new URL( sourceUrl );
	// Artifact paths must retain URL percent-encoding. Decoding turns a valid
	// route such as `%26` into a different filesystem path and breaks route maps.
	// An encoded slash or backslash names one segment, such as a product
	// `Filet_4%2F3.html`; as a file name it would read as a directory to any
	// host that decodes it. Name the file with a hyphen; links follow the route
	// map to it, and a path it now shares is suffixed like any collision.
	let pathname = route.pathname.replace( /%(?:2F|5C)/gi, '-' );
	for ( const segment of pathname.split( '/' ) ) {
		let decoded = segment;
		try {
			decoded = decodeURIComponent( segment );
		} catch {
			// Preserve malformed percent escapes as opaque path bytes.
		}
		if ( decoded === '.' || decoded === '..' || /[\\/\0]/.test( decoded ) )
			return undefined;
	}
	if ( url === entrypointUrl && ! originRootCaptured ) return 'index.html';
	const sourcePath = originRootCaptured ? '' : source.pathname.replace( /\/$/, '' );
	if ( sameHttpSite( url, sourceUrl ) && sourcePath && pathname.startsWith( `${ sourcePath }/` ) ) {
		pathname = pathname.slice( sourcePath.length );
	} else if ( sameHttpSite( url, sourceUrl ) && sourcePath && pathname.replace( /\/$/, '' ) === sourcePath ) {
		pathname = '/';
	}
	const cleanPath = pathname.replace( /^\/+|\/+$/g, '' );
	if ( ! cleanPath ) return 'index.html';
	// A captured route is always an HTML document, so only HTML extensions name
	// its file. Any other extension describes the server that rendered the page
	// (`index.php`, `page.aspx`), not the content, and hosts refuse or execute
	// such files. Export the route like an extensionless one: a directory with a
	// default document, so links, `_redirects` targets and importer slugs follow
	// the same path shape every other document route uses.
	if ( /\.html?$/i.test( cleanPath ) ) return cleanPath;
	return join( cleanPath, 'index.html' );
}

function publicPathname( url: string ): string {
	try {
		const pathname = new URL( url ).pathname;
		if ( ! pathname || pathname === '/' ) return '/';
		return pathname.replace( /\/+$/, '' ) || '/';
	} catch {
		return '';
	}
}

/** Whether a captured page declares the already claimed route as its canonical address. */
function declaresCanonicalRoute( entry: RouteEntry, claimed: RouteEntry ): boolean {
	if ( ! entry.canonicalUrl ) return false;
	const claimedCanonical = claimed.canonicalUrl
		? documentRequestUrl( claimed.canonicalUrl )
		: documentRequestUrl( claimed.url );
	return documentRequestUrl( entry.canonicalUrl ) === claimedCanonical;
}

/**
 * One finding about a route. `unit` names what was lost or degraded (the whole
 * route, one declared capture profile of it, one stylesheet in it, or one block
 * of its evidence); a row without `unit` describes the route.
 */
export interface RouteDiagnostic {
	code: string;
	url: string;
	reason: string;
	unit?: 'route' | 'profile' | 'stylesheet' | 'block' | 'asset';
	severity?: 'warning' | 'error';
	/** The declared capture profile a `profile` finding is about. */
	profile?: string;
	/** The exported file the finding is about. */
	path?: string;
	metrics?: Record< string, number >;
	stopReason?: 'source_blocked_client';
	learnedRateCeiling?: number;
}

function documentIdentity( url: string ): string | undefined {
	try {
		return normalizedUrl( url );
	} catch {
		return undefined;
	}
}

/**
 * Why the capture holds no rendered page for the source URL, from what the
 * capture itself recorded: a failed or absent route, or a server redirect to
 * another route. Undefined when nothing explains the absence.
 */
function entrypointAbsenceReason(
	sourceUrl: string,
	capturedIdentities: ReadonlySet< string >,
	redirectAliases: ReadonlyArray< { url: string; target: string } >,
	routeDiagnostics: ReadonlyArray< RouteDiagnostic >
): string | undefined {
	const sourceIdentity = normalizedUrl( sourceUrl );
	const recorded = routeDiagnostics.find( ( { url } ) => documentIdentity( url ) === sourceIdentity );
	if ( recorded ) {
		const failure = `Source homepage ${ sourceUrl } was not captured: ${ recorded.reason }`;
		if ( isSecurityServiceRejection( recorded.reason ) )
			return `${ failure }. The source's security service refused the request, so its content could not be captured. Try a publicly accessible URL or provide a supported HTML capture.`;
		if ( /\bHTTP 401\b/.test( recorded.reason ) )
			return `${ failure }. The page needs a login; send the published public URL or an export of the site.`;
		if ( /\bHTTP 403\b/.test( recorded.reason ) )
			return `${ failure }. The site refused the request; send a publicly accessible URL or an export.`;
		const nonHtml = /Not an HTML document \(([^)]+)\)/.exec( recorded.reason );
		if ( nonHtml )
			return `${ failure }. The URL returns ${ nonHtml[ 1 ] }, not a web page; send the address of the site's HTML homepage.`;
		return failure;
	}
	const redirect = redirectAliases.find( ( { url } ) => documentIdentity( url ) === sourceIdentity );
	if ( ! redirect ) return undefined;
	const targetIdentity = documentIdentity( redirect.target );
	if ( targetIdentity === undefined )
		return `Source homepage ${ sourceUrl } redirects to ${ redirect.target }, which was not captured`;
	if ( capturedIdentities.has( targetIdentity ) )
		return `Source homepage ${ sourceUrl } redirects to ${ redirect.target }, which was captured as a separate route`;
	const targetRecord = routeDiagnostics.find( ( { url } ) => documentIdentity( url ) === targetIdentity );
	return `Source homepage ${ sourceUrl } redirects to ${ redirect.target }, which was not captured${ targetRecord ? `: ${ targetRecord.reason }` : '' }`;
}

export interface RouteStage<T extends RouteEntry> {
	entrypointUrl: string;
	entrypointEntry: T;
	routePathOf: ( url: string ) => string;
	retainedEntries: T[];
	duplicateRoutes: Array< { url: string; canonicalUrl: string; path: string } >;
	canonicalRouteAliases: Map< string, string >;
	portableRedirects: Array< { from: string; to: string } >;
	missingRedirectTargets: Array< { code: string; url: string; reason: string } >;
	/** Inert metadata carried by collapsed aliases is applied to the retained document. */
	duplicateSourceData: Array< { claimed: T; sourceData: SourceDataScript[] } >;
	/**
	 * Routes dropped because their website path is unsafe or already claimed.
	 * The first claimant keeps the path; the entrypoint always claims first.
	 */
	pathDiagnostics: RouteDiagnostic[];
}

export function allocateCaptureRoutes<T extends RouteEntry>(
	capturedEntries: T[],
	sourceUrl: string,
	redirectAliases: Array< { url: string; target: string } >,
	routeDiagnostics: ReadonlyArray< RouteDiagnostic > = [],
	/** Routes skipped before capture because their rel=canonical is another inventory route (#835). */
	preCaptureAliases: ReadonlyArray< CanonicalRouteAlias > = [],
	/** Adapter-declared asset-loader/bookkeeping attributes, ignored only for content identity. */
	nonContentAttributes: readonly string[] = []
): RouteStage<T> {
	const normalizedSourceUrl = normalizedUrl( sourceUrl );
	const requestedEntrypointCandidates = capturedEntries.filter( ( { url } ) => documentRequestUrl( url ) === documentRequestUrl( sourceUrl ) );
	const exactEntrypointCandidates = requestedEntrypointCandidates.length > 0
		? requestedEntrypointCandidates
		: capturedEntries.filter( ( { url } ) => normalizedUrl( url ) === normalizedSourceUrl );
	const entrypointCandidates = exactEntrypointCandidates.length > 0
		? exactEntrypointCandidates
		: capturedEntries.filter( ( { canonicalUrl } ) => canonicalUrl !== undefined && normalizedUrl( canonicalUrl ) === normalizedSourceUrl );
	if ( entrypointCandidates.length !== 1 ) {
		// A homepage the capture recorded as failed, absent or redirected is not
		// an ambiguous homepage: report the recorded cause so the caller sees it.
		const absence = entrypointCandidates.length === 0
			? entrypointAbsenceReason(
				sourceUrl,
				new Set( capturedEntries.map( ( { url } ) => normalizedUrl( url ) ) ),
				redirectAliases,
				routeDiagnostics
			)
			: undefined;
		throw new Error( absence ?? `Capture does not identify one rendered homepage for the source URL: ${ sourceUrl }` );
	}
	const entrypointUrl = entrypointCandidates[ 0 ].url;
	const originRootCaptured = capturedOriginRoot( capturedEntries.map( ( entry ) => entry.url ), new URL( sourceUrl ).origin );
	const pathDiagnostics: RouteDiagnostic[] = [];
	const unsafePathReason = ( url: string ) => `Captured route path escapes the website directory: ${ new URL( url ).pathname }`;
	capturedEntries = capturedEntries.filter( entry => {
		if ( routeOutputPath( entry.url, sourceUrl, entrypointUrl, originRootCaptured ) !== undefined ) return true;
		if ( entry.url === entrypointUrl ) throw new IntegrityError( unsafePathReason( entry.url ) );
		pathDiagnostics.push( { code: 'route_path_unsafe', url: entry.url, reason: unsafePathReason( entry.url ), unit: 'route', severity: 'error' } );
		return false;
	} );
	const naturalRoutePath = ( url: string ) => {
		const path = routeOutputPath( url, sourceUrl, entrypointUrl, originRootCaptured );
		if ( path === undefined ) throw new IntegrityError( unsafePathReason( url ) );
		return path.replace( /\\/g, '/' );
	};
	const allocatedPaths = new Map< string, string >();
	// Portable paths must also be unique on case-insensitive hosts.
	const pathKey = ( path: string ) => path.toLowerCase();
	const reservedPaths = new Set( capturedEntries.map( ( entry ) => pathKey( naturalRoutePath( entry.url ) ) ) );
	const entryForAddress = ( url: string ): T | undefined => {
		const exact = capturedEntries.find( entry => documentRequestUrl( entry.url ) === documentRequestUrl( url ) );
		if (exact) return exact;
		const candidates = capturedEntries.filter( entry => normalizedUrl( entry.url ) === normalizedUrl( url ) );
		return candidates.length === 1 ? candidates[ 0 ] : undefined;
	};
	// Reserve authored paths first. Every independently captured document gets a
	// confined, deterministic path; comparison-key equality is not alias proof.
	// A path inside a directory another route claims as a file has no free
	// sibling: undefined leaves the route on the contested path, where the claim
	// below drops it as a path collision.
	const allocateCollisionPath = ( path: string, query: boolean, preferred?: string ): string | undefined => {
		if ( [ ...reservedPaths ].some( reserved => pathKey( path ).startsWith( `${ reserved }/` ) ) ) return undefined;
		const extension = extname( path );
		const stem = extension ? path.slice( 0, -extension.length ) : path;
		const conflicts = ( candidate: string ) => [ ...reservedPaths ].some( reserved => reserved === pathKey( candidate ) ||
			reserved.startsWith( `${ pathKey( candidate ) }/` ) || pathKey( candidate ).startsWith( `${ reserved }/` ) );
		if ( preferred && ! conflicts( preferred ) ) {
			reservedPaths.add( pathKey( preferred ) );
			return preferred;
		}
		let suffix = query ? 1 : 2;
		let allocated: string;
		do {
			allocated = `${ stem }-${ query ? 'query-' : '' }${ suffix++ }${ extension }`;
		} while ( conflicts( allocated ) );
		reservedPaths.add( pathKey( allocated ) );
		return allocated;
	};
	// Keep DOM structure, attributes and media (not just text) as identity proof;
	// metadata and executable/style payloads are not page content, and
	// `data-blocks-engine-*` attributes are capture bookkeeping (node ids are
	// numbered per capture, so one document captured twice differs by them).
	// Cache only digests, rather than holding every parsed document in memory.
	const ignoredAttributes = new Set( nonContentAttributes );
	const contentDigests = new Map< T, string >();
	const contentDigest = ( entry: T ): string => {
		const cached = contentDigests.get( entry );
		if ( cached !== undefined ) return cached;
		const $ = cheerio.load( readFileSync( entry.htmlPath, 'utf8' ) );
		$( 'script,style,link,meta,title' ).remove();
		$( '*' ).each( ( _, element ) => {
			if ( element.type !== 'tag' ) return;
			// Whitespace runs inside an attribute value are serialization, not
			// content: a server can indent one embedded JSON value differently per route.
			for ( const name of Object.keys( element.attribs ) ) {
				if ( name.startsWith( 'data-blocks-engine-' ) || ignoredAttributes.has( name ) ) delete element.attribs[ name ];
				else element.attribs[ name ] = element.attribs[ name ].replace( /\s+/g, ' ' ).trim();
			}
			// Compare link targets, not their spelling: a default document and
			// its directory are the same target, including for self-fragments.
			if ( element.attribs.href !== undefined ) {
				try {
					const target = new URL( element.attribs.href, entry.url );
					target.pathname = target.pathname.replace( /\/index\.html$/, '/' );
					// A fragment into the document itself names the same place in
					// any copy of that document, whichever route URL it was captured at.
					const self = new URL( entry.url );
					self.pathname = self.pathname.replace( /\/index\.html$/, '/' );
					self.hash = target.hash;
					const selfFragment = target.href === self.href && ( !! target.hash || element.attribs.href.startsWith( '#' ) );
					element.attribs.href = selfFragment ? target.hash || '#' : target.href;
				} catch {
					// Leave malformed authored links unchanged.
				}
			}
		} );
		const digest = createHash( 'sha256' ).update( $( 'body' ).html()?.trim() ?? '' ).digest( 'hex' );
		contentDigests.set( entry, digest );
		return digest;
	};
	const contentAliasPartners = new Map< string, string >();
	// A directory and its default document (`/` and `/index.html`) share one
	// natural path. They are one route when they render the same document;
	// otherwise reserve natural paths before suffixing.
	for ( const entry of capturedEntries ) {
		const url = new URL( entry.url );
		if ( url.search || url.hash || ! url.pathname.endsWith( '/index.html' ) ) continue;
		const directoryUrl = new URL( './', url ).href;
		const directoryCandidates = capturedEntries.filter( ( candidate ) => {
			const address = new URL( candidate.url );
			address.search = '';
			return normalizedUrl( address.href ) === normalizedUrl( directoryUrl );
		} );
		const directory = entryForAddress( directoryUrl )
			?? ( directoryCandidates.length === 1 ? directoryCandidates[ 0 ] : undefined );
		const path = naturalRoutePath( entry.url );
		if ( ! directory || naturalRoutePath( directoryUrl ) !== path ) continue;
		if ( declaresCanonicalRoute( entry, directory ) || declaresCanonicalRoute( directory, entry ) ) continue;
		if ( contentDigest( entry ) === contentDigest( directory ) ) {
			contentAliasPartners.set( entry.url, directory.url );
			contentAliasPartners.set( directory.url, entry.url );
		}
	}
	// Case variants compete for one portable filename, but case alone is not
	// alias proof: only matching captured content permits collapsing them.
	const caseAlias = ( left: T, right: T ) => {
		const leftPath = naturalRoutePath( left.url );
		const rightPath = naturalRoutePath( right.url );
		return leftPath !== rightPath && pathKey( leftPath ) === pathKey( rightPath ) && contentDigest( left ) === contentDigest( right );
	};
	const routePathOf = ( url: string ) => allocatedPaths.get( url ) ?? naturalRoutePath( url );
	const pathGroups = new Map< string, T[] >();
	for ( const entry of capturedEntries ) {
		const path = pathKey( routePathOf( entry.url ) );
		const group = pathGroups.get( path ) ?? [];
		group.push( entry );
		pathGroups.set( path, group );
	}
	for ( const group of pathGroups.values() ) {
		if ( group.length < 2 ) continue;
		const sorted = [ ...group ].sort( ( left, right ) => left.url.localeCompare( right.url ) );
		// Form proven alias groups before assigning filenames, including aliases
		// of a query rendition rather than just aliases of the base document.
		const clusters: T[][] = [];
		for ( const entry of sorted ) {
			const matching = clusters.filter( cluster => cluster.some( member =>
				declaresCanonicalRoute( entry, member ) || declaresCanonicalRoute( member, entry ) ||
				contentAliasPartners.get( entry.url ) === member.url || caseAlias( entry, member ) ) );
			const cluster = [ entry, ...matching.flat() ];
			for ( const matched of matching ) clusters.splice( clusters.indexOf( matched ), 1 );
			clusters.push( cluster );
		}
		const representatives = clusters.map( cluster => cluster.find( entry => entry.url === entrypointUrl )
			?? cluster.find( entry => ! new URL( entry.url ).search )
			?? cluster.find( entry => cluster.some( alias => alias.canonicalUrl && normalizedUrl( alias.canonicalUrl ) === normalizedUrl( entry.url ) ) )
			?? cluster[ 0 ] );
		const preferred = representatives.find( entry => entry.url === entrypointUrl )
			?? representatives.find( entry => ! new URL( entry.url ).search && !new URL(entry.url).pathname.endsWith('/index.html') )
			?? representatives.find( entry => ! new URL( entry.url ).search ) ?? representatives[ 0 ];
		const path = naturalRoutePath( preferred.url );
		for ( const [ index, entry ] of representatives.entries() ) {
			if ( entry === preferred ) {
				for ( const alias of clusters[ index ] ) allocatedPaths.set( alias.url, path );
				continue;
			}
			const queryUrl = new URL( entry.url );
			const queryValue = queryUrl.searchParams.size === 1 ? queryUrl.searchParams.values().next().value : undefined;
			const directory = path.replace( /\/[^/]*$/, '' );
			// A slug-like value names the rendition; a bare number (pagination) does not.
			const slugPath = queryValue && /^(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/i.test( queryValue )
				? `${ directory ? `${ directory }/` : '' }${ queryValue }/index.html` : undefined;
			const allocated = allocateCollisionPath( path, !!queryUrl.search, slugPath );
			if ( allocated === undefined ) continue;
			for ( const alias of clusters[ index ] ) allocatedPaths.set( alias.url, allocated );
		}
	}
	const retained = new Set< T >();
	const duplicateRoutes: RouteStage<T>[ 'duplicateRoutes' ] = [];
	const canonicalRouteAliases = new Map< string, string >();
	const duplicateSourceData: RouteStage<T>[ 'duplicateSourceData' ] = [];
	const collided = new Map< string, RouteDiagnostic >();
	const claimedRoutes = new Map< string, T >();
	// A claimed file path's parent directories, each with a route inside it: a
	// file there would replace a directory that route needs.
	const claimedDirectories = new Map< string, T >();
	const parentDirectories = ( path: string ) => path.split( '/' ).slice( 0, -1 ).map( ( _, index, parts ) => parts.slice( 0, index + 1 ).join( '/' ) );
	const collide = ( entry: T, routePath: string, reason: string ) => {
		const collision: RouteDiagnostic = { code: 'route_path_collision', url: entry.url, reason, unit: 'route', severity: 'error', path: `website/${ routePath }` };
		pathDiagnostics.push( collision );
		collided.set( entry.url, collision );
	};
	// The entrypoint claims first; the rest claim in URL order, base documents
	// before query renditions, so the first claimant does not depend on capture order.
	for ( const entry of [
		...capturedEntries.filter( ( { url } ) => url === entrypointUrl ),
		...capturedEntries.filter( ( { url } ) => url !== entrypointUrl ).sort( ( left, right ) =>
			Number( !! new URL( left.url ).search ) - Number( !! new URL( right.url ).search ) || left.url.localeCompare( right.url ) ),
	] ) {
		const routePath = routePathOf( entry.url );
		const key = pathKey( routePath );
		const claimed = claimedRoutes.get( key );
		if ( ! claimed ) {
			const inside = claimedDirectories.get( key );
			const fileParent = parentDirectories( key ).find( directory => claimedRoutes.has( directory ) );
			if ( inside ) collide( entry, routePath, `website/${ routePath } is a directory holding the page of ${ inside.url } (website/${ routePathOf( inside.url ) })` );
			else if ( fileParent ) collide( entry, routePath, `website/${ routePath } needs website/${ fileParent } as a directory, which is the page of ${ claimedRoutes.get( fileParent )!.url }` );
			else {
				claimedRoutes.set( key, entry );
				for ( const directory of parentDirectories( key ) ) if ( ! claimedDirectories.has( directory ) ) claimedDirectories.set( directory, entry );
				retained.add( entry );
			}
			continue;
		}
		if ( ! declaresCanonicalRoute( entry, claimed ) && ! declaresCanonicalRoute( claimed, entry ) && contentAliasPartners.get( entry.url ) !== claimed.url && ! caseAlias( entry, claimed ) ) {
			collide( entry, routePath, `website/${ routePath } is already claimed by ${ claimed.url }` );
			continue;
		}
		allocatedPaths.set( entry.url, routePathOf( claimed.url ) );
		if ( entry.sourceData.length > 0 ) duplicateSourceData.push( { claimed, sourceData: entry.sourceData } );
		duplicateRoutes.push( { url: entry.url, canonicalUrl: claimed.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( documentRequestUrl( entry.url ), routePath );
	}
	// Different paths do not compete for an output filename. A canonical link
	// can be stale SPA shell metadata, so require matching rendered content too.
	// Never infer aliases from social metadata, or drop cycles/chains with no final target.
	const canonicalTargets = new Map< T, T >();
	for ( const entry of retained ) {
		if ( entry.url === entrypointUrl || ! entry.canonicalLinkUrl ) continue;
		if ( new URL( entry.canonicalLinkUrl ).origin !== new URL( entry.url ).origin ) continue;
		const target = entryForAddress( entry.canonicalLinkUrl );
		if ( target && target !== entry && retained.has( target ) && contentDigest( entry ) === contentDigest( target ) ) canonicalTargets.set( entry, target );
	}
	for ( const [ entry, target ] of canonicalTargets ) {
		if ( canonicalTargets.has( target ) ) continue;
		const routePath = routePathOf( target.url );
		retained.delete( entry );
		allocatedPaths.set( entry.url, routePath );
		duplicateRoutes.push( { url: entry.url, canonicalUrl: target.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( documentRequestUrl( entry.url ), routePath );
		if ( entry.sourceData.length > 0 ) duplicateSourceData.push( { claimed: target, sourceData: entry.sourceData } );
	}
	// Retained pages keep capture order, entrypoint first.
	const retainedEntries = [
		...capturedEntries.filter( ( { url } ) => url === entrypointUrl ),
		...capturedEntries.filter( entry => entry.url !== entrypointUrl && retained.has( entry ) ),
	];
	const portableRedirects: RouteStage<T>[ 'portableRedirects' ] = [];
	const missingRedirectTargets: RouteStage<T>[ 'missingRedirectTargets' ] = [];
	for ( const { url, target } of redirectAliases ) {
		const targetEntry = entryForAddress( target );
		const dropped = targetEntry && collided.get( targetEntry.url );
		if ( ! targetEntry || dropped ) {
			missingRedirectTargets.push( { code: 'route_capture_failed', url, reason: dropped
				? `redirects to ${ target }, which was dropped: ${ dropped.reason }`
				: `redirects to ${ target }, which was not captured` } );
			continue;
		}
		const routePath = routePathOf( targetEntry.url );
		const destination = `${routePath}${new URL(target).hash}`;
		duplicateRoutes.push( { url, canonicalUrl: targetEntry.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( documentRequestUrl( url ), destination );
		const from = publicPathname( url );
		const to = `/${ destination }`;
		// Path-only static redirect rules cannot distinguish query renditions.
		if ( ! new URL( url ).search && from && from !== to ) portableRedirects.push( { from, to } );
	}
	// Routes whose server-HTML canonical was another inventory route never ran
	// the browser, so their result is recorded here to match a capture that had
	// run them and collapsed them: the canonical route's own page carries the
	// alias's link key, so exported links to the alias resolve to it.
	for ( const { url, canonicalUrl } of preCaptureAliases ) {
		const targetEntry = entryForAddress( canonicalUrl );
		if ( ! targetEntry || ! retained.has( targetEntry ) ) continue;
		const routePath = routePathOf( targetEntry.url );
		duplicateRoutes.push( { url, canonicalUrl: targetEntry.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( documentRequestUrl( url ), routePath );
	}
	return { entrypointUrl, entrypointEntry: entrypointCandidates[ 0 ], routePathOf, retainedEntries, duplicateRoutes, canonicalRouteAliases, portableRedirects, missingRedirectTargets, duplicateSourceData, pathDiagnostics };
}
