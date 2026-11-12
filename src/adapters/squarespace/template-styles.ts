import postcss, { type ChildNode } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { TemplateStyleBlock, TemplateStyleNormalization } from '../../lib/template-groups.js';

/** Only discard anonymous CSS when every selector is confined to a content block. */
function isBlockScoped( text: string ): boolean {
	try {
		let rules = 0;
		const scoped = ( node: ChildNode ): boolean => {
			if ( node.type === 'comment' ) return true;
			if ( node.type === 'atrule' ) return node.name.toLowerCase() === 'media' && !! node.nodes && node.nodes.every( scoped );
			if ( node.type !== 'rule' ) return false;
			rules++;
			const selectors = selectorParser().astSync( node.selector );
			return selectors.nodes.every( selector => {
				const first = selector.nodes[ 0 ];
				return first?.type === 'id' && /^block-.+/.test( first.value ) &&
					selector.nodes.every( part => part.type !== 'combinator' || [ ' ', '>' ].includes( part.value ) );
			} ) && node.nodes.every( child => child.type === 'decl' || child.type === 'comment' );
		};
		return postcss.parse( text ).nodes.every( scoped ) && rules > 0;
	} catch {
		// Unrecognized CSS remains template evidence rather than being discarded.
		return false;
	}
}

function isGeneratedBlock( style: TemplateStyleBlock ): boolean {
	return [ 'container-styles', 'override-container-styles' ].includes( style.id ?? '' ) ||
		( style.attributes.class ?? '' ).split( /\s+/ ).some( token => [ 'transform-vars', 'transform-overrides-vars' ].includes( token ) ) ||
		isBlockScoped( style.text );
}

export const templateStyleNormalization: TemplateStyleNormalization = {
	pageStyles( styles ) {
		const texts = styles.filter( style => ! isGeneratedBlock( style ) ).map( style => {
			if ( ! Object.hasOwn( style.attributes, 'data-sqsp-font-ids' ) ) return style.text;
			try {
				// Sort, but do not deduplicate: repeated rules remain evidence.
				return postcss.parse( style.text ).nodes.map( node => node.toString().trim() ).sort().join( '\n' );
			} catch {
				return style.text;
			}
		} );
		const joined = texts.join( '\n' );
		return joined.trim() ? joined : null;
	},
	scriptUrl( url ) {
		return url.replace( /^(https?:\/\/assets\.squarespace\.com\/universal\/scripts-compressed\/[^/?#]+)-[a-f0-9]{16}(?=[-.])/i, '$1' );
	},
};
