import * as cheerio from 'cheerio';
import { identityLogoReferences } from './identity-resources.js';
import { isInlineUrl } from './self-contain.js';
import { isAudioLink, isDocumentDownloadLink, svgUseDocumentReferences } from './screenshot/resource-capture.js';
import { isSrcsetShaped, rewriteMediaReferences, srcsetCandidates, srcsetReferences } from './srcset.js';
import { URL_TERMINATOR_LOOKAHEAD } from './streaming/media-url-rewrite.js';
import { TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';
export interface PortableDependency {
	reference: string;
	url: string;
	kind: 'resource' | 'media' | 'css';
}


// Substring replacement is only safe for distinct URL-ish tokens (absolute URLs,
// `/media/logo.png`, `images/logo.png`). A single character or punctuation-only
// string (`/`, `//`, `./`) is ordinary HTML/CSS syntax — closing tags, protocol
// separators, relative prefixes — not a specific reference.
export function isSubstitutableReplacementKey( source: string ): boolean {
	return source.length > 1 && /[0-9A-Za-z]/.test( source );
}

export function omitDegenerateReplacements(
	replacements: Map< string, string >,
	rejectedKeys?: Set< string >
): Map< string, string > {
	const values = new Map< string, string >();
	for ( const [ source, local ] of replacements ) {
		if ( ! isSubstitutableReplacementKey( source ) ) {
			if ( source ) rejectedKeys?.add( source );
			continue;
		}
		values.set( source, local );
	}
	return values;
}

export function preparePortableReplacements(
	replacements: Map< string, string >,
	rejectedKeys?: Set< string >
): ( content: string ) => string {
	const values = new Map< string, string >();
	for ( const [ source, local ] of replacements ) {
		if ( ! isSubstitutableReplacementKey( source ) ) {
			if ( source ) rejectedKeys?.add( source );
			continue;
		}
		values.set( source, local );
		values.set( source.replace( /&/g, '&amp;' ), local.replace( /&/g, '&amp;' ) );
	}
	const sources = [ ...values.keys() ]
		.filter( ( source ) => source !== '' && source !== '/' )
		.sort( ( a, b ) => b.length - a.length );
	if ( sources.length === 0 ) return ( content ) => content;
	const pattern = new RegExp(
		'(?:' + sources
			.map( ( source ) => source.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) )
			.join( '|' ) + ')' + URL_TERMINATOR_LOOKAHEAD,
		'g'
	);
	return ( content ) => rewriteMediaReferences(
		content,
		url => values.get( url ) ?? url,
		other => other.replace( pattern, source => values.get( source ) ?? source )
	);
}

export function elementSrcReferences( tag: string, value: string ): string[] {
	const normalized = value.replace( /&amp;/g, '&' ).trim();
	if ( ! normalized ) return [];
	if ( tag === 'img' && isSrcsetShaped( normalized ) ) return srcsetReferences( normalized );
	return [ normalized ];
}

