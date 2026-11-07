// src/lib/screenshot/scripted-links.ts
//
// Scripted same-origin links: click targets without an `href` (a
// `<div role="link" tabindex="0">`) whose click handler navigates. The copy
// keeps the element but loses the handler, so capture observes where each one
// goes and export lowers it to a native `<a href>` (#1465).
//
// Two steps, split around the baseline serialization:
//
//   1. `stampScriptedLinkCandidates` numbers every candidate in document order
//      before the initial document is serialized, so the stamp travels in the
//      captured HTML.
//   2. `probeScriptedLinks` runs after every baseline artifact, like the other
//      interaction probes, because clicking a client-routed link re-renders the
//      document. It clicks each stamped candidate, reads the destination from
//      the Navigation API's `navigate` event and cancels it, so the page never
//      leaves the captured document. A runtime that re-rendered anyway is asked
//      to render the captured route again (`popstate`), and the candidates are
//      re-identified by their recorded signatures.
//
// `lowerScriptedLinks` applies one profile's observations to that profile's
// captured document; the export's ordinary route-link rewriting then maps the
// destination to its portable path.
import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import { withEvaluateTimeout } from './page-helpers.js';

/** Stamp naming a candidate in the captured document; on a lowered anchor, its original tag. */
export const SCRIPTED_LINK_ATTRIBUTE = 'data-blocks-engine-capture-scripted-link';
/** Candidates probed per route profile; the rest are reported unresolved. */
export const SCRIPTED_LINK_LIMIT = 48;
/** Upper bound on one profile's probe, before route-deadline scaling. */
export const SCRIPTED_LINK_BUDGET_MS = 30_000;
/** How long a click may take to start its navigation (page transitions delay it). */
const NAVIGATION_WAIT_MS = 1_200;
/** How long a re-rendered document may take to show the captured route again. */
const RESTORE_WAIT_MS = 3_000;
/** Elements that may become an `<a>` in place: transparent-content positions only. */
const LOWERABLE_TAGS = [ 'a', 'div', 'span', 'section', 'article', 'figure', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ];
/** Original tags whose UA `display` differs from an anchor's. */
const BLOCK_TAGS = new Set( [ 'div', 'section', 'article', 'figure', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] );

export type ScriptedLinkUnresolvedReason =
	| 'no-navigation'
	| 'off-origin'
	| 'fragment'
	| 'reload-or-traverse'
	| 'new-window'
	| 'missing'
	| 'restore-failed'
	| 'budget'
	| 'unsupported';

/** One profile's observations, recorded on the manifest entry under its profile id. */
export interface ScriptedLinkEvidence {
	candidates: number;
	resolved: number;
	unresolved: number;
	/** Stamp index → absolute destination observed for that element. */
	links: Record< string, string >;
	reasons?: Partial< Record< ScriptedLinkUnresolvedReason, number > >;
}

/**
 * Browser-side candidate list, shared by stamping and probing so both name the
 * same elements: `[role=link]` without an `href`, in a position an anchor can
 * take, neither nested in another link or control nor containing a real
 * link or control (lowering either would nest interactive content). Of nested
 * scripted links, the outermost is the candidate.
 */
const CANDIDATES_SOURCE = `(tags) => Array.from(document.querySelectorAll('[role="link"]')).filter((element) => {
	if (!tags.includes(element.localName)) return false;
	if (element.hasAttribute('href')) return false;
	if (element.parentElement && element.parentElement.closest('a[href],area[href],button,[role="link"],[role="button"]')) return false;
	return !element.querySelector('a[href],area[href],button,input,select,textarea,iframe,[role="button"]');
})`;

const SIGNATURE_SOURCE = `(element) => element.localName + '|' + (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)`;

/**
 * Number every scripted-link candidate before a document is serialized and
 * return each stamp's signature, so the probe can re-identify them after a
 * runtime replaced the nodes. Stamping is additive: `previous` stamps that
 * still name an element with the same signature keep their number, and
 * candidates rendered since (scroll reveals, width changes) are appended.
 */
