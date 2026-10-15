import { mapPool } from '../../lib/concurrency.js';
import type { EngagementStatsReading, RouteEngagementCounts } from '../../lib/engagement-stats.js';

/** Wix Blog's app definition id: the key of its instance in the visitor token response. */
export const WIX_BLOG_APP_DEF_ID = '14bcded7-0066-7c35-14d7-466cb3f09103';

const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

/** The post slug of a Wix Blog post route (`…/post/<slug>`), else undefined. */
export function wixPostSlug( url: string ): string | undefined {
	try {
		const match = new URL( url ).pathname.match( /\/post\/([^/]+)\/?$/ );
		return match ? decodeURIComponent( match[ 1 ]! ) : undefined;
	} catch {
		return undefined;
	}
}

/** The site's base for its `_api` paths: a free `wixsite.com/<site>` serves them under its first segment. */
function apiBase( url: string ): string {
	const parsed = new URL( url );
	const base = parsed.hostname.endsWith( '.wixsite.com' ) ? `/${ parsed.pathname.split( '/' )[ 1 ] ?? '' }` : '';
	return `${ parsed.origin }${ base.replace( /\/$/, '' ) }`;
}

type Fetch = typeof fetch;

/**
 * Read each Wix Blog post's view, like and comment counts, the same way the
 * site's own post page does: one anonymous visitor token, then the public
 * post-metadata endpoint per post, with `skipViewCountIncrement` so reading
 * never counts as a view.
 */
export async function readWixEngagementStats( urls: readonly string[], opts: { deadline?: number; fetchImpl?: Fetch } = {} ): Promise< EngagementStatsReading | undefined > {
	const doFetch = opts.fetchImpl ?? fetch;
	const posts = urls.map( url => ( { url, slug: wixPostSlug( url ) } ) ).filter( ( post ): post is { url: string; slug: string } => post.slug !== undefined );
	if ( ! posts.length ) return undefined;
	const reading: EngagementStatsReading = { provider: 'wix', pages: [], unavailable: [] };
	const timeout = () => AbortSignal.timeout( Math.max( 1, Math.min( REQUEST_TIMEOUT_MS, ( opts.deadline ?? Infinity ) - Date.now() ) ) );
	const base = apiBase( posts[ 0 ]!.url );
	let instance: string | undefined;
	try {
		const response = await doFetch( `${ base }/_api/v1/access-tokens`, { signal: timeout() } );
		const tokens = response.ok ? await response.json() as { apps?: Record< string, { instance?: string } > } : undefined;
		instance = tokens?.apps?.[ WIX_BLOG_APP_DEF_ID ]?.instance;
	} catch {
		instance = undefined;
	}
	if ( ! instance ) {
		reading.unavailable = posts.map( ( { url } ) => ( { url, reason: 'no Wix Blog visitor token' } ) );
		return reading;
	}
	await mapPool( posts, CONCURRENCY, async ( { url, slug } ) => {
		if ( opts.deadline !== undefined && Date.now() >= opts.deadline ) {
			reading.unavailable.push( { url, reason: 'capture time budget spent' } );
			return;
		}
		try {
			const response = await doFetch( `${ base }/_api/blog-frontend-adapter-public/v2/post-page-metadata/${ encodeURIComponent( slug ) }`, {
				method: 'POST',
				headers: { authorization: instance!, 'content-type': 'application/json' },
				body: JSON.stringify( { postId: slug, skipViewCountIncrement: true } ),
				signal: timeout(),
			} );
			if ( ! response.ok ) {
				await response.body?.cancel();
				reading.unavailable.push( { url, reason: `post metadata HTTP ${ response.status }` } );
				return;
			}
			const metadata = ( await response.json() as { postPageMetadata?: { postMetadata?: Record< string, unknown > } } ).postPageMetadata?.postMetadata;
			const count = ( value: unknown ) => typeof value === 'number' && Number.isFinite( value ) && value >= 0 ? value : undefined;
			const counts: RouteEngagementCounts = { url, views: count( metadata?.viewCount ), likes: count( metadata?.likeCount ), comments: count( metadata?.totalComments ) };
			if ( counts.views === undefined && counts.likes === undefined && counts.comments === undefined ) reading.unavailable.push( { url, reason: 'post metadata carried no counts' } );
			else reading.pages.push( counts );
		} catch ( error ) {
			reading.unavailable.push( { url, reason: error instanceof Error ? error.message : String( error ) } );
		}
	} );
	reading.pages.sort( ( a, b ) => a.url.localeCompare( b.url ) );
	reading.unavailable.sort( ( a, b ) => a.url.localeCompare( b.url ) );
	return reading;
}
