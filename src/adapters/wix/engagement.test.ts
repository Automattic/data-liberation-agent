import { describe, expect, it } from 'vitest';
import { readWixEngagementStats, WIX_BLOG_APP_DEF_ID, wixPostSlug } from './engagement.js';

// Responses shaped like ketatov.com's (2026-10-15).
const tokenResponse = { visitorId: 'v', apps: { [ WIX_BLOG_APP_DEF_ID ]: { instance: 'blog-instance-token' }, other: { instance: 'x' } } };
const metadata = ( views: number ) => ( { postPageMetadata: { id: 'p', postMetadata: { averageRating: 0, likeCount: 2, totalComments: 1, totalRatings: 0, viewCount: views, liked: false } } } );

function fakeFetch( views: Record< string, number > ) {
	const calls: Array< { url: string; init?: RequestInit } > = [];
	const impl = async ( input: string | URL | Request, init?: RequestInit ) => {
		const url = String( input );
		calls.push( { url, init } );
		if ( url.endsWith( '/_api/v1/access-tokens' ) ) return new Response( JSON.stringify( tokenResponse ) );
		const slug = decodeURIComponent( url.split( '/' ).pop()! );
		if ( slug in views ) return new Response( JSON.stringify( metadata( views[ slug ]! ) ) );
		return new Response( 'not found', { status: 404 } );
	};
	return { calls, impl: impl as typeof fetch };
}

describe( 'Wix engagement stats (#784)', () => {
	it( 'reads each post its own counts, read-only, and skips non-post routes', async () => {
		const { calls, impl } = fakeFetch( { 'holding-the-emotions': 107, 'first-time-in-a-competition-ring': 265 } );
		const reading = await readWixEngagementStats( [
			'https://www.ketatov.com/',
			'https://www.ketatov.com/post/holding-the-emotions',
			'https://www.ketatov.com/post/first-time-in-a-competition-ring',
			'https://www.ketatov.com/post/deleted-post',
		], { fetchImpl: impl } );
		expect( reading?.provider ).toBe( 'wix' );
		expect( reading?.pages ).toEqual( [
			{ url: 'https://www.ketatov.com/post/first-time-in-a-competition-ring', views: 265, likes: 2, comments: 1 },
			{ url: 'https://www.ketatov.com/post/holding-the-emotions', views: 107, likes: 2, comments: 1 },
		] );
		expect( reading?.unavailable ).toEqual( [ { url: 'https://www.ketatov.com/post/deleted-post', reason: 'post metadata HTTP 404' } ] );
		const posts = calls.filter( call => call.init?.method === 'POST' );
		expect( posts ).toHaveLength( 3 );
		for ( const call of posts ) {
			expect( ( call.init!.headers as Record< string, string > ).authorization ).toBe( 'blog-instance-token' );
			expect( JSON.parse( String( call.init!.body ) ).skipViewCountIncrement ).toBe( true );
		}
	} );

	it( 'reports every post unavailable when the site has no blog token', async () => {
		const impl = ( async () => new Response( JSON.stringify( { apps: {} } ) ) ) as unknown as typeof fetch;
		const reading = await readWixEngagementStats( [ 'https://www.ketatov.com/post/a' ], { fetchImpl: impl } );
		expect( reading ).toEqual( { provider: 'wix', pages: [], unavailable: [ { url: 'https://www.ketatov.com/post/a', reason: 'no Wix Blog visitor token' } ] } );
	} );

	it( 'does nothing on a site without post routes', async () => {
		const { calls, impl } = fakeFetch( {} );
		expect( await readWixEngagementStats( [ 'https://www.ketatov.com/', 'https://www.ketatov.com/about' ], { fetchImpl: impl } ) ).toBeUndefined();
		expect( calls ).toHaveLength( 0 );
	} );

	it( 'finds the post slug under a free-site prefix', () => {
		expect( wixPostSlug( 'https://user.wixsite.com/site/post/my-post' ) ).toBe( 'my-post' );
		expect( wixPostSlug( 'https://www.ketatov.com/blog' ) ).toBeUndefined();
	} );
} );
