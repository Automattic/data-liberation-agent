import * as cheerio from 'cheerio';
import type { HttpAcquisitionProfile, HttpDocumentContext, PreparedHttpDocument, RuntimeRegionRequirement } from '../../platform/acquisition.js';
import { detection } from './detection.js';
import { amebaNextState } from './next-data.js';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Sidebar and article widgets the runtime fills after load; the server sends them empty. */
const RUNTIME_WIDGETS: ReadonlyArray< { selector: string; reason: string } > = [
	{ selector: '.block-type--postsCategory', reason: 'Ameba Ownd loads the category list widget at runtime.' },
	{ selector: '.block-type--postsArchive', reason: 'Ameba Ownd loads the monthly archive widget at runtime.' },
	{ selector: '.block-type--relatedPosts', reason: 'Ameba Ownd loads related posts at runtime.' },
];

const KINDS: Record< string, string > = {
	blog: 'listing',
	blog_post_detail: 'post',
	blog_post_category: 'term-archive',
	blog_post_archive: 'date-archive',
	static: 'page',
};

function isJson( type: string ): boolean {
	return /^application\/(?:ld\+)?json(?:\s*;|$)/i.test( type );
}

/**
 * Ameba Ownd's server documents are complete Next.js renders: the article,
 * list or page content is in the HTML. Executable scripts and the runtime's
 * page state are removed; widgets the runtime fills later stay declared.
 */
export function prepareAmebaDocument( html: string, context: HttpDocumentContext ): PreparedHttpDocument | undefined {
	if ( ! ( detection.sourceSignals ?? [] ).some( signal => signal.pattern.test( html ) ) ) return undefined;
	const state = amebaNextState( html );
	if ( ! state?.routeType ) return undefined;
	const $ = cheerio.load( html );
	const main = $( '[role="main"]' ).first().clone();
	main.find( 'script, style, noscript, template' ).remove();
	if ( ! main.text().replace( /\s+/g, '' ) && ! main.find( 'img[src]' ).length ) return undefined;

	$( 'script' ).each( ( _, element ) => {
		const node = $( element );
		const type = ( node.attr( 'type' ) ?? '' ).trim();
		if ( node.attr( 'id' ) !== '__NEXT_DATA__' && ! node.attr( 'src' ) && isJson( type ) ) {
			try {
				const value: unknown = JSON.parse( node.text() );
				if ( value !== null && typeof value === 'object' ) {
					node.text( JSON.stringify( value ).replace( /</g, '\\u003c' ) );
					return;
				}
			} catch { /* Invalid data is not portable evidence. */ }
		}
		node.remove();
	} );
	$( 'noscript' ).filter( ( _, element ) => /googletagmanager\.com/i.test( $( element ).html() ?? '' ) ).remove();
	$( '*' ).each( ( _, element ) => {
		if ( 'attribs' in element ) for ( const name of Object.keys( element.attribs ) ) if ( /^on/i.test( name ) ) $( element ).removeAttr( name );
	} );
	// The runtime reveals the global navigation once it has measured overflow.
	$( '.global-nav.is-invisible' ).removeClass( 'is-invisible' );

	const browserRegions: RuntimeRegionRequirement[] = RUNTIME_WIDGETS.filter( widget => {
		const nodes = $( widget.selector );
		return nodes.length > 0 && nodes.toArray().every( node => $( node ).children().length === 0 );
	} );
	return {
		html: $.html(),
		...( browserRegions.length ? { browserRegions } : {} ),
		metadata: {
			kind: KINDS[ state.routeType ] ?? 'page',
			route: state.routeType,
			title: $( 'title' ).first().text().trim(),
			canonical: $( 'link[rel="canonical"]' ).first().attr( 'href' ) ?? context.url,
			document: 'ameba-ownd-server-rendered',
			preparation: 'executable-scripts-removed,page-state-removed,navigation-revealed',
			rendering: 'unverified',
			assets: 'not-localized',
			interactions: 'unverified',
			variant: context.variant,
		},
	};
}

/** One desktop document: the platform serves phones the same HTML. */
export const amebaAcquisition: HttpAcquisitionProfile = {
	id: 'ameba-ownd',
	exportVariants: { desktop: 'desktop' },
	variants: [ { id: 'desktop', headers: { 'User-Agent': DESKTOP_UA } } ],
	prepare: prepareAmebaDocument,
};