export async function stampScriptedLinkCandidates( page: Page, timeoutMs = 5_000, previous: readonly string[] = [] ): Promise< string[] > {
	try {
		return await withEvaluateTimeout( page.evaluate( ( { attribute, tags, candidatesSource, signatureSource, limit, previous } ) => {
			const candidates = ( new Function( `return (${ candidatesSource })` )() as ( tags: string[] ) => Element[] )( tags );
			const signature = new Function( `return (${ signatureSource })` )() as ( element: Element ) => string;
			const known = previous.slice();
			const kept = new Set< Element >();
			const used = new Set< string >();
			for ( const element of candidates ) {
				const index = element.getAttribute( attribute );
				if ( index !== null && /^\d+$/.test( index ) && Number( index ) < known.length && ! used.has( index ) && known[ Number( index ) ] === signature( element ) ) {
					used.add( index );
					kept.add( element );
				}
			}
			for ( const stamped of Array.from( document.querySelectorAll( `[${ attribute }]` ) ) ) {
				if ( ! kept.has( stamped ) ) stamped.removeAttribute( attribute );
			}
			for ( const element of candidates ) {
				if ( known.length >= limit ) break;
				if ( kept.has( element ) ) continue;
				element.setAttribute( attribute, String( known.length ) );
				known.push( signature( element ) );
			}
			return known;
		}, { attribute: SCRIPTED_LINK_ATTRIBUTE, tags: LOWERABLE_TAGS, candidatesSource: CANDIDATES_SOURCE, signatureSource: SIGNATURE_SOURCE, limit: SCRIPTED_LINK_LIMIT, previous: [ ...previous ] } ), timeoutMs );
	} catch {
		return [ ...previous ];
	}
}

/**
 * Click each stamped candidate and record the same-origin navigation it
 * starts, without leaving the captured document. Clicks that change nothing,
 * open a dialog, leave the origin, only move to a fragment, or open a window
 * stay unresolved. Bounded by `budgetMs`; candidates left at the deadline are
 * reported as `budget`.
 */
