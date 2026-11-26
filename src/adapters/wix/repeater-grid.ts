// src/adapters/wix/repeater-grid.ts
//
// Wix lays out a card list (`<fluid-columns-repeater>`) with a script. On
// every resize it counts how many fixed-width items fit, centres them, and
// writes `position:absolute` offsets for each item into a <style> keyed by the
// container id. Without the script the copy only has those offsets. The width
// sweep then learns them as many `@media` rules with `!important` offsets,
// which the destination cannot edit, and the column switch lands at a sampled
// width instead of the real one.
//
// The script's layout is close to a plain grid: columns of the item width, a
// gap of twice `horizontal-gap` between them and `horizontal-gap` at each
// edge, as many columns as fit. So the script is stopped before the sweep and
// the list is declared as `repeat(auto-fill, minmax(<item width>, 1fr))`,
// which the importer turns into a native grid layout with the same column
// count at every width. Two things differ from the script: the spare width
// goes to the columns instead of being split around them (`justify-content`),
// and rows line up instead of each column stacking on its own.
//
import type { Page } from 'playwright';

/** One repeater as read from the page. */
export interface WixRepeaterReading {
	horizontalGap: string | null;
	verticalGap: string | null;
	/** Rendered width of each item, in px. */
	itemWidths: number[];
}

const gapPixels = ( value: string | null ): number | null => value !== null && /^\d+$/.test( value.trim() ) ? parseInt( value, 10 ) : null;

/**
 * The declarations that reproduce a repeater's layout as a grid, or null when
 * the repeater is not one this can describe: unreadable gaps, no items, or
 * items of different widths.
 */
export function wixRepeaterGridStyle( reading: WixRepeaterReading ): Record< string, string > | null {
	const horizontal = gapPixels( reading.horizontalGap );
	const vertical = gapPixels( reading.verticalGap );
	const [ first, ...rest ] = reading.itemWidths;
	if ( horizontal === null || vertical === null || first === undefined || ! ( first > 0 ) ) return null;
	if ( rest.some( width => Math.abs( width - first ) > 1 ) ) return null;
	const width = Math.round( first * 100 ) / 100;
	return {
		'display': 'grid',
		'grid-template-columns': `repeat(auto-fill, minmax(${ width }px, 1fr))`,
		'gap': `${ 2 * vertical }px ${ 2 * horizontal }px`,
		'padding': `${ vertical }px ${ horizontal }px`,
		'align-items': 'start',
	};
}

/**
 * Stop each repeater's script and declare its layout as a static grid. A
 * repeater the grid cannot describe keeps its script. Returns how many were
 * converted.
 */
export async function staticWixRepeaters( page: Page ): Promise< number > {
	const readings = await page.evaluate( () => [ ...document.querySelectorAll( 'fluid-columns-repeater' ) ].map( repeater => ( {
		horizontalGap: repeater.getAttribute( 'horizontal-gap' ),
		verticalGap: repeater.getAttribute( 'vertical-gap' ),
		itemWidths: [ ...repeater.children ].map( item => item.getBoundingClientRect().width ),
	} ) ) );
	const styles = readings.map( wixRepeaterGridStyle );
	if ( styles.every( style => style === null ) ) return 0;
	return page.evaluate( ( styles ) => {
		let converted = 0;
		[ ...document.querySelectorAll( 'fluid-columns-repeater' ) ].forEach( ( repeater, index ) => {
			const style = styles[ index ];
			const element = repeater as HTMLElement & { disconnectedCallback?: () => void };
			if ( ! style || typeof element.disconnectedCallback !== 'function' ) return;
			// The element's own teardown: it stops observing resizes and removes
			// the stylesheet of offsets it wrote.
			element.disconnectedCallback();
			const containerId = repeater.getAttribute( 'container-id' );
			for ( const sheet of document.querySelectorAll( 'style[id]' ) ) {
				if ( containerId && sheet.id.startsWith( `${ containerId }-styles-` ) ) sheet.remove();
			}
			for ( const [ property, value ] of Object.entries( style ) ) element.style.setProperty( property, value );
			// Wix spaces the static fallback with item margins; the grid gap replaces them.
			for ( const item of repeater.children ) ( item as HTMLElement ).style.setProperty( 'margin', '0' );
			converted++;
		} );
		return converted;
	}, styles );
}
