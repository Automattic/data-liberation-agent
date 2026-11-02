import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { parseSelectorList, projectStylesheet } from '../replicate/css-scope.js';
import { resolveDocumentReferences } from '../document-resource-base.js';
import { DEFAULT_SWEEP_WIDTHS } from './fluid-capture.js';
import { withEvaluateTimeout } from './page-helpers.js';

// Reuse the fluid ladder's tablet/desktop probes; never pay for its dense
// transition refinement when observing class sets alone.
const ROOT_CLASS_WIDTHS = DEFAULT_SWEEP_WIDTHS.filter( width => [ 768, 1024, 1280 ].includes( width ) );

export interface RootClassSample {
	width: number;
	html: string[];
	body: string[];
}
export interface RootClassContract {
	root: 'html' | 'body';
	class: string;
	minWidth: number;
	maxWidth: number;
	/** Observations, not an assertion of an exact source breakpoint. */
	evidence: RootClassSample[];
}

/** Only bounded, contiguous runs absent at the capture width are projected.
 * A transition is placed at the next observed width, never extrapolated past
 * the sampled desktop domain. Disjoint runs may be stateful, so stay unknown.
 */
export function rootClassContracts( samples: RootClassSample[] ): RootClassContract[] {
	const sorted = [ ...samples ].sort( ( a, b ) => a.width - b.width );
	if ( sorted.length < 2 ) return [];
	const contracts: RootClassContract[] = [];
	for ( const root of [ 'html', 'body' ] as const ) {
		const names = new Set( sorted.flatMap( sample => sample[ root ] ) );
		for ( const name of names ) {
			if ( sorted.at( -1 )![ root ].includes( name ) ) continue;
			const indices = sorted.flatMap( ( sample, index ) => sample[ root ].includes( name ) ? [ index ] : [] );
			const first = indices[ 0 ], last = indices.at( -1 );
			if ( first === undefined || last === undefined || last - first + 1 !== indices.length ) continue;
			contracts.push( { root, class: name, minWidth: sorted[ first ]!.width, maxWidth: sorted[ last + 1 ]!.width - 1, evidence: sorted } );
		}
	}
	return contracts;
}

/** Observe sets, not class attribute order. A debounce may leave the old set
 * unchanged for several frames, so require 500ms of quiet, not just two frames.
 * Node owns the deadline and sleeps: source timers must not control the bound.
 */
async function stableRootClasses( page: Page ): Promise<RootClassSample | undefined> {
	const deadline = Date.now() + 1500;
	let previous = '';
	let quietSince = Date.now();
	while ( Date.now() < deadline ) {
		// A background/throttled page may not produce a frame. Do not let it
		// hold capture indefinitely; no frame means no proven observation.
		const sample = await Promise.race( [
			page.evaluate( () => new Promise<RootClassSample>( resolve => requestAnimationFrame( () => resolve( {
				width: innerWidth, html: [ ...document.documentElement.classList ].sort(), body: [ ...document.body.classList ].sort(),
			} ) ) ) ),
			delay( Math.min( 100, Math.max( 0, deadline - Date.now() ) ) ).then( () => undefined ),
		] );
		if ( ! sample ) return undefined;
		const signature = JSON.stringify( sample );
		if ( signature !== previous ) {
			previous = signature;
			quietSince = Date.now();
		} else if ( Date.now() - quietSince >= 500 ) {
			return sample;
		}
		await delay( 50 );
	}
	return undefined;
}

/** Four resizes at most, no navigation, including restoration. An unstable
 * width (including restoration) invalidates the entire ladder: dropping just
 * that sample would invent a range across an unproven gap.
 */
export async function sampleRootClasses( page: Page, widths: readonly number[] = ROOT_CLASS_WIDTHS ): Promise<RootClassContract[]> {
	const original = page.viewportSize();
	if ( ! original ) return [];
	const samples: RootClassSample[] = [];
	let proven = true;
	const sample = async () => {
		const observation = await stableRootClasses( page );
		if ( observation ) samples.push( observation );
		else proven = false;
	};
	try {
		await sample();
		for ( const width of [ ...new Set( widths ) ].filter( width => width >= 768 && width < original.width ).sort( ( a, b ) => a - b ).slice( 0, 3 ) ) {
			await withEvaluateTimeout( page.setViewportSize( { ...original, width } ), 1500 );
			await sample();
		}
	} finally {
		await withEvaluateTimeout( page.setViewportSize( original ), 1500 );
		if ( ! await stableRootClasses( page ) ) proven = false;
	}
	return proven ? rootClassContracts( samples ) : [];
}