export async function probeScriptedLinks( page: Page, signatures: readonly string[], budgetMs = SCRIPTED_LINK_BUDGET_MS ): Promise< ScriptedLinkEvidence > {
	const empty = ( reason?: ScriptedLinkUnresolvedReason ): ScriptedLinkEvidence => ( {
		candidates: signatures.length, resolved: 0, unresolved: signatures.length, links: {},
		...( reason && signatures.length ? { reasons: { [ reason ]: signatures.length } } : {} ),
	} );
	if ( signatures.length === 0 ) return empty();
	const observed = await withEvaluateTimeout( page.evaluate( async ( { attribute, tags, candidatesSource, signatureSource, signatures, budgetMs, navigationWaitMs, restoreWaitMs } ) => {
		// tsx instruments nested functions with __name(); the built bundle does not.
		const globalWithName = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
		if ( typeof globalWithName.__name === 'undefined' ) globalWithName.__name = ( fn ) => fn;
		type NavigateEvent = Event & { navigationType?: string; destination?: { url: string; sameDocument?: boolean } };
		const navigation = ( window as unknown as { navigation?: EventTarget } ).navigation;
		const links: Record< string, string > = {};
		const reasons: Record< string, number > = {};
		const count = ( reason: string, by = 1 ) => { reasons[ reason ] = ( reasons[ reason ] ?? 0 ) + by; };
		if ( ! navigation ) return { links, reasons: { unsupported: signatures.length } };
		const candidates = new Function( `return (${ candidatesSource })` )() as ( tags: string[] ) => Element[];
		const signature = new Function( `return (${ signatureSource })` )() as ( element: Element ) => string;
		const sleep = ( ms: number ) => new Promise( resolve => setTimeout( resolve, ms ) );
		const frames = () => new Promise( resolve => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) );
		// The captured route renders the same candidates in the same order.
		const restamp = (): boolean => {
			const list = candidates( tags ).slice( 0, signatures.length );
			if ( list.length !== signatures.length || list.some( ( element, index ) => signature( element ) !== signatures[ index ] ) ) return false;
			list.forEach( ( element, index ) => element.setAttribute( attribute, String( index ) ) );
			return true;
		};
		// Otherwise (another surface added or hid candidates) the nth element
		// with this signature is the nth recorded one, when the counts agree.
		const occurrence = ( index: number ): Element | null => {
			const wanted = signatures[ index ];
			const recorded = signatures.filter( value => value === wanted ).length;
			const current = candidates( tags ).filter( element => signature( element ) === wanted );
			if ( current.length !== recorded ) return null;
			const element = current[ signatures.slice( 0, index ).filter( value => value === wanted ).length ] ?? null;
			element?.setAttribute( attribute, String( index ) );
			return element;
		};
		const find = ( index: number ): Element | null => {
			const stamped = document.querySelector( `[${ attribute }="${ index }"]` );
			if ( stamped && stamped.isConnected && signature( stamped ) === signatures[ index ] ) return stamped;
			return restamp() ? document.querySelector( `[${ attribute }="${ index }"]` ) : occurrence( index );
		};

		let armed = false;
		let destination: { url: string; type: string; sameDocument: boolean } | undefined;
		let opened = false;
		const onNavigate = ( event: Event ) => {
			const navigate = event as NavigateEvent;
			// A router saving state on the current entry (scroll restoration)
			// before it pushes is not a navigation; let it through.
			if ( navigate.navigationType === 'replace' && navigate.destination?.sameDocument && navigate.destination.url === location.href ) return;
			if ( armed && ! destination && navigate.destination ) {
				destination = { url: navigate.destination.url, type: navigate.navigationType ?? 'push', sameDocument: navigate.destination.sameDocument === true };
			}
			// Keep the captured document; a same-document push is cancelled too,
			// so the address bar never moves.
			if ( event.cancelable ) event.preventDefault();
		};
		navigation.addEventListener( 'navigate', onNavigate );
		const open = window.open;
		window.open = function () { if ( armed ) opened = true; return null; } as typeof window.open;
		const deadline = performance.now() + budgetMs;
		const route = location.href;
		// Ask a client router to render the captured route again and wait until
		// candidate `index` can be found.
		const restore = async ( index: number ): Promise< boolean > => {
			if ( location.href !== route ) {
				try { history.replaceState( history.state, '', route ); } catch { /* cancelled */ }
			}
			window.dispatchEvent( new PopStateEvent( 'popstate', { state: history.state } ) );
			const restoring = performance.now();
			while ( performance.now() - restoring < restoreWaitMs ) {
				await frames();
				if ( find( index ) ) return quiet( restoring + restoreWaitMs ).then( () => true );
				await sleep( 25 );
			}
			return false;
		};
		// A re-render finishes before its handlers answer clicks: wait until
		// the body stops mutating (bounded).
		const quiet = ( until: number ) => new Promise< void >( resolve => {
			let timer = setTimeout( done, 150 );
			const observer = new MutationObserver( () => { clearTimeout( timer ); timer = setTimeout( done, 150 ); } );
			const cap = setTimeout( done, Math.max( 0, until - performance.now() ) );
			observer.observe( document.body, { subtree: true, childList: true, attributes: true } );
			function done() { observer.disconnect(); clearTimeout( timer ); clearTimeout( cap ); resolve(); }
		} );
		// One click on a candidate; a quiet click is retried once after the
		// document settles, since a transition may still own the click.
		const click = async ( index: number ) => {
			for ( let attempt = 0; attempt < 2; attempt++ ) {
				const element = find( index );
				if ( ! element ) return { element, seen: undefined };
				destination = undefined;
				opened = false;
				armed = true;
				const started = performance.now();
				try { ( element as HTMLElement ).click(); } catch { /* a throwing handler is a click that went nowhere */ }
				while ( ! destination && ! opened && performance.now() - started < navigationWaitMs ) await sleep( 25 );
				armed = false;
				const seen = destination as { url: string; type: string; sameDocument: boolean } | undefined;
				if ( seen || opened || attempt > 0 || performance.now() + navigationWaitMs + 300 > deadline ) return { element, seen };
				await quiet( performance.now() + 300 );
			}
			return { element: null, seen: undefined };
		};
		try {
			// An earlier probe may have left the router showing another route
			// under the captured address.
			if ( ! find( 0 ) && ! ( await restore( 0 ) ) ) return { links, reasons: { 'restore-failed': signatures.length } };
			for ( let index = 0; index < signatures.length; index++ ) {
				if ( performance.now() + navigationWaitMs > deadline ) { count( 'budget', signatures.length - index ); break; }
				const { element, seen } = await click( index );
				if ( ! element ) { count( 'missing' ); continue; }
				if ( opened && ! seen ) count( 'new-window' );
				else if ( ! seen ) count( 'no-navigation' );
				else if ( seen.type === 'reload' || seen.type === 'traverse' ) count( 'reload-or-traverse' );
				else {
					let target: URL | undefined;
					try { target = new URL( seen.url ); } catch { /* not a URL */ }
					const here = new URL( route );
					if ( ! target || target.origin !== here.origin ) count( 'off-origin' );
					else if ( target.hash && target.pathname === here.pathname && target.search === here.search ) count( 'fragment' );
					else links[ String( index ) ] = target.href;
				}
				// A runtime may have rendered the destination despite the cancel.
				// Ask it to render the captured route again before the next click.
				if ( ( seen || ! element.isConnected || location.href !== route ) && index + 1 < signatures.length && ! ( await restore( index + 1 ) ) ) {
					count( 'restore-failed', signatures.length - index - 1 );
					break;
				}
			}
		} finally {
			navigation.removeEventListener( 'navigate', onNavigate );
			window.open = open;
		}
		return { links, reasons };
	}, {
		attribute: SCRIPTED_LINK_ATTRIBUTE, tags: LOWERABLE_TAGS, candidatesSource: CANDIDATES_SOURCE, signatureSource: SIGNATURE_SOURCE,
		signatures: [ ...signatures ], budgetMs, navigationWaitMs: NAVIGATION_WAIT_MS, restoreWaitMs: RESTORE_WAIT_MS,
	} ), budgetMs + NAVIGATION_WAIT_MS + RESTORE_WAIT_MS + 5_000 ).catch( () => undefined );
	if ( ! observed ) return empty( 'budget' );
	const resolved = Object.keys( observed.links ).length;
	return {
		candidates: signatures.length,
		resolved,
		unresolved: signatures.length - resolved,
		links: observed.links,
		...( Object.keys( observed.reasons ).length ? { reasons: observed.reasons as ScriptedLinkEvidence[ 'reasons' ] } : {} ),
	};
}

