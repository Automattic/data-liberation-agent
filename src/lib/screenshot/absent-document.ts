import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import { readDocument } from '../parsed-documents.js';

export function isAbsentDocumentStatus( status: number ): boolean {
	return status === 404 || status === 410;
}

export function isAbsentDocumentError( error: string ): boolean {
	return /^HTTP (404|410)\b/.test( error ) || error.startsWith( NOT_HTML_DOCUMENT );
}

const NOT_HTML_DOCUMENT = 'Not an HTML document';

/**
 * A discovered URL whose response is not HTML (a sitemap-listed `agents.md`,
 * a feed, a PDF) has no page to capture: the browser would only render its
 * built-in text or file viewer. It is absent as a page, like a 404.
 */
export function nonHtmlDocumentError( contentType: string | undefined ): string | undefined {
	const type = ( contentType ?? '' ).split( ';' )[ 0 ].trim().toLowerCase();
	if ( ! type || type === 'text/html' || type === 'application/xhtml+xml' ) return undefined;
	return `${ NOT_HTML_DOCUMENT } (${ type })`;
}

/** A rendered document this thin (or thinner) is a candidate for being a
 * client-routed not-found screen rather than a real page. Chosen from the
 * real mint-brand-vote.base44.app capture this guards: its two not-found
 * routes render 87 and 91 characters of body text, while every real route
 * in the same app -- including ones that are themselves short empty states
 * ("Access Denied", "Sign in to Vote") -- renders at least 228, comfortably
 * clear of this ceiling with room for another platform's phrasing to run
 * longer.
 */
const ABSENT_DOCUMENT_MAX_BODY_TEXT_LENGTH = 600;

/** A heading whose *entire* text is just the absent-document status number,
 * with nothing else in it (not "Room 404", not "404 Handbook"). */
const ABSENT_DOCUMENT_HEADING_TEXT = /^(404|410)$/;

/**
 * A client-routed SPA serves every route as HTTP 200 and renders its own
 * not-found screen in JavaScript, so `isAbsentDocumentStatus`/
 * `isAbsentDocumentError` -- which only inspect the HTTP layer -- never see
 * it. This looks for the DOM analogue of the same signal instead: a heading
 * whose whole text is the absent-document status code itself, on a document
 * thin enough that it plausibly *is* that fallback screen rather than a real
 * page that happens to mention the number in passing.
 *
 * Deliberately structural, not textual-English or vendor-specific: it never
 * matches a phrase like "Page Not Found" (that string is one platform's
 * wording, and doesn't exist in another's), and it never matches a vendor
 * name. Status numerals are the same protocol convention #257 already treats
 * as authoritative on the HTTP status line. Screens without numerals need
 * the separate nonce-sibling corroboration below.
 *
 * Both conditions are required so this only fires on documents that are
 * simultaneously (a) declaring themselves to be exactly that status and
 * (b) too thin to be a real page that happens to mention it. Either alone
 * is too weak: a heading of just "404" on a long real document (an article
 * about HTTP status codes, a hotel room number) would misfire on (a) alone;
 * a short real empty state ("Access Denied", "Sign in to vote") would
 * misfire on (b) alone.
 */
export function isAbsentDocumentRender( html: string ): boolean {
	const $ = readDocument( html );
	const bodyText = $( 'body' ).text().replace( /\s+/g, ' ' ).trim();
	if ( bodyText.length === 0 || bodyText.length > ABSENT_DOCUMENT_MAX_BODY_TEXT_LENGTH ) {
		return false;
	}
	let hasAbsentDocumentHeading = false;
	$( 'h1, h2, h3, h4, h5, h6' ).each( ( _, el ) => {
		const text = $( el ).text().replace( /\s+/g, ' ' ).trim();
		if ( ABSENT_DOCUMENT_HEADING_TEXT.test( text ) ) hasAbsentDocumentHeading = true;
	} );
	return hasAbsentDocumentHeading;
}

/** Content-only signature: landmarks are shared chrome, not route evidence.
 * Ignore machinery and the requested slug, but retain media/control identity so
 * equally short pages with different non-text content do not become matches. */