/** Keep rules in cascade position and inside their authored at-rule context.
 * Root aliases are ordinary selectors: subsequent rootCss/scopeCss projection
 * can carry them onto either real roots or responsive document wrappers.
 */
export function projectRootClassContracts( html: string, contracts: RootClassContract[], linkedSheet: ( href: string ) => { css: string; url: string } | undefined = () => undefined ): string {
	if ( ! contracts.length ) return html;
	const $ = cheerio.load( html );
	$( 'html' ).attr( 'data-blocks-engine-capture-root-class-contracts', JSON.stringify( contracts ) );
	// Project authored inline styles in place before adding linked-sheet aliases.
	$( 'style' ).each( ( _, element ) => {
		const css = projectContractCss( $( element ).text(), contracts );
		if ( css !== undefined ) $( element ).text( css );
	} );
	$( 'link[rel~="stylesheet"]:not([rel~="alternate"]):not([disabled])' ).each( ( _, element ) => {
		const link = $( element );
		const sheet = linkedSheet( link.attr( 'href' ) ?? '' );
		if ( ! sheet || ! contracts.some( contract => sheet.css.includes( contract.class ) ) ) return;
		// Keep the shared sheet identity; only aliases follow its cascade slot.
		const css = projectContractCss( sheet.css, contracts, true );
		if ( ! css ) return;
		const source = cheerio.load( '<style></style>' );
		source( 'style' ).text( css );
		const resolved = cheerio.load( resolveDocumentReferences( source.html(), sheet.url, sheet.url ) );
		const style = $( '<style>' ).text( resolved( 'style' ).text() );
		const media = link.attr( 'media' );
		if ( media !== undefined ) style.attr( 'media', media );
		link.after( style );
	} );
	return $.html();
}

/** Linked sheets emit only aliases, with their original ancestor context. */
function projectContractCss( css: string, contracts: RootClassContract[], aliasesOnly = false ): string | undefined {
		return projectStylesheet( () => {
			const sheet = postcss.parse( css );
			const projected = postcss.root();
			const rules: postcss.Rule[] = [];
			sheet.walkRules( rule => { rules.push( rule ); } );
			for ( const rule of rules ) {
				if ( ! parseSelectorList( rule.selector ) ) continue;
				if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( rule.parent.name ) ) continue;
				for ( const contract of contracts ) {
					const selectors: string[] = [];
					selectorParser( list => {
						list.each( selector => {
							let matched = false;
							// Only the leading root compound is evidence-backed. Never
							// rewrite an identically named class on a descendant.
							const boundary = selector.nodes.findIndex( candidate => candidate.type === 'combinator' );
							const compound = selector.nodes.slice( 0, boundary < 0 ? undefined : boundary );
							for ( const node of [ ...compound ] ) {
								if ( node.type === 'combinator' ) break;
								if ( node.type !== 'class' || node.value !== contract.class ) continue;
								const tag = compound.find( candidate => candidate.type === 'tag' );
								if ( tag && tag.value !== contract.root ) continue;
								if ( compound.some( candidate => candidate.type === 'class' && candidate.value !== contract.class && ! contract.evidence.some( sample => sample[ contract.root ].includes( candidate.value ) ) ) ) continue;
								const alias = selectorParser().astSync( `:is(*,${ node.toString() })` ).first.first!;
								node.replaceWith( alias );
								if ( ! tag ) selector.prepend( selectorParser.tag( { value: contract.root } ) );
								matched = true;
							}
							if ( matched ) selectors.push( selector.toString() );
						} );
					} ).processSync( rule.selector );
					if ( ! selectors.length ) continue;
					const media = postcss.atRule( { name: 'media', params: `(min-width:${ contract.minWidth }px) and (max-width:${ contract.maxWidth }px)` } );
					media.append( rule.clone( { selector: selectors.join( ',' ) } ) );
					if ( aliasesOnly ) {
						let contextual: postcss.ChildNode = media;
						for ( let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent ) {
							const wrapper = parent.clone( { nodes: [] } );
							wrapper.append( contextual );
							contextual = wrapper as postcss.ChildNode;
						}
						projected.append( contextual );
					} else {
						rule.after( media );
					}
				}
			}
			return ( aliasesOnly ? projected : sheet ).toString();
		} );
}
