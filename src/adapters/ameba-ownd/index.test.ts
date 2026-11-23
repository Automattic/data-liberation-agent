import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as cheerio from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../index.js';
import { detect, detectFromDocument } from '../../lib/detect-platform/detect-platform.js';
import { routeInScope } from '../../lib/url/route-scope.js';
import { structuredContentIndex } from '../../lib/content-index.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import { amebaOwndAdapter as adapter } from './index.js';
import { amebaNextState } from './next-data.js';
import { amebaRouteKind } from './routes.js';
import { amebaBodyEquivalent, amebaDisplayDate, amebaLocalTimestamp, amebaMemberDocument, amebaPostEntry, amebaStructuredContent, enumerateAmebaContent } from './content.js';
import { prepareAmebaDocument } from './acquisition.js';
import { discover } from './discover.js';
import { canonicalizeAmebaHtml } from './canonicalize.js';

// Trimmed real documents from an Ameba Ownd blog: field names and markup as served.
const ORIGIN = 'https://ymdjk-24365.amebaownd.com';
const postHtml = readFileSync( new URL( './fixtures/post.html', import.meta.url ), 'utf8' );
type NextData = { props: { pageProps: { state: Record< string, unknown > } } };
const nextData = ( name: 'list' | 'category' | 'archive' | 'page' ): NextData =>
	JSON.parse( readFileSync( new URL( `./fixtures/${ name }.json`, import.meta.url ), 'utf8' ) ) as NextData;
const document = ( data: unknown, body = '<div role="main"><p>Content</p></div>' ) =>
	'<!DOCTYPE html><html lang="ja"><head><meta name="twitter:app:url:iphone" content="amebaownd://public/sites/662697"/>'
	+ '<link href="https://static.amebaowndme.com/madrid-frontend/css/vanilla/index.min-972bbe4ec.css" rel="stylesheet" type="text/css"/>'
	+ `<script src="/_next/static/chunks/turbopack-2c3mg3r-05n1w.js" defer=""></script></head><body><div id="__next">${ body }</div>`
	+ `<script id="__NEXT_DATA__" type="application/json">${ JSON.stringify( data ).replace( /</g, '\\u003c' ) }</script></body></html>`;
const listPosts = () => Object.values( nextData( 'list' ).props.pageProps.state.postList as Record< string, { data: Array< Record< string, unknown > > } > )[ 0 ]!.data;
const listPage = ( posts: unknown[], total: number, limit: number ) => {
	const data = nextData( 'list' );
	data.props.pageProps.state.postList = { 'postList-limit:2-page:1-siteId:662697': { fetching: false, loaded: true, meta: { code: 200, pagination: { total, offset: 0, limit } }, data: posts } };
	return document( data );
};
const response = ( html: string | undefined, url: string ) => ( { body: Buffer.from( html ?? 'Not found' ), status: html ? 200 : 404, finalUrl: url, headers: new Headers( { 'content-type': 'text/html' } ) } );

describe( 'Ameba Ownd detection', () => {
	it( 'claims amebaownd.com sites by hostname', async () => {
		expect( ( await detect( `${ ORIGIN }/` ) ).platform ).toBe( 'ameba-ownd' );
		expect( findAdapter( 'ameba-ownd' ) ).toBe( adapter );
	} );

	it( 'recognizes a custom-domain Ameba Ownd document ahead of generic Next.js', () => {
		const result = detectFromDocument( 'https://www.example.jp/', new Headers(), postHtml );
		expect( result.platform ).toBe( 'ameba-ownd' );
		expect( result.signals ).toEqual( [ 'Ameba Ownd app deep link meta tag', 'Ameba Ownd frontend stylesheet' ] );
	} );

	it( 'leaves other Next.js documents to the Next.js adapter', () => {
		const html = '<html><head><meta name="twitter:app:url:iphone" content="otherapp://sites/1"/><script src="/_next/static/chunks/main.js"></script></head><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>';
		expect( detectFromDocument( 'https://www.example.jp/', new Headers(), html ).platform ).toBe( 'nextjs' );
	} );
} );

