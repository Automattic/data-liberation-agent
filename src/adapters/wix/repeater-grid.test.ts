import { existsSync } from 'node:fs';
import { describe, expect } from 'vitest';
import { it, type BrowserFixtures } from '../../../test/browser.js';
import { chromium } from 'playwright';
import { learnAndApplyFluidGeometry } from '../../lib/screenshot/fluid-capture.js';
import { RUNTIME_SHEET_RULES_ATTRIBUTE } from '../../lib/screenshot/fluid-runtime-sheets.js';
import { capture } from './capture.js';
import { wixRepeaterGridStyle } from './repeater-grid.js';

describe( 'wixRepeaterGridStyle', () => {
	it( 'declares columns of the item width with the runtime gaps', () => {
		expect( wixRepeaterGridStyle( { horizontalGap: '20', verticalGap: '10', itemWidths: [ 315, 315, 315 ] } ) ).toEqual( {
			'display': 'grid',
			'grid-template-columns': 'repeat(auto-fill, minmax(315px, 1fr))',
			'gap': '20px 40px',
			'padding': '10px 20px',
			'align-items': 'start',
		} );
	} );

	it( 'declines repeaters it cannot describe', () => {
		expect( wixRepeaterGridStyle( { horizontalGap: '20', verticalGap: '20', itemWidths: [] } ) ).toBeNull();
		expect( wixRepeaterGridStyle( { horizontalGap: '20', verticalGap: '20', itemWidths: [ 315, 200 ] } ) ).toBeNull();
		expect( wixRepeaterGridStyle( { horizontalGap: null, verticalGap: '20', itemWidths: [ 315 ] } ) ).toBeNull();
		expect( wixRepeaterGridStyle( { horizontalGap: '20px', verticalGap: '20', itemWidths: [ 315 ] } ) ).toBeNull();
	} );
} );

/**
 * A stand-in for the Wix columns repeater: three 315 px cards, as many columns
 * as fit, centred, placed absolutely by a stylesheet the element rewrites on
 * every resize and removes when it is disconnected.
 */
const page = `<style>body{margin:0}.repeater{margin:0 20px}
	.list{display:flex;flex-wrap:wrap;position:relative}.list>*{margin:20px}
	.card{width:315px;height:200px;background:#999}</style>
	<div id="comp-cards" class="repeater"><div id="comp-cards_wrapper">
		<fluid-columns-repeater horizontal-gap="20" vertical-gap="20" justify-content="center" container-id="comp-cards_wrapper" items="3" class="list" role="list" direction="ltr">
			<div id="card-1" class="card" role="listitem"></div><div id="card-2" class="card" role="listitem"></div><div id="card-3" class="card" role="listitem"></div>
		</fluid-columns-repeater>
	</div></div>
	<script id="runtime">
		customElements.define( 'fluid-columns-repeater', class extends HTMLElement {
			connectedCallback() {
				this.sheet = document.head.appendChild( Object.assign( document.createElement( 'style' ), { id: 'comp-cards_wrapper-styles-1' } ) );
				this.observer = new ResizeObserver( () => this.layOut() );
				this.observer.observe( this );
			}
			disconnectedCallback() { this.observer.disconnect(); this.sheet.remove(); }
			layOut() {
				const width = this.getBoundingClientRect().width;
				const columns = Math.max( Math.floor( width / 355 ), 1 );
				const spare = width - Math.min( columns, 3 ) * 355;
				this.sheet.textContent = [ ...this.children ].map( ( item, index ) =>
					'#comp-cards_wrapper #' + item.id + ' {position: absolute; top: ' + ( 20 + Math.floor( index / columns ) * 260 ) + 'px; inset-inline-start: ' + ( spare / 2 + 20 + ( index % columns ) * 355 ) + 'px; margin: 0;}'
				).join( '\\n' );
			}
		} );
	</script>`;

/** Each card's left edge and top, relative to the repeater. */
const cards = () => {
	const list = document.querySelector( 'fluid-columns-repeater' )!.getBoundingClientRect();
	return [ ...document.querySelectorAll( '.card' ) ].map( card => {
		const box = card.getBoundingClientRect();
		return [ Math.round( box.x - list.x ), Math.round( box.y - list.y ) ];
	} );
};

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'wix columns repeater', () => {
	/** Run the hooks and the width sweep in capture order at 1440, then render the frozen document (no runtime) at each width. */
	const frozenAt = async ( { newPage }: Pick< BrowserFixtures, 'newPage' >, widths: number[] ) => {
		const tab = await newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await tab.setContent( page );
			await capture.beforeSerialize!( tab, { url: 'https://example.com/', viewport: 'desktop' } );
			await learnAndApplyFluidGeometry( tab, { settleMs: 10 } );
			const frozen = await tab.evaluate( () => {
				document.getElementById( 'runtime' )!.remove();
				return document.documentElement.outerHTML;
			} );
			const copy = await newPage( { viewport: { width: 1440, height: 900 } } );
			try {
				await copy.setContent( frozen );
				const results: Record< number, number[][] > = {};
				for ( const width of widths ) {
					await copy.setViewportSize( { width, height: 900 } );
					results[ width ] = await copy.evaluate( cards );
				}
				return { frozen, results };
			} finally {
				await copy.close();
			}
		} finally {
			await tab.close();
		}
	};

	it( 'captures the repeater as a static grid with no learned offsets for its cards', async ( { newPage } ) => {
		const { frozen, results } = await frozenAt( { newPage }, [ 390, 1000, 1440 ] );
		expect( frozen ).toContain( 'grid-template-columns: repeat(auto-fill, minmax(315px, 1fr))' );
		expect( frozen ).not.toContain( 'comp-cards_wrapper-styles-' );
		expect( frozen ).not.toContain( RUNTIME_SHEET_RULES_ATTRIBUTE );
		expect( frozen ).not.toMatch( /#card-\d[^{]*\{[^}]*!important/ );
		// One, two and three columns, as the runtime lays them out at these widths.
		expect( results[ 390 ]!.map( ( [ , top ] ) => top ) ).toEqual( [ 20, 260, 500 ] );
		expect( results[ 1000 ]!.map( ( [ , top ] ) => top ) ).toEqual( [ 20, 20, 260 ] );
		expect( results[ 1440 ]!.map( ( [ , top ] ) => top ) ).toEqual( [ 20, 20, 20 ] );
	}, 60_000 );
} );
