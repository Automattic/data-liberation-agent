import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RouteEntry {
	url: string;
	htmlPath: string;
	canonicalUrl?: string;
	jsonLd: string[];
}

export function normalizedUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	parsed.search = '';
	parsed.pathname = parsed.pathname.replace( /\/$/, '' ) || '/';
	return parsed.href;
}

function capturedOriginRoot( urls: string[], origin: string ): boolean {
	return urls.some( ( url ) => {
		try {
			const route = new URL( url );
			return route.origin === origin && ( route.pathname.replace( /\/$/, '' ) || '/' ) === '/';
		} catch {
			return false;
		}
	} );
}

function routeOutputPath( url: string, sourceUrl: string, entrypointUrl: string, originRootCaptured: boolean ): string {
	if ( url === entrypointUrl && ! originRootCaptured ) return 'index.html';
	const route = new URL( url );
	const source = new URL( sourceUrl );
	// Artifact paths must retain URL percent-encoding. Decoding turns a valid
	// route such as `%26` into a different filesystem path and breaks route maps.
	let pathname = route.pathname;
	for ( const segment of pathname.split( '/' ) ) {
		let decoded = segment;
		try {
			decoded = decodeURIComponent( segment );
		} catch {
			// Preserve malformed percent escapes as opaque path bytes.
		}
		if ( decoded === '.' || decoded === '..' || /[\\/\0]/.test( decoded ) )
			throw new Error( `Captured route path escapes the website directory: ${ route.pathname }` );
	}
	const sourcePath = originRootCaptured ? '' : source.pathname.replace( /\/$/, '' );
	if ( route.origin === source.origin && sourcePath && pathname.startsWith( `${ sourcePath }/` ) ) {
		pathname = pathname.slice( sourcePath.length );
	} else if ( route.origin === source.origin && sourcePath && pathname.replace( /\/$/, '' ) === sourcePath ) {
		pathname = '/';
	}
	const cleanPath = pathname.replace( /^\/+|\/+$/g, '' );
	if ( ! cleanPath ) return 'index.html';
	if ( /\.[a-z0-9]+$/i.test( cleanPath ) ) return cleanPath;
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
		? normalizedUrl( claimed.canonicalUrl )
		: normalizedUrl( claimed.url );
	return normalizedUrl( entry.canonicalUrl ) === claimedCanonical;
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
	/** JSON-LD carried by collapsed aliases is applied to the retained document by the orchestrator. */
	duplicateJsonLd: Array< { claimed: T; jsonLd: string[] } >;
}