describe( 'Ameba Ownd routes', () => {
	it.each( [
		[ '/', 'homepage' ],
		[ '/posts/6199504', 'post' ],
		[ '/posts/categories/2101016', 'term-archive' ],
		[ '/posts/category/2101016', 'term-archive' ],
		[ '/posts/categories/2101016/page/2', 'listing' ],
		[ '/posts/archives/2019/05', 'date-archive' ],
		[ '/posts/archives/2019/05/page/2', 'listing' ],
		[ '/pages/2748388/profile', 'page' ],
	] )( 'types %s as %s', ( path, kind ) => {
		expect( amebaRouteKind( `${ ORIGIN }${ path }` ) ).toBe( kind );
	} );

	it( 'scopes out blog list pagination and keyword search, keeping archives and their pages', () => {
		const scope = adapter.routeScope!( ORIGIN );
		for ( const path of [ '/posts/page/1', '/posts/page/2?type=list', '/search/q/test' ] ) expect( routeInScope( `${ ORIGIN }${ path }`, scope ) ).toBe( false );
		for ( const path of [ '/', '/posts/6199504', '/posts/categories/2101016', '/posts/categories/2101016/page/2', '/posts/archives/2019/05', '/pages/2748388/profile' ] ) {
			expect( routeInScope( `${ ORIGIN }${ path }`, scope ) ).toBe( true );
		}
	} );

	it( 'declares one template per shared platform route and per authored page', () => {
		const identity = adapter.templateIdentity!;
		expect( identity( postHtml, `${ ORIGIN }/posts/6199504` ) ).toBe( 'ameba-ownd:blog_post_detail' );
		expect( identity( document( nextData( 'category' ) ), `${ ORIGIN }/posts/categories/2101016` ) ).toBe( 'ameba-ownd:blog_post_category' );
		expect( identity( document( nextData( 'archive' ) ), `${ ORIGIN }/posts/archives/2019/05` ) ).toBe( 'ameba-ownd:blog_post_archive' );
		expect( identity( document( nextData( 'page' ) ), `${ ORIGIN }/pages/2748388/profile` ) ).toBe( 'ameba-ownd:static:/pages/2748388/profile' );
		expect( identity( '<html><body>Other</body></html>', `${ ORIGIN }/` ) ).toBeUndefined();
	} );

	it( 'types sitemap routes during discovery', async () => {
		const server = createServer( ( request, reply ) => {
			const base = `http://${ request.headers.host }`;
			if ( request.url === '/sitemap.xml' ) {
				reply.setHeader( 'content-type', 'application/xml' );
				reply.end( `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ [ '', '/pages/2748388/profile', '/posts/6199504', '/posts/categories/2101016', '/posts/archives/2019/05' ].map( path => `<url><loc>${ base }${ path }</loc></url>` ).join( '' ) }</urlset>` );
				return;
			}
			reply.statusCode = request.url === '/' ? 200 : 404;
			reply.setHeader( 'content-type', 'text/html' );
			reply.end( request.url === '/' ? '<html><body><a href="/posts/6199504">Post</a><a href="/posts/page/2">Next</a></body></html>' : '' );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		try {
			const base = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
			const inventory = await discover( `${ base }/`, {} );
			const types = Object.fromEntries( inventory.urls.map( entry => [ new URL( entry.url ).pathname, entry.type ] ) );
			expect( types ).toMatchObject( { '/': 'homepage', '/posts/6199504': 'post', '/posts/categories/2101016': 'term-archive', '/posts/archives/2019/05': 'date-archive', '/pages/2748388/profile': 'page' } );
		} finally {
			await new Promise< void >( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		}
	} );
} );

describe( 'Ameba Ownd page state', () => {
	it( 'reads the route, post, list, category and static page the server rendered', () => {
		const post = amebaNextState( postHtml )!;
		expect( post ).toMatchObject( { routeType: 'blog_post_detail', params: { blog_post_id: '6199504' }, postDetail: { id: '6199504', title: '外から見るとわからないかも…', publishedAt: '2019-05-08T18:42:03Z' } } );
		expect( post.postDetail!.blogCategories ).toEqual( [ { id: '1924869', label: 'お知らせ', publishedCount: 254 } ] );
		expect( amebaNextState( document( nextData( 'list' ) ) )!.postList ).toMatchObject( { total: 937, limit: 12 } );
		expect( amebaNextState( document( nextData( 'category' ) ) )!.category ).toEqual( { id: '2101016', label: '北辰テスト・公立入試関連' } );
		expect( amebaNextState( document( nextData( 'page' ) ) )!.page ).toMatchObject( { id: '2748388', type: 'static', title: '卒塾生の声', urlPath: 'profile' } );
		expect( amebaNextState( '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>' ) ).toBeUndefined();
	} );
} );

describe( 'Ameba Ownd structured content', () => {
	it( 'expresses platform UTC times in the site\'s Japan time, whatever the host zone', () => {
		expect( amebaLocalTimestamp( '2019-05-08T18:42:03Z' ) ).toBe( '2019-05-09T03:42:03+09:00' );
		// Late on 31 August UTC is already September on the site and in its month archive.
		expect( amebaLocalTimestamp( '2026-08-31T21:23:05Z' ) ).toBe( '2026-09-01T06:23:05+09:00' );
		expect( amebaLocalTimestamp( '0001-01-01T00:00:00Z' ) ).toBe( '' );
		expect( amebaLocalTimestamp( 'not a date' ) ).toBe( '' );
		// The article shows exactly this text for its publication time.
		expect( amebaDisplayDate( '2019-05-08T18:42:03Z' ) ).toBe( '2019.05.09 03:42' );
		expect( cheerio.load( postHtml )( 'time.blog-article__date' ).text() ).toBe( '2019.05.09 03:42' );
	} );

	it( 'maps a post to a post entry with its numeric slug, categories as terms and featured image', () => {
		const [ first, second ] = listPosts();
		expect( amebaPostEntry( first as never, ORIGIN ) ).toMatchObject( {
			permalink: `${ ORIGIN }/posts/59201354`, slug: '59201354', kind: 'post', title: 'やはり厳しいようだ',
			published: '2026-09-05T02:09:47+09:00', updated: '2026-09-16T04:05:21+09:00', author: 'Site owner', terms: [ '授業関連', '日々雑感' ],
		} );
		expect( amebaPostEntry( second as never, ORIGIN )!.published ).toBe( '2026-09-01T06:23:05+09:00' );
		const image = 'https://cdn.amebaowndme.com/madrid-prd/madrid-web/images/sites/662697/0b6bed695d6cffb76b01bbdafd20f462_b292c0c956778d56b1e9a9e5c327bdb2.png';
		const withImage = { ...first, contents: [ ...( first!.contents as unknown[] ), { type: 'image', fit: true, url: image, link: '', width: 1932, height: 1220 } ] };
		const entry = amebaPostEntry( withImage as never, ORIGIN )!;
		expect( entry.image ).toBe( image );
		expect( cheerio.load( entry.contentHtml )( 'img' ).attr( 'src' ) ).toBe( image );
		expect( amebaPostEntry( { ...first, ogpImageUrl: 'https://cdn.example/ogp.png' } as never, ORIGIN )!.image ).toBe( 'https://cdn.example/ogp.png' );
		expect( amebaPostEntry( { ...first, status: 'draft' } as never, ORIGIN ) ).toBeUndefined();
		expect( amebaPostEntry( { ...first, publishedAt: '0001-01-01T00:00:00Z' } as never, ORIGIN ) ).toBeUndefined();
		// Ameba publishes untitled posts; they are still posts.
		expect( amebaPostEntry( { ...first, title: '' } as never, ORIGIN ) ).toMatchObject( { kind: 'post', slug: '59201354', title: '' } );
	} );

	it( 'enumerates every list page from the declared total, plus static pages from the inventory', async () => {
		const posts = listPosts();
		const pages: Record< string, string > = {
			[ `${ ORIGIN }/posts/page/1` ]: listPage( posts.slice( 0, 2 ), 3, 2 ),
			[ `${ ORIGIN }/posts/page/2` ]: listPage( posts.slice( 2 ), 3, 2 ),
			[ `${ ORIGIN }/pages/2748388/profile` ]: document( nextData( 'page' ) ),
		};
		const fetch = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => response( pages[ String( url ) ], String( url ) ) );
		try {
			const inventory = { urls: [ { url: `${ ORIGIN }/` }, { url: `${ ORIGIN }/pages/2748388/profile` }, { url: `${ ORIGIN }/posts/59201354` } ] };
			const result = await enumerateAmebaContent( `${ ORIGIN }/`, { governors: new SourceRequestGovernors(), inventory } );
			expect( fetch ).toHaveBeenCalledTimes( 3 );
			expect( result.diagnostics ).toEqual( [] );
			expect( result.entries.map( entry => [ entry.kind, entry.slug ] ) ).toEqual( [ [ 'post', '59201354' ], [ 'post', '59187999' ], [ 'post', '59177220' ], [ 'page', 'profile' ] ] );
			expect( result.entries[ 3 ] ).toMatchObject( { title: '卒塾生の声', published: '2019-04-03T22:50:22+09:00', updated: '2026-04-11T04:10:22+09:00' } );

			// Categories are term archives at their numeric route; month archives and pagination are not terms.
			expect( amebaStructuredContent.termName( `${ ORIGIN }/posts/categories/1924869` ) ).toBe( 'お知らせ' );
			expect( amebaStructuredContent.termArchiveUrl( 'お知らせ', ORIGIN ) ).toBe( `${ ORIGIN }/posts/categories/1924869` );
			for ( const path of [ '/posts/categories/1924869/page/2', '/posts/archives/2026/09', '/posts/categories/999' ] ) expect( amebaStructuredContent.termName( `${ ORIGIN }${ path }` ) ).toBeUndefined();

			const index = structuredContentIndex( result.entries, [
				{ url: `${ ORIGIN }/posts/59201354`, path: 'website/posts/59201354.html' },
				{ url: `${ ORIGIN }/pages/2748388/profile`, path: 'website/pages/2748388/profile.html' },
				{ url: `${ ORIGIN }/posts/categories/1924869`, path: 'website/posts/categories/1924869.html' },
				{ url: `${ ORIGIN }/posts/archives/2026/09`, path: 'website/posts/archives/2026/09.html' },
			], amebaStructuredContent, ORIGIN );
			expect( index.posts.map( post => [ post.kind, post.slug, post.published, post.path ] ) ).toEqual( [
				[ 'post', '59201354', '2026-09-05T02:09:47+09:00', '/posts/59201354.html' ],
				[ 'page', 'profile', '2019-04-03T22:50:22+09:00', '/pages/2748388/profile.html' ],
			] );
			expect( index.terms.find( term => term.name === 'お知らせ' ) ).toEqual( { name: 'お知らせ', kind: 'term-archive', sourceUrl: `${ ORIGIN }/posts/categories/1924869`, path: '/posts/categories/1924869.html' } );
			expect( index.terms.map( term => term.sourceUrl ).some( url => url.includes( '/archives/' ) ) ).toBe( false );
		} finally {
			fetch.mockRestore();
		}
	} );

	it( 'reports an unavailable post list instead of inventing entries', async () => {
		const fetch = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => response( undefined, String( url ) ) );
		try {
			const result = await enumerateAmebaContent( `${ ORIGIN }/`, { governors: new SourceRequestGovernors() } );
			expect( result.entries ).toEqual( [] );
			expect( result.diagnostics ).toEqual( [ { code: 'ameba_post_list_failed', url: `${ ORIGIN }/posts/page/1`, reason: 'List page unavailable' } ] );
		} finally {
			fetch.mockRestore();
		}
	} );

	it( 'proves the article body against the post blocks and derives text-only members', () => {
		const representative = amebaPostEntry( amebaNextState( postHtml )!.postDetail!, ORIGIN )!;
		expect( amebaBodyEquivalent( postHtml, representative ) ).toBe( true );
		expect( amebaBodyEquivalent( postHtml, { ...representative, contentHtml: '<p>Summary</p>' } ) ).toBe( false );

		const member = amebaPostEntry( listPosts()[ 1 ] as never, ORIGIN )!;
		const $ = cheerio.load( amebaMemberDocument( postHtml, representative, member )! );
		expect( amebaBodyEquivalent( $.html(), member ) ).toBe( true );
		expect( $( 'h1.blog-title__text' ).text() ).toBe( '何とかなりそうな感じもする' );
		expect( $( 'time.blog-article__date' ).attr( 'datetime' ) ).toBe( '2026-08-31T21:23:05Z' );
		expect( $( 'time.blog-article__date' ).text() ).toBe( '2026.09.01 06:23' );
		expect( $( '.bloginfo-category-list a' ).toArray().map( node => [ $( node ).attr( 'href' ), $( node ).text() ] ) ).toEqual( [
			[ '/posts/categories/2002410', '授業関連(575)' ], [ '/posts/categories/1950096', '日々雑感(634)' ],
		] );
		expect( $( 'title' ).text() ).toBe( '何とかなりそうな感じもする | 蒼進塾（そうしんじゅく）～さいたま市～真剣に努力する姿勢を育む' );
		expect( $( 'link[rel="canonical"]' ).attr( 'href' ) ).toBe( `${ ORIGIN }/posts/59187999/` );
		expect( $( 'meta[name="twitter:app:url:iphone"]' ).attr( 'content' ) ).toBe( 'amebaownd://public/sites/662697/posts/59187999' );
		expect( $( 'meta[property="og:description"]' ).length ).toBe( 0 );

		const withImage = { ...listPosts()[ 1 ], contents: [ { type: 'image', url: 'https://cdn.example/a.png' } ] };
		expect( amebaMemberDocument( postHtml, representative, amebaPostEntry( withImage as never, ORIGIN )! ) ).toBeUndefined();
		expect( amebaMemberDocument( postHtml, representative, amebaPostEntry( { ...listPosts()[ 1 ], title: '' } as never, ORIGIN )! ) ).toBeUndefined();
	} );
} );

describe( 'Ameba Ownd HTTP acquisition', () => {
	it( 'keeps the server-rendered article, removes runtime scripts and state, and declares runtime widgets', () => {
		const prepared = prepareAmebaDocument( postHtml.replace( '</body>', '<div class="block-type--postsCategory"></div><script>window.x=1</script></body>' ), { url: `${ ORIGIN }/posts/6199504`, finalUrl: `${ ORIGIN }/posts/6199504`, variant: 'desktop' } )!;
		const $ = cheerio.load( prepared.html );
		expect( $( 'script' ).length ).toBe( 0 );
		expect( $( '.blog-article__body' ).text() ).toContain( 'のぼりと横断幕の到着が大幅に遅れています。' );
		expect( prepared.metadata ).toMatchObject( { kind: 'post', route: 'blog_post_detail', document: 'ameba-ownd-server-rendered' } );
		expect( prepared.browserRegions?.map( region => region.selector ) ).toEqual( [ '.block-type--postsCategory' ] );
		expect( adapter.acquisition!.variants.map( variant => variant.id ) ).toEqual( [ 'desktop' ] );
	} );

	it( 'reveals the measured global navigation and leaves other documents to the browser', () => {
		const html = document( nextData( 'category' ), '<nav class="header__nav global-nav js-nav-overflow-criterion is-invisible"><a href="/">Home</a></nav><div role="main"><h2>北辰テスト</h2></div>' );
		const prepared = prepareAmebaDocument( html, { url: `${ ORIGIN }/posts/categories/2101016`, finalUrl: `${ ORIGIN }/posts/categories/2101016`, variant: 'desktop' } )!;
		expect( cheerio.load( prepared.html )( '.global-nav' ).hasClass( 'is-invisible' ) ).toBe( false );
		expect( prepared.metadata?.kind ).toBe( 'term-archive' );
		const context = { url: `${ ORIGIN }/`, finalUrl: `${ ORIGIN }/`, variant: 'desktop' };
		expect( prepareAmebaDocument( '<html><body><div role="main">Other site</div></body></html>', context ) ).toBeUndefined();
		expect( prepareAmebaDocument( document( nextData( 'category' ), '<div role="main"></div>' ), context ) ).toBeUndefined();
	} );
} );

describe( 'Ameba Ownd captured documents', () => {
	it( 'restores the site-time date labels a browser elsewhere rewrote in its own zone', () => {
		// As a capture in US Eastern time recorded the article and its sidebar.
		const captured = '<time class="blog-article__date u-txt-clr" datetime="2019-05-08T18:42:03Z" data-blocks-engine-node-id="n1">2019.05.08 14:42</time><time class="" datetime="2026-08-31T21:23:05Z">2026.08.31 17:23</time><time datetime="2026-08-31">August</time>';
		const $ = cheerio.load( canonicalizeAmebaHtml( captured ) );
		expect( $( 'time' ).toArray().map( node => $( node ).text() ) ).toEqual( [ '2019.05.09 03:42', '2026.09.01 06:23', 'August' ] );
		expect( canonicalizeAmebaHtml( '<p>No dates</p>' ) ).toBe( '<p>No dates</p>' );
	} );

	it( 'gives the server document the mounted page\'s element path', () => {
		const $ = cheerio.load( canonicalizeAmebaHtml( postHtml ) );
		expect( $( '#__next' ).length ).toBe( 0 );
		expect( $( '#content > .page h1.blog-title__text' ).text() ).toBe( '外から見るとわからないかも…' );
		expect( $( 'time.blog-article__date' ).text() ).toBe( '2019.05.09 03:42' );
	} );

	it( 'removes the per-visitor related posts widget before capture', () => {
		expect( adapter.liberation?.cleanupRules?.map( rule => [ rule.id, rule.category, rule.selector ] ) ).toEqual( [ [ 'ameba-ownd-related-posts', 'provider-service', '.complementary--relatedPosts' ] ] );
		expect( adapter.liberation?.canonicalizeHtml ).toBe( canonicalizeAmebaHtml );
	} );
} );
