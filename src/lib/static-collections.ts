import * as cheerio from 'cheerio';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';
import { collectionItemHasResource } from './screenshot/finite-bootstrap.js';

const RUNTIME = `(function(){var configs=__CONFIG__;
function nodes(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}
function arrange(root,keys){var items=nodes('[data-dla-collection-item]',root);if(!items.length||!keys||!keys.length)return;var parent=items[0].parentNode,byKey={};items.forEach(function(item){byKey[item.getAttribute('data-dla-collection-item')]=item;});keys.forEach(function(key){if(byKey[key])parent.appendChild(byKey[key]);});items.forEach(function(item){var key=item.getAttribute('data-dla-collection-item');if(keys.indexOf(key)===-1)parent.appendChild(item);});}
function refresh(root){var config=configs[root.getAttribute('data-dla-collection')],field=document.querySelector('[data-dla-collection-field="'+root.getAttribute('data-dla-collection')+'"]');if(!config||!field)return;
var query=field.value.toLowerCase(),category=Number(root.getAttribute('data-dla-collection-category')),mode=config.mode||'category-and-query',globalSearch=mode==='category-or-global-search'&&query!=='',count=0;
var categoryOrder=config.categoryOrders&&config.categoryOrders[category];arrange(root,globalSearch?config.order:(categoryOrder||config.order));
nodes('[data-dla-collection-item]',root).forEach(function(item){var walker=document.createTreeWalker(item,NodeFilter.SHOW_TEXT),parts=[];while(walker.nextNode())parts.push(walker.currentNode.textContent);var members=JSON.parse(item.getAttribute('data-dla-collection-members')),text=parts.join(' ').replace(/\\s+/g,' ').trim().toLowerCase();var show=globalSearch?text.indexOf(query)!==-1:members.indexOf(category)!==-1&&(mode==='category-or-global-search'||text.indexOf(query)!==-1);item.hidden=!show;if(show)count++;});
var empty=document.querySelector('[data-dla-collection-empty="'+root.getAttribute('data-dla-collection')+'"]');if(empty){empty.hidden=count!==0;if(config.emptyTemplate)empty.innerHTML=config.emptyTemplate.split('__DLA_QUERY__').join(field.value.replace(/[&<>"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch];}));}
nodes('[data-dla-collection-category-control="'+root.getAttribute('data-dla-collection')+'"]').forEach(function(button){button.hidden=globalSearch;if(globalSearch)return;var index=Number(button.getAttribute('data-dla-collection-index')),attrs=config.categories[index][index===category?'active':'inactive'];Object.keys(attrs).forEach(function(name){if(attrs[name]===null)button.removeAttribute(name);else button.setAttribute(name,attrs[name]);});button.setAttribute('aria-pressed',String(index===category));});}
document.addEventListener('input',function(event){var key=event.target.getAttribute&&event.target.getAttribute('data-dla-collection-field');if(key===null||key===undefined)return;nodes('[data-dla-collection="'+key+'"]').forEach(refresh);});
document.addEventListener('click',function(event){var control=event.target.closest&&event.target.closest('[data-dla-collection-category-control]');if(!control)return;var key=control.getAttribute('data-dla-collection-category-control');nodes('[data-dla-collection="'+key+'"]').forEach(function(root){root.setAttribute('data-dla-collection-category',control.getAttribute('data-dla-collection-index'));refresh(root);});});
})();`;

