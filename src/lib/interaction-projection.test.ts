import { expect, it } from 'vitest';
import { interactionReportMismatch, projectInteractionReport } from './interaction-projection.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';

/**
 * A Wix blog post's share menu sits in the post body with a per-post trigger
 * id, and the FAQ widget mints fresh panel ids on every load. Derivation keeps
 * the representative's skeleton node and the member's id; the projected
 * report must name the member's control and match the member's own capture.
 */
const doc = ( id: string ) => `<main><button data-blocks-engine-node-id="n759" id="${ id }" aria-haspopup="menu" aria-label="More actions"></button></main>`;
const report = ( postId: string, faqId: string, labels = [ 'More actions' ] ): InteractionStatesReport => ( {
	schema: 'blocks-engine-capture/interaction-states/v2',
	sourceUrl: `https://example.com/post/${ postId }`,
	viewport: { width: 1440, height: 900 },
	capturedAt: new Date().toISOString(),
	states: labels.map( label => ( {
		status: 'captured' as const,
		trigger: { selector: `#${ postId }`, tag: 'button', id: postId, ariaHaspopup: 'menu', label, dataBindings: {} },
		dialog: { selector: '[data-lib-interaction-dialog="captured"]', tag: 'div', ariaModal: false, html: `<div role="menu" aria-labelledby="${ postId }"><button aria-controls="${ faqId }">Share Post</button><div id="${ faqId }"></div></div>`, htmlBytes: 128, htmlTruncated: false },
	} ) ),
} );

it.each( [
	{ name: 'per-post ids project and runtime ids compare by reference', captured: report( 'more-button-member', 'faq-i0vrs54202' ), mismatch: undefined },
	{ name: 'a menu only the member captured fails', captured: report( 'more-button-member', 'faq-i0vrs54202', [ 'More actions', 'More' ] ), mismatch: 'states: 1 projected, 2 captured (captured-only "More")' },
] )( '$name', ( { captured, mismatch } ) => {
	const projected = projectInteractionReport( doc( 'more-button-rep' ), doc( 'more-button-member' ), report( 'more-button-rep', 'faq-clu20111699' ) );
	expect( projected?.states[ 0 ]?.trigger ).toMatchObject( { id: 'more-button-member', selector: '#more-button-member' } );
	expect( projected?.states[ 0 ]?.dialog?.html ).toContain( 'aria-labelledby="more-button-member"' );
	expect( interactionReportMismatch( projected, captured ) ).toBe( mismatch );
} );

/**
 * Each post body carries its own FAQ accordion: different questions, a
 * different number of items. Every member item replays the representative's
 * observed toggle on the member's own question, addressed where it sits.
 */
it( 'replays a content accordion on every member item', () => {
	const item = ( question: string, id: string ) => `<div class="faq"><div role="button" aria-expanded="false" aria-controls="${ id }">${ question }</div><div id="${ id }" class="body collapsed">Answer</div></div>`;
	const page = ( items: string ) => `<html><body><main data-blocks-engine-node-id="n1"><article>${ items }</article></main></body></html>`;
	const repPage = page( item( 'Rep question?', 'clu1' ) );
	const memberPage = page( item( 'First member question?', 'i0v1' ) + item( 'Second member question?', 'i0v2' ) );
	const selector = 'body > main:nth-of-type(1) > article:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1)';
	const open = '<div role="button" aria-expanded="true" aria-controls="clu1">Rep question?</div><div id="clu1" class="body">Answer</div>';
	const projected = projectInteractionReport( repPage, memberPage, {
		...report( 'rep', 'clu1' ),
		states: [],
		components: [ { selector, kind: 'disclosure', initial: 'closed', states: [ { id: 'open', html: open } ], transitions: [ { from: 'closed', to: 'open', trigger: { selector, action: 'click' } } ], status: 'captured' } ],
	} );
	expect( projected?.components?.map( component => [ component.selector, component.transitions[ 0 ]!.trigger.selector, component.states[ 0 ]!.html ] ) ).toEqual( [
		[ selector, selector, '<div role="button" aria-expanded="true" aria-controls="i0v1">First member question?</div><div id="i0v1" class="body">Answer</div>' ],
		[ selector.replace( 'div:nth-of-type(1) > div', 'div:nth-of-type(2) > div' ), selector.replace( 'div:nth-of-type(1) > div', 'div:nth-of-type(2) > div' ), '<div role="button" aria-expanded="true" aria-controls="i0v2">Second member question?</div><div id="i0v2" class="body">Answer</div>' ],
	] );
} );