/**
 * Lower one profile's resolved candidates to native anchors and drop every
 * other stamp. The anchor keeps the element's attributes, classes and children
 * except `role`; its original tag stays in the stamp attribute so a
 * zero-specificity rule restores the UA display, colour and decoration the
 * element had, without outranking author CSS.
 */
export function lowerScriptedLinks( html: string, evidence?: Pick< ScriptedLinkEvidence, 'links' > ): string {
	if ( ! html.includes( SCRIPTED_LINK_ATTRIBUTE ) ) return html;
	const $ = cheerio.load( html );
	const lowered = new Set< string >();
	$( `[${ SCRIPTED_LINK_ATTRIBUTE }]` ).each( ( _index, node ) => {
		const element = $( node );
		const href = evidence?.links[ element.attr( SCRIPTED_LINK_ATTRIBUTE ) ?? '' ];
		const tag = node.tagName.toLowerCase();
		if ( ! href || ! LOWERABLE_TAGS.includes( tag ) || element.parents( 'a[href]' ).length || element.find( 'a[href]' ).length ) {
			element.removeAttr( SCRIPTED_LINK_ATTRIBUTE );
			return;
		}
		if ( tag === 'a' ) {
			element.attr( 'href', href ).removeAttr( 'role' ).attr( SCRIPTED_LINK_ATTRIBUTE, tag );
			lowered.add( tag );
			return;
		}
		const link = $( '<a></a>' );
		for ( const [ name, value ] of Object.entries( element.attr() ?? {} ) ) {
			if ( name === 'role' || name === SCRIPTED_LINK_ATTRIBUTE ) continue;
			link.attr( name, value );
		}
		link.attr( 'href', href ).attr( SCRIPTED_LINK_ATTRIBUTE, tag ).append( element.contents() );
		element.replaceWith( link );
		lowered.add( tag );
	} );
	if ( lowered.size ) {
		const selector = `a[${ SCRIPTED_LINK_ATTRIBUTE }]`;
		const block = [ ...lowered ].filter( tag => BLOCK_TAGS.has( tag ) ).map( tag => `a[${ SCRIPTED_LINK_ATTRIBUTE }="${ tag }"]` );
		const rules = [
			`:where(${ selector }){color:inherit;text-decoration:inherit}`,
			...( block.length ? [ `:where(${ block.join( ',' ) }){display:block}` ] : [] ),
		];
		const head = $( 'head' );
		const style = `<style data-blocks-engine-capture-scripted-link-style="">${ rules.join( '' ) }</style>`;
		// First in <head>, so any author rule of equal (zero) specificity wins.
		if ( head.length ) head.prepend( style );
		else $.root().prepend( style );
	}
	return $.html();
}
