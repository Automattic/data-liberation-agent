import * as cheerio from 'cheerio';

/**
 * The tool a source document says produced it, from `<meta name="generator">`.
 * This is evidence about the source, independent of the adapter that captures it:
 * a v0 site is captured as `nextjs` yet declares `v0.app` here.
 */
export function sourceGenerator( html: string ): string | undefined {
	const $ = cheerio.load( html );
	const value = $( 'meta[name]' ).filter( ( _, element ) => $( element ).attr( 'name' )!.trim().toLowerCase() === 'generator' ).first().attr( 'content' )?.trim();
	return value || undefined;
}