/** Keep a single authoring tree. Filtering changes visibility, never swaps content. */
export function wireCapturedCollections( html: string, states: CapturedDialogInteraction[] ): string {
	const verified = states.filter( state => state.kind === 'typed-search' && state.status === 'captured' && state.collectionFilter?.replay === 'verified' && state.collectionFilter.restoration === 'verified' );
	if ( !verified.length ) return html;
	const $ = cheerio.load( html );
	const configs: Array<{ mode: string; order?: string[]; categoryOrders?: string[][]; emptyTemplate?: string; categories: Array<{active: Record<string, string|null>; inactive: Record<string, string|null>}> }> = [];
	for ( const state of verified ) {
		const evidence = state.collectionFilter!;
		const finite = evidence.finiteBootstrap?.schema === 'data-liberation/finite-bootstrap/v1' && evidence.finiteBootstrap.mode === 'category-or-global-search' && evidence.finiteBootstrap.coverage === 'complete' && evidence.network.dataRequests === 'observed-response-replay' && evidence.network.verification === 'intercepted-observed-responses';
		if ( ! finite && evidence.network.dataRequests !== 'blocked' ) continue;
		const field = $( evidence.field.selector ), target = $( evidence.target.selector );
		if ( field.length !== 1 || target.length !== 1 ) continue;
		const key = String( configs.length );
		const textOf = ( element: import('domhandler').AnyNode ): string => element.type === 'text' ? element.data : 'children' in element ? element.children.map( textOf ).join( ' ' ) : '';
		const normalize = ( value: string ) => value.replace( /\s+/g, ' ' ).trim();
		let container = target;
		for ( let depth = 0; depth < ( evidence.itemDepth ?? 0 ); depth++ ) {
			if ( container.children().length !== 1 ) break;
			container = container.children().first();
		}
		const children = container.children().toArray().filter( element => ! $( element ).attr( 'data-dla-collection-empty' ) );
		const used = new Set<string>();
		const identities = children.map( element => {
			const text = normalize( textOf( element ) );
			const item = evidence.items.find( candidate => ! used.has( candidate.key ) && ( candidate.text === text || ( finite && text.length >= 8 && candidate.text.startsWith( text ) ) ) );
			if ( item ) used.add( item.key );
			return item;
		} );
		if ( identities.some( item => ! item ) || ( ! finite && children.length !== evidence.items.length ) ) continue;
		if ( finite && ( evidence.finiteBootstrap?.resources !== 'text-only' || evidence.items.some( item => ! used.has( item.key ) && collectionItemHasResource( item.html ) ) ) ) continue;
		if ( finite && used.size !== children.length ) continue;
		const byKey = new Map<string, import('domhandler').Element>();
		children.forEach( ( element, index ) => {
			const item = identities[ index ]!;
			if ( finite && item.text !== normalize( textOf( element ) ) ) {
				if ( collectionItemHasResource( item.html ) ) return;
				const inner = cheerio.load( item.html, null, false )( '*' ).first().html();
				if ( inner ) $( element ).html( inner );
			}
			$( element ).attr( 'data-dla-collection-item', item.key ).attr( 'data-dla-collection-members', JSON.stringify( item.categories ) );
			byKey.set( item.key, element );
		} );
		if ( finite ) {
			for ( const item of evidence.items ) {
				if ( byKey.has( item.key ) ) continue;
				container.append( item.html );
				const added = container.children().last();
				added.attr( 'data-dla-collection-item', item.key ).attr( 'data-dla-collection-members', JSON.stringify( item.categories ) );
				byKey.set( item.key, added.get( 0 ) as import('domhandler').Element );
			}
			const categoryOrder = evidence.finiteBootstrap!.order.categoryKeys[ evidence.initialCategory ] ?? [];
			const restingOrder = evidence.finiteBootstrap!.order.categoriesAgree
				? evidence.items.map( item => item.key )
				: [ ...categoryOrder, ...evidence.items.map( item => item.key ).filter( key => ! categoryOrder.includes( key ) ) ];
			for ( const key of restingOrder ) {
				const node = byKey.get( key );
				const item = evidence.items.find( candidate => candidate.key === key );
				if ( ! node || ! item ) continue;
				container.append( node );
				if ( item.categories.includes( evidence.initialCategory ) ) $( node ).removeAttr( 'hidden' );
				else $( node ).attr( 'hidden', '' );
			}
		}
		target.attr( 'data-dla-collection', key ).attr( 'data-dla-collection-category', String( evidence.initialCategory ) ).attr( 'data-dla-collection-mode', finite ? 'category-or-global-search' : 'category-and-query' );
		field.attr( 'data-dla-collection-field', key );
		const empty = `<div data-dla-collection-empty="${key}" hidden>${ evidence.emptyHtml }</div>`;
		if ( evidence.emptyPlacement === 'after' ) target.after( empty ); else target.append( empty );
		const attributes = ( markup: string ) => {
			const node = cheerio.load( markup, null, false )( '*' ).first();
			return Object.fromEntries( ['class','style','aria-selected','data-state'].map( name => [name, node.attr( name ) ?? null] ) );
		};
		const categories = evidence.categories.map( category => {
			$( category.selector ).attr( 'data-dla-collection-category-control', key ).attr( 'data-dla-collection-index', String( category.index ) ).attr( 'aria-pressed', String( category.index === evidence.initialCategory ) );
			return { active: attributes( category.activeHtml ), inactive: attributes( category.inactiveHtml ) };
		});
		configs.push({ mode: finite ? 'category-or-global-search' : 'category-and-query', ...( finite ? { order: evidence.finiteBootstrap!.order.keys, categoryOrders: evidence.finiteBootstrap!.order.categoryKeys } : {} ), ...( evidence.emptyBindsQuery ? { emptyTemplate: evidence.emptyHtml } : {} ), categories });
	}
	if ( configs.length ) $( 'head' ).append( `<style data-dla-collection-visibility>[data-dla-collection-item][hidden],[data-dla-collection-empty][hidden],[data-dla-collection-category-control][hidden]{display:none!important}</style><script data-dla-collection-runtime>${RUNTIME.replace( '__CONFIG__', JSON.stringify( configs ).replace( /</g, '\\u003c' ) )}</script>` );
	return $.html();
}
