import type { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { hydrateDisclosureContent } from './dynamic-content.js';
import { captureFiniteBootstrap, snapshotCollectionItems } from './finite-bootstrap.js';
import type { FiniteBootstrapContract } from './finite-bootstrap.js';
import type { CapturedDialogInteraction } from './interaction-capture.js';

/** A replayable predicate is inferred only when real source transitions agree. */
export interface CapturedCollectionFilter {
	field: { selector: string; value: string };
	target: { selector: string; html: string };
	items: Array<{ key: string; text: string; html: string; categories: number[] }>;
	itemDepth?: number;
	categories: Array<{ selector: string; label: string; index: number; activeHtml: string; inactiveHtml: string }>;
	initialCategory: number;
	predicate: 'normalized-text-includes';
	mode?: 'category-and-query' | 'category-or-global-search';
	emptyHtml: string;
	emptyPlacement: 'inside' | 'after';
	emptyBindsQuery?: boolean;
	probes: Array<{ query: string; category: number; keys: string[] }>;
	restoration: 'verified' | 'unverified';
	replay: 'verified' | 'unsupported';
	network: {
		dataRequests: 'blocked' | 'observed-response-replay' | 'query-dependent' | 'incomplete';
		verification?: 'all-requests-blocked' | 'intercepted-observed-responses' | 'unverified';
		blockedRequests: number;
		replayedResponses?: number;
		blockedFollowUps?: number;
	};
	finiteBootstrap?: FiniteBootstrapContract;
	reason?: string;
}

const normalize = ( text: string ) => text.replace( /\s+/g, ' ' ).trim();
const snapshotItems = ( html: string ) => snapshotCollectionItems( html ).items;

/** Bounded local collection search. Category snapshots supply observed membership,
 * not a label-derived taxonomy. No server API or platform knowledge is used. */
export async function captureTypedSearchStates(
	page: Page,
	states: CapturedDialogInteraction[],
	options: { settleMs?: number; maxFields?: number; maxDriveMs?: number; maxHtmlBytes?: number } = {}
): Promise<CapturedDialogInteraction[]> {
	const settleMs = options.settleMs ?? 600;
	const groups = new Map<string, CapturedDialogInteraction[]>();
	for ( const state of states ) {
		if ( state.kind !== 'selectable-set' || state.status !== 'captured' || !state.set || !state.dialog || state.dialog.htmlTruncated ) continue;
		const key = `${state.set.selector}|${state.dialog.selector}`;
		groups.set( key, [ ...( groups.get( key ) ?? [] ), state ] );
	}
	const results: CapturedDialogInteraction[] = [];
	const completeGroups = [ ...groups.values() ].filter( group => group.length === group[ 0 ]!.set!.size && group[ 0 ]!.dialog?.selector );
	if ( ! completeGroups.length ) {
		const orphan = await page.locator( 'input[type="search"], input[type="text"]' ).evaluateAll( elements => {
			const element = elements.find( candidate => candidate.getBoundingClientRect().height && ! candidate.closest( 'header,footer,nav' ) );
			if ( ! element ) return null;
			const parts: string[] = [];
			for ( let node: Element | null = element; node && node !== document.body; node = node.parentElement ) {
				const siblings = Array.from( node.parentElement!.children ).filter( sibling => sibling.tagName === node!.tagName );
				parts.unshift( `${ node.tagName.toLowerCase() }:nth-of-type(${ siblings.indexOf( node ) + 1 })` );
			}
			return { selector: `body > ${ parts.join( ' > ' ) }`, value: ( element as HTMLInputElement ).value };
		} );
		if ( orphan ) results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: orphan.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'No complete, unambiguous selectable collection relationship was established' } );
		return results;
	}
	let driven = 0;
	for ( const group of completeGroups ) {
		if ( driven >= ( options.maxFields ?? 2 ) ) break;
		group.sort( ( first, second ) => first.set!.index - second.set!.index );
		const targetSelector = group[ 0 ]!.dialog!.selector;
		const field = await associatedField( page, targetSelector, group.map( state => state.trigger.selector ) );
		if ( ! field ) {
			results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: targetSelector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'No text field shares a bounded ancestor with the collection' } );
			continue;
		}
		driven++;
		const deadline = Date.now() + ( options.maxDriveMs ?? 120_000 );
		if ( field.value ) {
			results.push({ status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'Initial nonempty query does not establish a complete collection universe' });
			continue;
		}
		const input = page.locator( field.selector );
		const target = page.locator( targetSelector );
		if ( await target.count() !== 1 ) {
			results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'Collection region selector did not match one element' } );
			continue;
		}
			await hydrateDisclosureContent( page, targetSelector );
			const siblingTexts = await target.evaluate( element => Array.from( element.parentElement!.children ).filter( node => node !== element ).map( node => (node.textContent ?? '').replace(/\s+/g,' ').trim() ) );
			const baselineSnap = snapshotCollectionItems( await target.evaluate( element => element.outerHTML ) );
			const baseline = baselineSnap.items;
			if ( baseline.length < 2 || baseline.length > 100 || baseline.some( item => !item.text ) || new Set( baseline.map( item => item.text ) ).size !== baseline.length ) {
				results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: `Resting collection did not yield a unique item list (${ baseline.length })` } );
				continue;
			}
			const memberships = group.map( state => snapshotItems( state.dialog!.html ).map( item => baseline.findIndex( candidate => candidate.text === item.text ) ) );
			if ( memberships.some( members => ! members.length ) ) {
				results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'A category snapshot had no items' } );
				continue;
			}
			const outsideBaseline = memberships.some( members => members.includes( -1 ) );
			const initialCategory = memberships.findIndex( members => members.length === baseline.length && members.every( index => index >= 0 ) );
			if ( initialCategory < 0 ) {
				results.push( { status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'No category snapshot matched the resting item list' } );
				continue;
			}
			if ( outsideBaseline ) {
				const finite = await captureFiniteBootstrap( page, field, group, initialCategory, { settleMs, deadline, maxHtmlBytes: options.maxHtmlBytes ?? 512 * 1024 } );
				results.push( finite ? collectionState( field.selector, finite ) : { status: 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'Category snapshots contain items outside the resting collection and no finite bootstrap was observed' } );
				break;
			}
			const items = baseline.map( ( item, index ) => ({ ...item, key: String( index ), categories: memberships.flatMap( ( members, category ) => members.includes( index ) ? [category] : [] ) }) );
			const tokens = [...new Set( items.flatMap( item => item.text.toLowerCase().match( /[\p{L}]{5,}/gu ) ?? [] ) )];
			const useful = tokens.filter( token => { const count = items.filter( item => item.text.toLowerCase().includes( token ) ).length; return count > 0 && count < items.length; } );
			const answerOnly = items.flatMap( item => {
				const $ = cheerio.load(item.html, null, false);
				const label = $('button[aria-expanded],h1,h2,h3,h4,h5,h6,a').first().text().toLowerCase();
				return useful.filter( token => item.text.toLowerCase().includes(token) && !label.includes(token) );
			})[0];
			const matchingQueries = [...new Set([useful[0],answerOnly,useful[useful.length-1],...useful].filter((query): query is string => Boolean(query)))].slice(0,3);
			const queries = [...matchingQueries, useful[0]?.toUpperCase(), 'dla-no-match-7f39b2'].filter( ( query ): query is string => Boolean( query ) );
			if ( queries.length < 3 ) continue;
			const evidence: CapturedCollectionFilter = {
				field, target: { selector: targetSelector, html: '' }, items, categories: [], initialCategory,
				predicate: 'normalized-text-includes', mode: 'category-and-query', itemDepth: baselineSnap.itemDepth, emptyHtml: '', emptyPlacement: 'inside', probes: [], restoration: 'unverified', replay: 'unsupported',
				network: { dataRequests: 'blocked', verification: 'all-requests-blocked', blockedRequests: 0 },
			};
			const sourceUrl = page.url();
			// Isolate the drive from data fetching. Background telemetry must not
			// masquerade as a query dependency; actual server-backed results cannot
			// satisfy the predicate while their data requests are blocked.
			const blockData = async ( route: import('playwright').Route ) => {
				if ( ['fetch', 'xhr'].includes( route.request().resourceType() ) ) {
					evidence.network.blockedRequests++;
					await route.abort();
				} else await route.fallback();
			};
			await page.route( '**/*', blockData );
			try {
				for ( let category = 0; category < group.length; category++ ) {
					const state = group[category]!;
					await input.fill( '' ); await page.locator( state.trigger.selector ).click(); await page.waitForTimeout( settleMs );
					const activeHtml = await page.locator( state.trigger.selector ).evaluate( element => element.outerHTML );
					evidence.categories.push({ selector: state.trigger.selector, label: state.trigger.label ?? '', index: category, activeHtml, inactiveHtml: '' });
					for ( const query of [ '', ...queries ] ) {
						if ( Date.now() >= deadline ) throw new Error( 'Typed search drive budget exceeded' );
						await input.fill( query ); await page.waitForTimeout( settleMs );
						if ( page.url() !== sourceUrl ) throw new Error('Source input drive changed routes; local replay remains unproven');
						await hydrateDisclosureContent( page, targetSelector );
						const actual = snapshotItems( await target.evaluate( element => element.outerHTML ) );
						const expected = items.filter( item => item.categories.includes( category ) && item.text.toLowerCase().includes( query.toLowerCase() ) );
						const actualKeys = actual.map( item => items.find( candidate => candidate.text === item.text )?.key );
						if ( expected.length === 0 ) {
							let html = await target.evaluate( element => element.innerHTML );
							if ( !html.trim() ) {
								const siblings = await target.evaluate( (element, before) => Array.from(element.parentElement!.children).filter(node=>node!==element && !before.includes((node.textContent??'').replace(/\s+/g,' ').trim()) && node.getBoundingClientRect().height>0).map(node=>node.outerHTML), siblingTexts );
								if ( siblings.length > 1 ) throw new Error('Ambiguous empty-state siblings');
								if ( siblings.length === 1 ) { html = siblings[0]!; evidence.emptyPlacement = 'after'; }
							}
							if ( !evidence.emptyHtml ) evidence.emptyHtml = html;
							if ( normalize( snapshotItems(`<div>${html}</div>`).map(item=>item.text).join(' ') ) !== normalize( snapshotItems( `<div>${evidence.emptyHtml}</div>` ).map( item => item.text ).join( ' ' ) ) ) throw new Error( 'Empty-state content depends on query or category' );
						} else if ( JSON.stringify( actualKeys ) !== JSON.stringify( expected.map( item => item.key ) ) ) throw new Error( 'Source results do not support the normalized text predicate' );
						evidence.probes.push({ query, category, keys: expected.map( item => item.key ) });
					}
				}
				evidence.replay = 'verified';
			} catch ( error ) { evidence.reason = String( error ).slice( 0, 500 ); }
			finally {
				await page.unroute( '**/*', blockData );
				await input.fill( field.value ); await page.locator( group[initialCategory]!.trigger.selector ).click(); await page.waitForTimeout( settleMs );
				await hydrateDisclosureContent( page, targetSelector );
				evidence.target.html = await target.evaluate( element => element.outerHTML );
				if ( JSON.stringify( snapshotItems( evidence.target.html ).map( item => item.text ) ) === JSON.stringify( baseline.map( item => item.text ) ) ) evidence.restoration = 'verified';
				for ( const category of evidence.categories ) if ( category.index !== initialCategory ) category.inactiveHtml = await page.locator( category.selector ).evaluate( element => element.outerHTML );
				// Obtain the initially selected button's inactive shape through a real activation.
				if ( evidence.categories.length === group.length ) {
					await page.locator( group[(initialCategory + 1) % group.length]!.trigger.selector ).click(); await page.waitForTimeout( settleMs );
					evidence.categories[initialCategory]!.inactiveHtml = await page.locator( group[initialCategory]!.trigger.selector ).evaluate( element => element.outerHTML );
					await page.locator( group[initialCategory]!.trigger.selector ).click(); await page.waitForTimeout( settleMs ); await hydrateDisclosureContent( page, targetSelector );
				}
				evidence.target.html = await target.evaluate( element => element.outerHTML );
				if ( JSON.stringify( snapshotItems( evidence.target.html ).map( item => item.text ) ) !== JSON.stringify( baseline.map( item => item.text ) ) ) evidence.restoration = 'unverified';
			}
			if ( Buffer.byteLength( JSON.stringify( evidence ) ) > (options.maxHtmlBytes ?? 512 * 1024) ) {
				evidence.replay = 'unsupported'; evidence.reason = 'Collection evidence exceeds byte budget';
				evidence.target.html = ''; evidence.items = []; evidence.emptyHtml = '';
			}
			if ( evidence.replay !== 'verified' && evidence.network.blockedRequests > 0 ) {
				const finite = await captureFiniteBootstrap( page, field, group, initialCategory, { settleMs, deadline, maxHtmlBytes: options.maxHtmlBytes ?? 512 * 1024 } );
				if ( finite ) {
					results.push( collectionState( field.selector, finite ) );
					break;
				}
			}
			results.push({ status: evidence.replay === 'verified' && evidence.restoration === 'verified' ? 'captured' : 'no-dialog', kind: 'typed-search', trigger: { selector: field.selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, collectionFilter: evidence });
			break;
	}
	if ( ! results.length ) results.push({ status: 'no-dialog', kind: 'typed-search', trigger: { selector: 'body', tag: 'input', ariaHaspopup: '', dataBindings: {} }, error: 'No complete, unambiguous selectable collection relationship was established' });
	return results;
}