export function allocateCaptureRoutes<T extends RouteEntry>(
	capturedEntries: T[],
	sourceUrl: string,
	redirectAliases: Array< { url: string; target: string } >
): RouteStage<T> {
	const normalizedSourceUrl = normalizedUrl( sourceUrl );
	const exactEntrypointCandidates = capturedEntries.filter( ( { url } ) => normalizedUrl( url ) === normalizedSourceUrl );
	const entrypointCandidates = exactEntrypointCandidates.length > 0
		? exactEntrypointCandidates
		: capturedEntries.filter( ( { canonicalUrl } ) => canonicalUrl !== undefined && normalizedUrl( canonicalUrl ) === normalizedSourceUrl );
	if ( entrypointCandidates.length !== 1 )
		throw new Error( `Capture does not identify one rendered homepage for the source URL: ${ sourceUrl }` );
	const entrypointUrl = entrypointCandidates[ 0 ].url;
	const originRootCaptured = capturedOriginRoot( capturedEntries.map( ( entry ) => entry.url ), new URL( sourceUrl ).origin );
	const naturalRoutePath = ( url: string ) => routeOutputPath( url, sourceUrl, entrypointUrl, originRootCaptured ).replace( /\\/g, '/' );
	const allocatedPaths = new Map< string, string >();
	const reservedPaths = new Set( capturedEntries.map( ( entry ) => naturalRoutePath( entry.url ) ) );
	// Match query-bearing or fragment-bearing captured URLs to their directory document.
	const entriesByNormalizedUrl = new Map( capturedEntries.map( ( entry ) => [ normalizedUrl( entry.url ), entry ] ) );
	const contentAliasPartners = new Map< string, string >();
	// A directory and default document may be distinct; reserve natural paths before suffixing.
	for ( const entry of capturedEntries ) {
		const url = new URL( entry.url );
		if ( url.search || url.hash || ! url.pathname.endsWith( '/index.html' ) ) continue;
		const directoryUrl = new URL( './', url ).href;
		const directory = entriesByNormalizedUrl.get( normalizedUrl( directoryUrl ) );
		const path = naturalRoutePath( entry.url );
		if ( ! directory || naturalRoutePath( directoryUrl ) !== path ) continue;
		if ( declaresCanonicalRoute( entry, directory ) || declaresCanonicalRoute( directory, entry ) ) continue;
		if ( readFileSync( entry.htmlPath, 'utf8' ) === readFileSync( directory.htmlPath, 'utf8' ) ) {
			contentAliasPartners.set( entry.url, directory.url );
			contentAliasPartners.set( directory.url, entry.url );
			continue;
		}
		const displaced = entry.url === entrypointUrl ? directory : entry;
		if ( [ ...reservedPaths ].some( ( reserved ) => path.startsWith( `${ reserved }/` ) ) )
			throw new Error( `Captured route needs a directory already claimed by a file: ${ path }` );
		let suffix = 2;
		let allocated: string;
		do {
			allocated = `${ path.slice( 0, -'.html'.length ) }-${ suffix++ }.html`;
		} while ( [ ...reservedPaths ].some( ( reserved ) => reserved === allocated || reserved.startsWith( `${ allocated }/` ) ) );
		reservedPaths.add( allocated );
		allocatedPaths.set( displaced.url, allocated );
	}
	const routePathOf = ( url: string ) => allocatedPaths.get( url ) ?? naturalRoutePath( url );
	const retainedEntries: T[] = [];
	const duplicateRoutes: RouteStage<T>[ 'duplicateRoutes' ] = [];
	const canonicalRouteAliases = new Map< string, string >();
	const duplicateJsonLd: RouteStage<T>[ 'duplicateJsonLd' ] = [];
	const claimedRoutes = new Map< string, T >();
	for ( const entry of [
		...capturedEntries.filter( ( { url } ) => url === entrypointUrl ),
		...capturedEntries.filter( ( { url } ) => url !== entrypointUrl ),
	] ) {
		const routePath = routePathOf( entry.url );
		const claimed = claimedRoutes.get( routePath );
		if ( ! claimed ) {
			claimedRoutes.set( routePath, entry );
			retainedEntries.push( entry );
			continue;
		}
		if ( ! declaresCanonicalRoute( entry, claimed ) && contentAliasPartners.get( entry.url ) !== claimed.url )
			throw new Error( `Captured routes resolve to the same website path: ${ routePath }` );
		if ( entry.jsonLd.length > 0 ) duplicateJsonLd.push( { claimed, jsonLd: entry.jsonLd } );
		duplicateRoutes.push( { url: entry.url, canonicalUrl: claimed.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( normalizedUrl( entry.url ), routePath );
	}
	const portableRedirects: RouteStage<T>[ 'portableRedirects' ] = [];
	const missingRedirectTargets: RouteStage<T>[ 'missingRedirectTargets' ] = [];
	for ( const { url, target } of redirectAliases ) {
		const targetEntry = entriesByNormalizedUrl.get( normalizedUrl( target ) );
		if ( ! targetEntry ) {
			missingRedirectTargets.push( { code: 'route_capture_failed', url, reason: `redirects to ${ target }, which was not captured` } );
			continue;
		}
		const routePath = routePathOf( targetEntry.url );
		duplicateRoutes.push( { url, canonicalUrl: targetEntry.url, path: `website/${ routePath }` } );
		canonicalRouteAliases.set( normalizedUrl( url ), routePath );
		const from = publicPathname( url );
		const to = `/${ routePath }`;
		if ( from && from !== to ) portableRedirects.push( { from, to } );
	}
	return { entrypointUrl, entrypointEntry: entrypointCandidates[ 0 ], routePathOf, retainedEntries, duplicateRoutes, canonicalRouteAliases, portableRedirects, missingRedirectTargets, duplicateJsonLd };
}