export function absentDocumentSignature( html: string, url: string ): string | undefined {
	// Private parse: this removes chrome, so it must not mutate a shared readDocument() tree.
	const $ = cheerio.load( html );
	$( 'script, style, noscript, template, header, footer, nav, [role="banner"], [role="navigation"], [role="contentinfo"]' ).remove();
	const main = $( 'main, [role="main"]' ).first();
	const content = main.length ? main : $( 'body' );
	let text = content.text().replace( /\s+/g, ' ' ).trim();
	if ( ! text || text.length > ABSENT_DOCUMENT_MAX_BODY_TEXT_LENGTH ) return undefined;
	const slug = new URL( url ).pathname.replace( /\/$/, '' ).split( '/' ).pop() ?? '';
	let decoded = slug;
	try { decoded = decodeURIComponent( slug ); } catch { /* Keep malformed escapes literal. */ }
	for ( const value of new Set( [ slug, decoded ] ) ) {
		if ( value ) text = text.split( value ).join( '' );
	}
	const media = content.find( CONTENT_BEARING_ELEMENTS ).map( ( _, element ) => {
		const node = $( element );
		return [ element.tagName, node.attr( 'src' ), node.attr( 'alt' ), node.attr( 'type' ), node.attr( 'name' ) ].join( ':' );
	} ).get();
	return JSON.stringify( [ text.replace( /\s+/g, ' ' ).trim(), media ] );
}

export interface AbsentSiblingRender { status: number; html: string }

/** One render per parent, including failed/HTTP-404 probes. Store the promise
 * before awaiting it so concurrent children cannot duplicate the probe. */
export class AbsentDocumentProbes {
	private readonly parents = new Map< string, Promise< string | undefined > >();

	async matches( url: string, html: string, render: ( url: string ) => Promise< AbsentSiblingRender | undefined > ): Promise< boolean > {
		const signature = absentDocumentSignature( html, url );
		if ( ! signature ) return false;
		const route = new URL( url );
		route.search = '';
		route.hash = '';
		route.pathname = route.pathname.replace( /\/$/, '' ).replace( /[^/]*$/, '' );
		const parent = route.href;
		let probe = this.parents.get( parent );
		if ( ! probe ) {
			route.pathname += `liberation-absent-${ randomUUID() }`;
			const sibling = route.href;
			probe = render( sibling ).then( result => result && result.status === 200
				? absentDocumentSignature( result.html, sibling ) : undefined );
			this.parents.set( parent, probe );
		}
		return signature === await probe;
	}
}

/** Elements whose presence makes a text-free body a real page: visible or
 * interactive content a reader could still perceive. script/style/noscript/
 * template/link/meta are machinery, not content, so they never count. */
const CONTENT_BEARING_ELEMENTS =
	'img, picture, video, audio, iframe, embed, object, svg, canvas, input, select, textarea, button';

/**
 * A route whose rendered body carries no non-whitespace text and no
 * content-bearing element is not a page a reader can see -- a client-routed
 * app that answered an unknown route by rendering nothing, for example.
 * Exporting it produces a blank document that a downstream importer then
 * chokes on, so callers treat it like an absent document. Purely structural:
 * no vendor markup, no English phrasing, just "is there anything here".
 */
export function isEmptyDocumentRender( html: string ): boolean {
	const $ = readDocument( html );
	const body = $( 'body' ).clone();
	body.find( 'script, style, noscript, template' ).remove();
	if ( body.text().trim().length > 0 ) return false;
	return body.find( CONTENT_BEARING_ELEMENTS ).length === 0;
}

export function failuresAreAbsentDocument(
	failures: Array< { url?: unknown; error?: unknown } >,
	url: string
): boolean {
	const forUrl = failures.filter( ( failure ) => failure.url === url );
	return (
		forUrl.length > 0 &&
		forUrl.every(
			( failure ) =>
				typeof failure.error === 'string' && isAbsentDocumentError( failure.error )
		)
	);
}

export function isSourceCaptureUrl( url: string, sourceUrl: string | undefined ): boolean {
	if ( ! sourceUrl ) return false;
	try {
		return normalizeRoute( url ) === normalizeRoute( sourceUrl );
	} catch {
		return url === sourceUrl;
	}
}

function normalizeRoute( url: string ): string {
	const route = new URL( url );
	route.hash = '';
	route.search = '';
	route.pathname = route.pathname.replace( /\/$/, '' ) || '/';
	return route.href;
}
