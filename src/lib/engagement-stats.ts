/**
 * Engagement counters whose values cannot travel with the copy.
 *
 * Blog platforms show per-post counters (views, comments, likes) that their
 * runtime fetches after load: the server document carries only a placeholder,
 * and the number the browser shows belongs to that moment and that platform's
 * analytics. A copy that freezes it shows a stale number forever, and a page
 * produced from another page of the same template would show that page's
 * number. The counter is a feature of the destination, not content.
 *
 * So capture empties the counter element and marks where it was, as a class
 * (`data-blocks-engine-capture-engagement-stats-<provider>`) plus a
 * `data-blocks-engine-capture-engagement-stats="<provider>"` attribute. The
 * class is the durable marker: block conversion keeps classes where it drops
 * data attributes. A destination with its own counters (WordPress: Jetpack
 * post views and likes) renders them at the marker; one without leaves the
 * empty element.
 */

/** Marks an emptied engagement counter; the value names the provider. */
export const ENGAGEMENT_STATS_ATTRIBUTE = 'data-blocks-engine-capture-engagement-stats';
/** Class prefix for the same marker; the provider id is appended. */
export const ENGAGEMENT_STATS_CLASS_PREFIX = 'data-blocks-engine-capture-engagement-stats-';

export interface EngagementStats {
	/** Lower-case provider id written into the marker, such as `wix`. */
	provider: string;
	/** The platform's per-post counter container. */
	selector: string;
}

/**
 * Serialized into the page. Empties every counter container and marks it,
 * keeping the element itself so the layout keeps its slot. Returns how many
 * containers were marked.
 */
export function markEngagementStats( args: EngagementStats & { attribute: string; classPrefix: string } ): number {
	let marked = 0;
	for ( const element of document.querySelectorAll( args.selector ) ) {
		element.replaceChildren();
		element.removeAttribute( 'aria-label' );
		element.classList.add( args.classPrefix + args.provider );
		element.setAttribute( args.attribute, args.provider );
		marked++;
	}
	return marked;
}