export function dependencyReferences(
	html: string,
	documentUrl: string,
	cssOnly = false,
	embeddedSources: ReadonlySet<string> = new Set()
): PortableDependency[] {
	const searchableHtml = html
		.replace( /&quot;|&#34;|&#x22;/gi, '"' )
		.replace( /&apos;|&#39;|&#x27;/gi, "'" );
	let cssContent = searchableHtml;
	const linkedFiles: string[] = [];
	const svgUseDocuments: string[] = [];
	if ( ! cssOnly ) {
		const $ = cheerio.load( html );
		$( 'iframe[src]' ).each( ( _, element ) => { const source = $( element ).attr( 'src' ) ?? ''; if ( embeddedSources.has( source ) ) linkedFiles.push( source ); } );
		$( 'a[href],area[href]' ).each( ( _, element ) => {
			const href = $( element ).attr( 'href' ) ?? '';
			if ( isAudioLink( href, documentUrl ) || isDocumentDownloadLink( href, documentUrl ) ) linkedFiles.push( href );
		} );
		// Recorded without the fragment, so localizing the sprite file rewrites
		// only its path and every `#symbol` reference into it survives.
		svgUseDocuments.push( ...svgUseDocumentReferences( $, documentUrl ) );
		cssContent = [
			...$( 'style' )
				.map( ( _index, element ) => $( element ).html() ?? '' )
				.get(),
			...$( '[style]' )
				.map( ( _index, element ) => $( element ).attr( 'style' ) ?? '' )
				.get(),
		]
			.join( '\n' )
			.replace( /&quot;|&#34;|&#x22;/gi, '"' )
			.replace( /&apos;|&#39;|&#x27;/gi, "'" );
	}
	const references = new Set< string >();
	const add = ( reference: string | undefined ) => {
		// A data: or blob: reference already carries its bytes (or points at an
		// in-memory object): it is never a network dependency to resolve, so it
		// must not be recorded, let alone reported as unresolved.
		if ( reference && ! isInlineUrl( reference ) ) references.add( reference.replace( /&amp;/g, '&' ) );
	};
	for ( const href of linkedFiles ) add( href );
	for ( const reference of svgUseDocuments ) add( reference );
	if ( ! cssOnly ) for ( const reference of identityLogoReferences( html ) ) add( reference );

	const mediaReferences = new Set< string >();
	const cssReferences = new Set< string >();
	for ( const match of searchableHtml.matchAll(
		/<(img|source|video|audio)\b[^>]*\ssrc\s*=\s*(["'])([\s\S]*?)\2[^>]*>/gi
	) ) {
		for ( const reference of elementSrcReferences( match[ 1 ].toLowerCase(), match[ 3 ] ) ) {
			mediaReferences.add( reference );
			add( reference );
		}
	}
	for ( const match of searchableHtml.matchAll(
		/<video\b[^>]*\bposter\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi
	) ) {
		mediaReferences.add( match[ 2 ].replace( /&amp;/g, '&' ) );
		add( match[ 2 ] );
	}
	for ( const match of searchableHtml.matchAll(
		/<(?:img|source)\b[^>]*\ssrcset\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi
	) ) {
		for ( const reference of srcsetReferences( match[ 2 ] ) ) {
			if ( reference ) {
				mediaReferences.add( reference.replace( /&amp;/g, '&' ) );
				add( reference );
			}
		}
	}
	for ( const match of searchableHtml.matchAll( /<link\b[^>]*>/gi ) ) {
		const tag = match[ 0 ];
		const rel = /\brel\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag )?.[ 2 ].toLowerCase() ?? '';
		const as = /\bas\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag )?.[ 2 ].toLowerCase() ?? '';
		const relations = rel.split( /\s+/ );
		if (
			relations.some( ( value ) => value === 'manifest' || value === 'stylesheet' || /(?:^|-)icon$/.test( value ) ) ||
			( relations.includes( 'preload' ) && [ 'style', 'font', 'image', 'media' ].includes( as ) )
		) {
			add( /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag )?.[ 2 ] );
		}
	}
	for ( const match of searchableHtml.matchAll(
		/\bimport\s+(?:[^"']*?\s+from\s+)?(["'])([\s\S]*?)\1/g
	) ) {
		add( match[ 2 ] );
	}
	for ( const match of cssContent.matchAll(
		/\burl\(\s*(?:(["'])([\s\S]*?)\1|([^\s)'";]+))\s*\)/gi
	) ) {
		const reference = match[ 2 ] ?? match[ 3 ];
		if ( reference && ! reference.startsWith( '#' ) ) {
			cssReferences.add( reference.replace( /&amp;/g, '&' ) );
			add( reference );
		}
	}
	for ( const match of cssContent.matchAll( /@import\s*(?:url\(\s*)?(["'])([\s\S]*?)\1/gi ) ) {
		const reference = match[ 2 ];
		cssReferences.add( reference.replace( /&amp;/g, '&' ) );
		add( reference );
	}

	return [ ...references ].flatMap( ( reference ) => {
		try {
			const url = new URL( reference, documentUrl );
			return [
				{
					reference,
					url: url.href,
					kind: mediaReferences.has( reference )
						? 'media'
						: cssReferences.has( reference )
						? 'css'
						: 'resource',
				},
			];
		} catch {
			return [];
		}
	} );
}

// The largest srcset rendition of an image that was already localized. A lazy
// loader commonly names a full-size original in `src` (and `data-src`) while
// `srcset` carries the width renditions it actually fetched; when only the
// renditions were captured, they are the same picture and must win over a
// blank placeholder.
export function localizedSrcsetRendition(
	tag: string,
	mediaReplacements: Map< string, string >
): string | undefined {
	const srcset = /\ssrcset\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag )?.[ 2 ];
	if ( ! srcset ) return undefined;
	let best: { local: string; size: number } | undefined;
	for ( const candidate of srcsetCandidates( srcset ) ) {
		const local = mediaReplacements.get( candidate.url.replace( /&amp;/g, '&' ) );
		if ( ! local || local === TRANSPARENT_IMAGE_DATA_URL || /^(?:[a-z]+:)?\/\//i.test( local ) )
			continue;
		const size = candidate.size;
		if ( ! best || size > best.size ) best = { local, size };
	}
	return best?.local;
}

export function removeDanglingMediaSource(
	html: string,
	reference: string,
	resolvedUrl: string,
	mediaReplacements: Map< string, string >,
	rejectedKeys?: Set< string >
): string {
	const normalizedReference = reference.replace( /&amp;/g, '&' );
	// A video/source/audio `src` that could not be localized must keep naming
	// a real, fetchable location rather than an empty attribute: an emptied
	// `src` is unrecoverable downstream (a WordPress import, say, drops the
	// element entirely), while the resolved source URL at least survives as
	// external evidence with a matching diagnostic already recorded by the
	// caller. `poster` (an ordinary image, handled below) keeps the existing
	// stub behavior — losing a preview thumbnail is not the same class of
	// loss as losing the media itself.
	let strippedNonImageSrc = false;
	const withoutSources = html.replace( /<(img|source|video|audio)\b[^>]*>/gi, ( tag ) => {
		const element = /^<(\w+)/.exec( tag )?.[ 1 ].toLowerCase();
		const src = /\ssrc\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag )?.[ 2 ].replace( /&amp;/g, '&' );
		if ( src !== normalizedReference ) return tag;
		if ( element === 'img' ) {
			const rendition = localizedSrcsetRendition( tag, mediaReplacements );
			if ( rendition ) {
				// Every attribute naming the original (src, data-src, data-image…)
				// takes the rendition, so no loader or importer resurrects a blank.
				return tag.replace(
					/(\s[^\s=>]+\s*=\s*)(["'])([\s\S]*?)\2/g,
					( attribute, name: string, quote: string, value: string ) =>
						value.replace( /&amp;/g, '&' ) === normalizedReference
							? `${ name }${ quote }${ rendition }${ quote }`
							: attribute
				);
			}
			return tag.replace( /\s+src\s*=\s*(["'])([\s\S]*?)\1/i, ` src="${ TRANSPARENT_IMAGE_DATA_URL }"` );
		}
		strippedNonImageSrc = true;
		return tag.replace( /\s+src\s*=\s*(["'])([\s\S]*?)\1/i, ` src="${ resolvedUrl }"` );
	} );
	// Once a non-image `src` has been repointed at its resolved URL, the
	// broad substring pass below must not run: `resolvedUrl` commonly
	// contains `reference` as a trailing substring (a relative reference
	// resolved against its document), and re-scanning would immediately
	// mangle the replacement it just made.
	if ( strippedNonImageSrc ) return withoutSources;
	if ( ! isSubstitutableReplacementKey( normalizedReference ) ) {
		rejectedKeys?.add( reference );
		return withoutSources;
	}
	// Blank whole occurrences only. The reference is often the bare original of
	// longer rendition URLs — `image.jpg?format=300w` was the old query-shaped
	// case; image services like GoDaddy's append whole path segments instead
	// (`image.jpg/:/` → `image.jpg/:/rs=w:1160,h:720`, so the continuation does
	// not even start with punctuation) — and those longer URLs are different
	// assets, some of them captured. Splicing the blank at such a prefix
	// corrupts the rendition and the loader loses the desktop image entirely.
	// The URL terminator lookahead refuses every partial match: only a
	// reference that stands as the complete URL here gets blanked.
	const variants = [
		...new Set( [ reference, normalizedReference, normalizedReference.replace( /&/g, '&amp;' ) ] ),
	].sort( ( a, b ) => b.length - a.length );
	// Callers run this once per dangling reference over the whole document.
	// When the tag pass already blanked the only occurrence, skip the
	// attribute-aware scan: neither replacement below can match.
	if ( ! variants.some( ( variant ) => withoutSources.includes( variant ) ) ) return withoutSources;
	const pattern = new RegExp(
		`(?:${ variants
			.map( ( variant ) => variant.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) )
			.join( '|' ) })${ URL_TERMINATOR_LOOKAHEAD }`,
		'g'
	);
	return rewriteMediaReferences(
		withoutSources,
		url => variants.includes( url ) ? TRANSPARENT_IMAGE_DATA_URL : url,
		other => other.replace( pattern, TRANSPARENT_IMAGE_DATA_URL )
	);
}

export function replaceDanglingCssUrl(
	html: string,
	reference: string,
	rejectedKeys?: Set< string >
): string {
	// An empty data: URL is a valid, zero-byte resource, so the browser reports a
	// clean load for an asset the capture never got. about:blank cannot be fetched
	// as a subresource, keeping the loss visible instead of silently successful.
	return preparePortableReplacements( new Map( [ [ reference, 'about:blank' ] ] ), rejectedKeys )( html );
}

export function removeDanglingResourceReference( html: string, reference: string ): string {
	const normalizedReference = reference.replace( /&amp;/g, '&' );
	const $ = cheerio.load( html );
	$( 'link' ).each( ( _, element ) => {
		const link = $( element );
		const relations = ( link.attr( 'rel' ) ?? '' ).toLowerCase().split( /\s+/ );
		const href = ( link.attr( 'href' ) ?? '' ).replace( /&amp;/g, '&' );
		if (
			href === normalizedReference &&
			( relations.includes( 'preload' ) ||
				relations.includes( 'stylesheet' ) ||
				relations.some( ( value ) => /(?:^|-)icon$/.test( value ) ) )
		) {
			link.remove();
		}
	} );
	$( 'script' ).each( ( _, element ) => {
		const script = $( element );
		const src = ( script.attr( 'src' ) ?? '' ).replace( /&amp;/g, '&' );
		if ( src === normalizedReference ) script.remove();
	} );
	return $.html();
}
