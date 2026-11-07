import { expect, it, vi } from 'vitest';
import type { CapturedComponent } from './component-states.js';
import type { CapturedDialogInteraction, InteractionStatesReport } from './interaction-capture.js';
import { mergeInteractionReports } from './screenshotter.js';

vi.mock( '../browser-kit/index.js', async ( importOriginal ) => ( { ...( await importOriginal< typeof import( '../browser-kit/index.js' ) >() ), connectBrowser: vi.fn() } ) );

const menu = ( selector: string, closed: string, open?: CapturedDialogInteraction ): CapturedComponent => ( {
	selector, kind: 'menu', initial: 'closed', status: 'captured',
	states: [ { id: 'closed', html: closed }, ...( open ? [ { id: 'open', html: open.dialog!.html, evidence: open } ] : [] ) ],
	transitions: open ? [ { from: 'closed', to: 'open', trigger: { selector, action: 'click' } } ] : [],
} );
const dialog = ( id: string, label: string, html: string ): CapturedDialogInteraction => ( {
	status: 'captured', trigger: { id, selector: `#${ id }`, tag: 'a', label, ariaHaspopup: 'menu', dataBindings: {} },
	dialog: { selector: `#panel-${ id }`, tag: 'ul', ariaModal: false, html, htmlBytes: html.length, htmlTruncated: false },
} );
const report = ( width: number, components: CapturedComponent[], states: CapturedDialogInteraction[] ): InteractionStatesReport => ( {
	schema: 'blocks-engine-capture/interaction-states/v2', sourceUrl: 'https://example.com/store', viewport: { width, height: 900 }, capturedAt: '', states, components,
} );

// Runtime ids are numbered per document: the desktop `#1` is the "More"
// dropdown while the phone document's `#1` is its menu toggle.
const more = dialog( '1', 'More', '<ul id="more">Contact</ul>' );
const desktop = report( 1440, [
	menu( '#\\31 ', '<a id="1">More</a>', more ),
	menu( '#\\36 ', '<a id="6" aria-label="Menu">Menu</a>' ),
], [ more ] );
const toggle = dialog( '1', 'Menu', '<div id="drawer">Drawer</div>' );
const phone = report( 402, [
	menu( '#\\31 ', '<a id="1" aria-label="Menu">Menu</a>', toggle ),
	menu( '#\\36 ', '<a id="6">Search</a>' ),
	menu( '#\\39 ', '<a id="9">Phone only</a>', dialog( '9', 'Phone only', '<div>Phone panel</div>' ) ),
], [ toggle ] );

it( 'keeps desktop evidence when a dual route phone document numbers another control with the same id', () => {
	const merged = mergeInteractionReports( desktop, phone, { keepPrevious: true } );
	const components = merged.components!.map( component => [ component.selector, component.states.map( state => state.html ) ] );
	expect( components ).toEqual( [
		[ '#\\31 ', [ '<a id="1">More</a>', '<ul id="more">Contact</ul>' ] ],
		[ '#\\36 ', [ '<a id="6" aria-label="Menu">Menu</a>' ] ],
		// Another control behind a colliding id is kept for the label resolver.
		[ '#\\31 ', [ '<a id="1" aria-label="Menu">Menu</a>', '<div id="drawer">Drawer</div>' ] ],
		[ '#\\39 ', [ '<a id="9">Phone only</a>', '<div>Phone panel</div>' ] ],
	] );
	expect( merged.states.map( state => state.trigger.label ) ).toEqual( [ 'More', 'Menu' ] );
	expect( merged.viewport.width ).toBe( 1440 );
} );

it( 'never lets the phone pass replace desktop evidence for the same control', () => {
	const phoneMore = dialog( '1', 'More', '<ul id="more">Phone copy</ul>' );
	const merged = mergeInteractionReports( desktop, report( 402, [ menu( '#\\31 ', '<a id="1">More</a>', phoneMore ) ], [ phoneMore ] ), { keepPrevious: true } );
	expect( merged.components!.filter( component => component.selector === '#\\31 ' ).map( component => component.states[ 1 ].html ) ).toEqual( [ '<ul id="more">Contact</ul>' ] );
	expect( merged.states.map( state => state.dialog?.html ) ).toEqual( [ '<ul id="more">Contact</ul>' ] );
} );

it( 'still lets a later pass over the same document refresh its evidence', () => {
	const merged = mergeInteractionReports( desktop, phone );
	expect( merged.components!.find( component => component.selector === '#\\31 ' )!.states[ 0 ].html ).toBe( '<a id="1" aria-label="Menu">Menu</a>' );
} );
