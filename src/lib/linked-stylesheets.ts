import { dependencyReferences } from './portable-references.js';

/**
 * The text of every stylesheet a page loads from a file rather than holding
 * inline: `<link rel="stylesheet">` targets, `@import`s inside its `<style>`
 * elements (responsive assembly emits width-gated ones), and, recursively, what
 * those sheets import. References are found by the same reader that collects a
 * page's dependencies and resolved against the document or sheet that names
 * them; each URL is read once. `read` returns undefined for a sheet that is not
 * available, and a sheet that cannot be read is skipped.
 */
export function linkedStylesheetTexts( html: string, documentUrl: string, read: ( url: string ) => string | undefined ): string[] {
	const texts: string[] = [];
	const seen = new Set< string >();
	const visit = ( content: string, baseUrl: string, cssOnly: boolean ): void => {
		for ( const dependency of dependencyReferences( content, baseUrl, cssOnly ) ) {
			if ( ! dependency.stylesheet || seen.has( dependency.url ) ) continue;
			seen.add( dependency.url );
			let text: string | undefined;
			try {
				text = read( dependency.url );
			} catch {
				continue;
			}
			if ( text === undefined ) continue;
			texts.push( text );
			visit( text, dependency.url, true );
		}
	};
	visit( html, documentUrl, false );
	return texts;
}