function collectionState( selector: string, evidence: CapturedCollectionFilter ): CapturedDialogInteraction {
	return { status: evidence.replay === 'verified' && evidence.restoration === 'verified' ? 'captured' : 'no-dialog', kind: 'typed-search', trigger: { selector, tag: 'input', ariaHaspopup: '', dataBindings: {} }, collectionFilter: evidence };
}

async function associatedField( page: Page, targetSelector: string, triggerSelectors: string[] ): Promise<{ selector: string; value: string } | null> {
	return page.evaluate( ( { targetSelector: targetPath } ) => {
		const target = document.querySelector( targetPath );
		if ( ! target ) return null;
		const inputs = [ ...document.querySelectorAll( 'input[type="search"], input[type="text"]' ) ]
			.filter( element => element.getBoundingClientRect().height && ! element.closest( 'header,footer,nav' ) )
			.slice( 0, 24 );
		const scored: Array<{ element: HTMLInputElement; depth: number }> = [];
		for ( const input of inputs ) {
			const form = input.closest( 'form' );
			if ( form && ! form.contains( target ) ) continue;
			let node = input.parentElement;
			let depth = 0;
			let shared = false;
			while ( node && node !== document.body && node !== document.documentElement ) {
				depth++;
				if ( node.contains( target ) ) { shared = true; break; }
				node = node.parentElement;
			}
			if ( ! shared ) continue;
			scored.push( { element: input as HTMLInputElement, depth } );
		}
		scored.sort( ( first, second ) => second.depth - first.depth );
		const element = scored[ 0 ]?.element;
		if ( ! element ) return null;
		const parts: string[] = [];
		for ( let node: Element | null = element; node && node !== document.body; node = node.parentElement ) {
			const siblings = Array.from( node.parentElement!.children ).filter( sibling => sibling.tagName === node!.tagName );
			parts.unshift( `${ node.tagName.toLowerCase() }:nth-of-type(${ siblings.indexOf( node ) + 1 })` );
		}
		return { selector: `body > ${ parts.join( ' > ' ) }`, value: element.value };
	}, { targetSelector, triggerSelectors } );
}
