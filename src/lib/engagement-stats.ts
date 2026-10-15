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
 *
 * The source's numbers are data, not markup: a platform that can read them
 * reports each route's counts once (`Platform.engagementStats`), and capture
 * records them in the receipt keyed by route URL. A route's counts never come
 * from its document, so a document shared between routes cannot carry another
 * route's numbers.
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

export const ENGAGEMENT_STATS_SCHEMA = 'blocks-engine-capture/engagement-stats/v1';

/** One route's source counters at capture time. */
export interface RouteEngagementCounts {
	url: string;
	views?: number;
	likes?: number;
	comments?: number;
}

/** What a platform read: counts per route, and routes it could not read. */
export interface EngagementStatsReading {
	provider: string;
	pages: RouteEngagementCounts[];
	unavailable: Array< { url: string; reason: string } >;
}

/** The receipt record: the reading plus the marker binding a destination needs. */
export function engagementStatsRecord( reading: EngagementStatsReading, readAt: string ) {
	return {
		schema: ENGAGEMENT_STATS_SCHEMA,
		provider: reading.provider,
		readAt,
		binding: { attribute: ENGAGEMENT_STATS_ATTRIBUTE, classPrefix: ENGAGEMENT_STATS_CLASS_PREFIX },
		pages: reading.pages,
		unavailable: reading.unavailable,
	};
}
