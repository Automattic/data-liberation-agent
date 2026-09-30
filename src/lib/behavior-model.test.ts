import { describe, expect, it } from 'vitest';
import { learnTextReveals } from './behavior-model.js';
import type { BehaviorTrace } from './screenshot/behavior-capture.js';

const trace = ( text: BehaviorTrace[ 'text' ] ): BehaviorTrace => ( { text, visibility: {}, canvas: {}, events: [], truncated: false } );
describe( 'observed text reveal semantics', () => {
	it( 'learns different target IDs, text and timer intervals from evidence', () => {
		for ( const [ name, value, interval ] of [ [ '#first', 'HELLO', 30 ], [ '#renamed', 'Changed copy', 72 ] ] as const ) {
			const history = [ { at: 0, text: '' }, ...Array.from( value ).map( ( _, index ) => ( { at: 400 + index * interval, text: value.slice( 0, index + 1 ) } ) ) ];
			expect( learnTextReveals( trace( { [ name ]: history } ) ) ).toEqual( [ { selector: name, startMs: 400, intervalMs: interval, characters: value.length, confidence: 'observed_prefix_progression' } ] );
		}
	} );
	it( 'does not reinterpret a clock, random counter or final snapshot as a typewriter', () => {
		expect( learnTextReveals( trace( { '#counter': [ { at: 0, text: '10' }, { at: 50, text: '11' }, { at: 100, text: '12' }, { at: 150, text: '13' } ], '#static': [ { at: 0, text: 'Visible copy' } ] } ) ) ).toEqual( [] );
	} );
	it( 'keeps cyclic loading dots distinct from one-shot editorial reveal', () => {
		const frames = [ '', '.', '..', '...', '', '.', '..', '...' ].map( ( text, index ) => ( { at: index * 100, text } ) );
		expect( learnTextReveals( trace( { '#cycle': frames } ) ) ).toEqual( [] );
	} );
	it( 'learns the rate when coalesced mutation sampling skips characters', () => {
		const frames = [ { at: 0, text: '' }, { at: 100, text: 'A' }, { at: 160, text: 'ABC' }, { at: 190, text: 'ABCD' }, { at: 250, text: 'ABCDEF' } ];
		expect( learnTextReveals( trace( { '#coalesced': frames } ) )[ 0 ] ).toMatchObject( { selector: '#coalesced', startMs: 100, intervalMs: 30, characters: 6 } );
	} );
	it( 'rejects an instantaneous whole-string swap as a reveal', () => {
		const frames = [ { at: 0, text: '' }, { at: 100, text: 'A' }, { at: 101, text: 'AB' }, { at: 102, text: 'ABCDEFGHIJKL' } ];
		expect( learnTextReveals( trace( { '#swap': frames } ) ) ).toEqual( [] );
	} );
	it( 'recognizes a click replay resetting existing saved text before revealing it', () => {
		const frames = [ 'WORD', '', 'W', 'WO', 'WOR', 'WORD' ].map( ( text, index ) => ( { at: index * 30, text } ) );
		expect( learnTextReveals( trace( { '#saved': frames } ) )[ 0 ] ).toMatchObject( { selector: '#saved', intervalMs: 30, characters: 4 } );
	} );
} );
