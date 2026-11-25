import * as cheerio from 'cheerio';
import { amebaDisplayDate } from './content.js';

/** `<time datetime="2024-03-14T18:42:03Z">2024.03.14 14:42</time>`: the runtime's local-time label. */
const TIME_LABEL = /(<time\b[^>]*\bdatetime\s*=\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"[^>]*>)\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}(<\/time>)/gi;

/**
 * One spelling for what the server and a browser render differently.
 *
 * - Dates: the server labels every `<time>` in Japan time, the site's own
 *   zone; the runtime relabels them in the browser's zone once it mounts, so a
 *   capture made elsewhere shows other days and hours. Labels are restored to
 *   site time from their `datetime`.
 * - Root: the served document wraps the site in Next.js's `<div id="__next">`;
 *   once mounted the page sits directly in `#content`. Unwrapping the server
 *   root gives both documents one element path to the same content.
 */
export function canonicalizeAmebaHtml( html: string ): string {
	const labelled = html.replace( TIME_LABEL, ( _match, open: string, datetime: string, close: string ) => `${ open }${ amebaDisplayDate( datetime ) }${ close }` );
	if ( ! /\bid\s*=\s*["']__next["']/.test( labelled ) ) return labelled;
	const $ = cheerio.load( labelled );
	const root = $( '#content > #__next' );
	if ( root.length !== 1 ) return labelled;
	root.replaceWith( root.contents() );
	return $.html();
}
