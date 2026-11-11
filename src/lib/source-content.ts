import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';

/** Elements that are page content without carrying text of their own. */
const CONTENT_ELEMENTS = 'img,picture,video,audio,svg,canvas,iframe,embed,object,a[href],button,select,textarea,input:not([type="hidden" i])';

/**
 * The source's entry page has nothing to copy after source cleanup: no visible
 * text and no media, embed, link or form control. A parked, suspended,
 * placeholder or blank page has nothing to import, so capture refuses it rather than
 * hand the importer an empty document.
 */
export class SourceHasNoContentError extends Error {
	readonly code = 'source_has_no_content';

	constructor( readonly requestedUrl: string, readonly finalUrl: string, readonly title?: string ) {
		const redirect = finalUrl !== requestedUrl ? ` (redirected to ${ finalUrl })` : '';
		const named = title ? ` titled "${ title }"` : '';
		super( `The source ${ requestedUrl }${ redirect } returned a page${ named } with no content. The site may be offline, suspended, parked, or blank.` );
		this.name = 'SourceHasNoContentError';
	}
}

/** Throw `SourceHasNoContentError` when the exported entrypoint, `website/index.html`, has no content. */
export function assertEntrypointHasContent( outputDir: string, requestedUrl: string, finalUrl: string ): void {
	const entrypoint = join( outputDir, 'website', 'index.html' );
	if ( ! existsSync( entrypoint ) ) return;
	const $ = cheerio.load( readFileSync( entrypoint, 'utf8' ) );
	const body = $( 'body' );
	body.find( 'script,style,noscript,template' ).remove();
	if ( body.text().trim() !== '' || body.find( CONTENT_ELEMENTS ).length > 0 ) return;
	const title = $( 'head > title' ).first().text().trim() || undefined;
	throw new SourceHasNoContentError( requestedUrl, finalUrl, title ); // failure-class: operational
}
