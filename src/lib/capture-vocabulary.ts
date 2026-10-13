import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyNode, Element } from 'domhandler';
import { parseLocatedStructure } from './site-includes.js';

/**
 * Producer-neutral capture-evidence vocabulary (#787, part of #761).
 *
 * Blocks Engine owns the capture-evidence names it reads, in its own
 * namespace. This producer's names map onto them by one mechanical rule, with
 * values and semantics unchanged. The rule is lexical, so it applies the same
 * way to an attribute name and to a class token:
 *
 *   data-dla-<name>        -> data-blocks-engine-capture-<name>
 *   data-liberation-<name> -> data-blocks-engine-capture-<name>
 *   dla-<name>             -> blocks-engine-capture-<name>   (class tokens only)
 *
 * Rollout step 1 writes both the producer and the neutral names, so consumers
 * can switch readers without a mismatched release pair. Step 3 replaces the
 * producer name instead of mirroring it: the splice in `mirroredMarkup()` is the
 * single point that changes. See docs/contracts/capture-evidence.md.
 */
export const CAPTURE_VOCABULARY_RULES = [
	{ producer: 'data-dla-', neutral: 'data-blocks-engine-capture-', attribute: true },
	{ producer: 'data-liberation-', neutral: 'data-blocks-engine-capture-', attribute: true },
	{ producer: 'dla-', neutral: 'blocks-engine-capture-', attribute: false },
] as const;

/**
 * Neutral name for a producer attribute name or class token, if the rule names
 * one. Attribute names are case-insensitive and come back lowercase; class
 * tokens are case-sensitive, so their suffix is kept as written.
 */
export function neutralCaptureName( name: string, kind: 'attribute' | 'class' ): string | undefined {
	const candidate = kind === 'attribute' ? name.toLowerCase() : name;
	for ( const rule of CAPTURE_VOCABULARY_RULES ) {
		if ( kind === 'attribute' && ! rule.attribute ) continue;
		if ( candidate.startsWith( rule.producer ) && candidate.length > rule.producer.length ) {
			return `${ rule.neutral }${ candidate.slice( rule.producer.length ) }`;
		}
	}
	return undefined;
}

// Cheap gate: most strings (and many documents) hold no producer name at all.
const PRODUCER_NAME = /(?:data-dla-|data-liberation-|\bdla-)/i;

interface AttributeLocation { startOffset: number; endOffset: number }

function startTagAttributes( node: Element ): Record< string, AttributeLocation > | undefined {
	return ( node as Element & { sourceCodeLocation?: { startTag?: { attrs?: Record< string, AttributeLocation > } } } )
		.sourceCodeLocation?.startTag?.attrs;
}

/**
 * Write the neutral name beside every producer attribute and class token in
 * an HTML document or fragment.
 *
 * Every other byte is preserved: the parse only locates start-tag attributes,
 * and the neutral attribute is spliced in directly after its producer
 * attribute, copying the producer's own value text (quoting and entities
 * included) so the two values are identical. Neutral class tokens are appended
 * to the same `class` value. Markup that HTML tree construction discards (a
 * stray `<tr>` outside a table) or keeps as text (`<noscript>` content) has no
 * start-tag location and is left as is.
 * Idempotent: a neutral name already present is not written again.
 */
export function mirrorCaptureVocabulary( html: string ): string {
	if ( ! PRODUCER_NAME.test( html ) ) return html;
	const $ = parseLocatedStructure( html );
	const splices: Array< { at: number; end: number; text: string } > = [];
	// Iterative walk: captured documents can nest deeper than the call stack.
	const pending: AnyNode[] = $.root().contents().toArray();
	for ( let node = pending.pop(); node; node = pending.pop() ) {
		if ( node.type === 'tag' || node.type === 'script' || node.type === 'style' ) {
			const element = node as Element;
			const locations = startTagAttributes( element );
			if ( locations ) for ( const splice of mirroredMarkup( html, element, locations ) ) splices.push( splice );
		}
		if ( 'children' in node ) for ( const child of node.children ) pending.push( child );
	}
	if ( ! splices.length ) return html;
	// Splices never overlap: each covers its own attribute. Join once.
	splices.sort( ( a, b ) => a.at - b.at );
	const parts: string[] = [];
	let cursor = 0;
	for ( const splice of splices ) {
		parts.push( html.slice( cursor, splice.at ), splice.text );
		cursor = splice.end;
	}
	parts.push( html.slice( cursor ) );
	return parts.join( '' );
}

function mirroredMarkup( html: string, element: Element, locations: Record< string, AttributeLocation > ): Array< { at: number; end: number; text: string } > {
	const splices: Array< { at: number; end: number; text: string } > = [];
	const present = new Set( Object.keys( element.attribs ) );
	for ( const [ name, location ] of Object.entries( locations ) ) {
		if ( name === 'class' ) {
			const splice = mirroredClassValue( html, element.attribs.class ?? '', location );
			if ( splice ) splices.push( splice );
			continue;
		}
		const neutral = neutralCaptureName( name, 'attribute' );
		if ( ! neutral || present.has( neutral ) ) continue;
		present.add( neutral );
		// `name`, `name=value`, `name="value"` or `name='value'`: keep the value text verbatim.
		const source = html.slice( location.startOffset, location.endOffset );
		splices.push( { at: location.endOffset, end: location.endOffset, text: ` ${ neutral }${ source.slice( name.length ) }` } );
	}
	return splices;
}

function mirroredClassValue( html: string, value: string, location: AttributeLocation ): { at: number; end: number; text: string } | undefined {
	const tokens = value.split( /[\t\n\f\r ]+/ ).filter( Boolean );
	const present = new Set( tokens );
	const added: string[] = [];
	for ( const token of tokens ) {
		const neutral = neutralCaptureName( token, 'class' );
		if ( ! neutral || present.has( neutral ) ) continue;
		present.add( neutral );
		added.push( neutral );
	}
	if ( ! added.length ) return undefined;
	const source = html.slice( location.startOffset, location.endOffset );
	const quote = source.at( -1 );
	// A quoted value gains the tokens before its closing quote; an unquoted
	// value (no whitespace by definition) is rewritten as a quoted one.
	if ( ( quote === '"' || quote === "'" ) && /=\s*["']/.test( source ) ) {
		return { at: location.endOffset - 1, end: location.endOffset - 1, text: ` ${ added.join( ' ' ) }` };
	}
	const separator = tokens.length ? ' ' : '';
	return { at: location.startOffset, end: location.endOffset, text: `class="${ escapeAttribute( value.trim() ) }${ separator }${ added.join( ' ' ) }"` };
}

function escapeAttribute( value: string ): string {
	return value.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' );
}

/** Mirror the vocabulary in every HTML document under an exported website directory. */
export function mirrorWebsiteCaptureVocabulary( websiteDir: string ): void {
	for ( const entry of readdirSync( websiteDir, { withFileTypes: true } ) ) {
		const path = join( websiteDir, entry.name );
		if ( entry.isDirectory() ) mirrorWebsiteCaptureVocabulary( path );
		else if ( entry.isFile() && /\.html?$/i.test( entry.name ) ) {
			const html = readFileSync( path, 'utf8' );
			const mirrored = mirrorCaptureVocabulary( html );
			if ( mirrored !== html ) writeFileSync( path, mirrored );
		}
	}
}
