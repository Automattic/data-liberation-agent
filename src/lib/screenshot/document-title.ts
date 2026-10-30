import { scanHtmlTags } from './document-integrity.js';

const escapeTitle = ( title: string ): string => title.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );

/**
 * Give the serialized document exactly one head `<title>`, holding the title
 * the live page reported (`document.title`).
 *
 * A client renderer can hoist its own `<title>` ahead of the server-rendered
 * ones, or leave several behind. The browser names the page by the first, but
 * a capture that keeps them all, or loses the hoisted one, hands every later
 * stage a site-wide placeholder (Medium's `<title>Medium</title>`) as the
 * page's name. The first title keeps its place; the rest are dropped.
 */
export function withDocumentTitle( html: string, documentTitle: string ): string {
	let headStart = -1;
	let headEnd = -1;
	const titles: Array< { start: number; end: number } > = [];
	let open: number | undefined;
	scanHtmlTags( html, ( tag ) => {
		if ( tag.name === 'head' && ! tag.closing && headStart === -1 ) {
			headStart = tag.end;
			return false;
		}
		if ( ( tag.name === 'head' && tag.closing ) || ( tag.name === 'body' && ! tag.closing ) ) {
			headEnd = tag.start;
			return true;
		}
		if ( tag.name !== 'title' ) return false;
		if ( ! tag.closing ) open ??= tag.start;
		else if ( open !== undefined ) {
			titles.push( { start: open, end: tag.end } );
			open = undefined;
		}
		return false;
	} );
	if ( headStart === -1 ) return html;
	const element = `<title>${ escapeTitle( documentTitle ) }</title>`;
	const inHead = titles.filter( ( title ) => title.start >= headStart && ( headEnd === -1 || title.end <= headEnd ) );
	if ( inHead.length === 0 ) return documentTitle === '' ? html : html.slice( 0, headStart ) + element + html.slice( headStart );
	let result = html;
	for ( let index = inHead.length - 1; index >= 0; index-- ) {
		const { start, end } = inHead[ index ]!;
		result = result.slice( 0, start ) + ( index === 0 ? element : '' ) + result.slice( end );
	}
	return result;
}
