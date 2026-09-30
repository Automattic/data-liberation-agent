import * as cheerio from 'cheerio';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';

const RUNTIME = `(function(){var configs=__CONFIG__;
function nodes(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}
function refresh(root){var config=configs[root.getAttribute('data-dla-collection')],field=document.querySelector('[data-dla-collection-field="'+root.getAttribute('data-dla-collection')+'"]');if(!config||!field)return;
var query=field.value.toLowerCase(),category=Number(root.getAttribute('data-dla-collection-category')),count=0;
nodes('[data-dla-collection-item]',root).forEach(function(item){var walker=document.createTreeWalker(item,NodeFilter.SHOW_TEXT),parts=[];while(walker.nextNode())parts.push(walker.currentNode.textContent);var members=JSON.parse(item.getAttribute('data-dla-collection-members')),text=parts.join(' ').replace(/\\s+/g,' ').trim().toLowerCase();var show=members.indexOf(category)!==-1&&text.indexOf(query)!==-1;item.hidden=!show;if(show)count++;});
var empty=document.querySelector('[data-dla-collection-empty="'+root.getAttribute('data-dla-collection')+'"]');if(empty)empty.hidden=count!==0;
nodes('[data-dla-collection-category-control="'+root.getAttribute('data-dla-collection')+'"]').forEach(function(button){var index=Number(button.getAttribute('data-dla-collection-index')),attrs=config.categories[index][index===category?'active':'inactive'];Object.keys(attrs).forEach(function(name){if(attrs[name]===null)button.removeAttribute(name);else button.setAttribute(name,attrs[name]);});button.setAttribute('aria-pressed',String(index===category));});}
document.addEventListener('input',function(event){var key=event.target.getAttribute&&event.target.getAttribute('data-dla-collection-field');if(key===null||key===undefined)return;nodes('[data-dla-collection="'+key+'"]').forEach(refresh);});
document.addEventListener('click',function(event){var control=event.target.closest&&event.target.closest('[data-dla-collection-category-control]');if(!control)return;var key=control.getAttribute('data-dla-collection-category-control');nodes('[data-dla-collection="'+key+'"]').forEach(function(root){root.setAttribute('data-dla-collection-category',control.getAttribute('data-dla-collection-index'));refresh(root);});});
})();`;

/** Keep a single authoring tree. Filtering changes visibility, never swaps content. */
export function wireCapturedCollections( html: string, states: CapturedDialogInteraction[] ): string {
	const verified = states.filter( state => state.kind === 'typed-search' && state.status === 'captured' && state.collectionFilter?.replay === 'verified' && state.collectionFilter.restoration === 'verified' );
	if ( !verified.length ) return html;
	const $ = cheerio.load( html );
	const configs: Array<{ categories: Array<{active: Record<string, string|null>; inactive: Record<string, string|null>}> }> = [];
	for ( const state of verified ) {
		const evidence = state.collectionFilter!;
		const field = $( evidence.field.selector ), target = $( evidence.target.selector );
		if ( field.length !== 1 || target.length !== 1 ) continue;
		const key = String( configs.length );
		// Annotate the already localized baseline, preserving its assets and paint.
		// Evidence HTML remains diagnostic rather than replacing the authoring tree.
		const children = target.children();
		if ( children.length !== evidence.items.length ) continue;
		const text = ( element: import('domhandler').AnyNode ): string => element.type === 'text' ? element.data : 'children' in element ? element.children.map( text ).join( ' ' ) : '';
		const identities = children.toArray().map( element => evidence.items.find( item => item.text === text(element).replace(/\s+/g,' ').trim() ) );
		if ( identities.some( item => !item ) || new Set(identities.map(item=>item!.key)).size !== children.length ) continue;
		children.each( ( index, element ) => {
			$( element ).attr( 'data-dla-collection-item', identities[index]!.key ).attr( 'data-dla-collection-members', JSON.stringify( identities[index]!.categories ) );
		});
		target.attr( 'data-dla-collection', key ).attr( 'data-dla-collection-category', String( evidence.initialCategory ) );
		field.attr( 'data-dla-collection-field', key );
		const empty = `<div data-dla-collection-empty="${key}" hidden>${evidence.emptyHtml}</div>`;
		if ( evidence.emptyPlacement === 'after' ) target.after( empty ); else target.append( empty );
		const attributes = ( markup: string ) => {
			const node = cheerio.load( markup, null, false )( '*' ).first();
			return Object.fromEntries( ['class','style','aria-selected','data-state'].map( name => [name, node.attr( name ) ?? null] ) );
		};
		const categories = evidence.categories.map( category => {
			$( category.selector ).attr( 'data-dla-collection-category-control', key ).attr( 'data-dla-collection-index', String( category.index ) ).attr( 'aria-pressed', String( category.index === evidence.initialCategory ) );
			return { active: attributes( category.activeHtml ), inactive: attributes( category.inactiveHtml ) };
		});
		configs.push({ categories });
	}
	if ( configs.length ) $( 'head' ).append( `<style data-dla-collection-visibility>[data-dla-collection-item][hidden],[data-dla-collection-empty][hidden]{display:none!important}</style><script data-dla-collection-runtime>${RUNTIME.replace( '__CONFIG__', JSON.stringify( configs ).replace( /</g, '\\u003c' ) )}</script>` );
	return $.html();
}
