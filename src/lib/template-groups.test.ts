import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE_LIMIT, selectRouteBudget, spreadSample } from './route-budget.js';
import type { SafeFetchResult } from './media-fetch/safe-fetch.js';
import {
	buildTemplateGroups,
	progressiveOrder,
	templateFingerprint,
	templateRepresentatives,
	templateSelectionCoverage,
	TEMPLATE_GROUPS_SCHEMA,
} from './template-groups.js';
import { SourceRequestGovernors } from './source-request-governor.js';

/*
 * A synthetic multi-template CMS site, served from memory. Templates: home,
 * page, page with FAQ, contact page (form), landing page (page-local CSS),
 * post, blog listing, category archive, tag archive, author archive, shop,
 * product. Four posts diverge on purpose: tabs, page-local CSS, a form and an
 * embed. Discovery order is sitemap-like: pages, posts, archives, shop.
 */
const ORIGIN = 'https://fixture.example';
const NAV = [ '/', '/about/', '/services/', '/blog/', '/shop/', '/contact/' ];
const DIVERGENT_POSTS: Record< number, string > = { 37: 'tabs', 111: 'local-style', 205: 'form', 260: 'embed' };

function shell( title: string, bodyClass: string, main: string, head = '' ): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ title } | Fixture</title><link rel="stylesheet" href="/site.css?ver=3">${ head }</head>
<body class="${ bodyClass }"><header class="site-header"><a class="brand" href="/">Fixture</a>
<button class="menu-toggle" aria-expanded="false" aria-controls="nav">Menu</button>
<nav id="nav" class="primary-nav"><ul>${ NAV.map( href => `<li class="menu-item${ href === '/' ? ' current-menu-item' : '' }"><a href="${ href }">${ href }</a></li>` ).join( '' ) }</ul></nav></header>
${ main }
<footer class="site-footer"><p>&copy; Fixture</p></footer><script src="/site.js?ver=3"></script></body></html>`;
}

const paragraphs = ( count: number, seed: number ) => Array.from( { length: count }, ( _, index ) => `<p>Paragraph ${ index } of ${ seed }. ${ 'Lorem ipsum. '.repeat( 1 + ( ( seed + index ) % 6 ) ) }</p>` ).join( '' );

function post( n: number ): string {
	const kind = DIVERGENT_POSTS[ n ];
	const extra = kind === 'tabs' ? '<div role="tablist"><button role="tab" aria-controls="t1">One</button></div><div id="t1" role="tabpanel">One</div>'
		: kind === 'form' ? '<form class="newsletter" action="/subscribe" method="post"><input type="email" name="email"><button>Subscribe</button></form>'
		: kind === 'embed' ? '<iframe src="https://video.example/embed/1" title="video"></iframe>' : '';
	const figures = Array.from( { length: n % 4 === 0 ? 3 : 1 }, ( _, index ) => `<figure class="wp-block-image"><img class="wp-image-${ n * 10 + index }" src="/img/${ n }-${ index }.png" alt=""><figcaption>Figure</figcaption></figure>` ).join( '' );
	return shell( `Post ${ n }`, `single single-post postid-${ n }`, `<main class="site-main"><article class="post post-${ n }">
<h1 class="entry-title">Post ${ n }${ ' word'.repeat( n % 5 ) }</h1><p class="entry-meta"><time datetime="2026-01-01">Jan 1</time></p>
<div class="entry-content">${ paragraphs( 3 + ( n % 8 ), n ) }${ figures }${ extra }</div></article>
<aside class="related"><ul>${ [ 1, 2, 3 ].map( index => `<li><a href="/blog/post-${ ( n + index ) % 300 }/">Related</a></li>` ).join( '' ) }</ul></aside></main>`, kind === 'local-style' ? '<style>.entry-content{columns:2}</style>' : '' );
}

function page( slug: string, variant: 'plain' | 'faq' | 'form' | 'landing' = 'plain' ): string {
	const faq = variant === 'faq' ? `<section class="faq">${ [ 1, 2 ].map( index => `<button aria-expanded="false" aria-controls="q${ index }">Q${ index }</button><div id="q${ index }" class="panel" hidden>A</div>` ).join( '' ) }</section>` : '';
	const form = variant === 'form' ? '<form class="contact-form" method="post" action="/contact/"><input name="name"><textarea name="message"></textarea><button>Send</button></form>' : '';
	return shell( slug, `page page-id-${ slug.length } page-template-default`, `<main class="site-main"><article class="page"><h1 class="entry-title">${ slug }</h1>
<div class="entry-content">${ paragraphs( 2 + slug.length % 4, slug.length ) }${ faq }${ form }</div></article></main>`, variant === 'landing' ? '<style>.entry-content{display:grid}</style>' : '' );
}

function listing( title: string, bodyClass: string, posts: number[] ): string {
	return shell( title, bodyClass, `<main class="site-main"><h1 class="archive-title">${ title }</h1><div class="post-grid">${ posts.map( n => `<article class="card"><img src="/img/${ n }-0.png" alt=""><h2><a href="/blog/post-${ n }/">Post ${ n }</a></h2><p class="excerpt">Excerpt</p></article>` ).join( '' ) }</div>
<nav class="pagination"><a href="/blog/page/2/">2</a></nav></main>` );
}

const range = ( from: number, to: number ) => Array.from( { length: to - from + 1 }, ( _, index ) => from + index );

const routes: Array< [ string, () => string ] > = [
	[ '/', () => shell( 'Home', 'home page-template-front', '<main class="site-main home"><section class="hero"><h1>Welcome</h1></section><section class="post-grid"><article class="card"><h2>Card</h2></article></section></main>' ) ],
	...[ 'about', 'services', 'team', 'careers', 'privacy', 'terms' ].map( slug => [ `/${ slug }/`, () => page( slug ) ] as [ string, () => string ] ),
	[ '/faq/', () => page( 'faq', 'faq' ) ],
	[ '/support/', () => page( 'support', 'faq' ) ],
	[ '/contact/', () => page( 'contact', 'form' ) ],
	[ '/landing/', () => page( 'landing', 'landing' ) ],
	...range( 1, 300 ).map( n => [ `/blog/post-${ n }/`, () => post( n ) ] as [ string, () => string ] ),
	[ '/blog/', () => listing( 'Blog', 'blog', range( 1, 10 ) ) ],
	...range( 2, 20 ).map( n => [ `/blog/page/${ n }/`, () => listing( `Blog page ${ n }`, 'blog paged', range( n * 10, n * 10 + 9 ) ) ] as [ string, () => string ] ),
	...range( 1, 10 ).map( n => [ `/category/c${ n }/`, () => listing( `Category ${ n }`, 'archive category', range( n, n + 5 ) ) ] as [ string, () => string ] ),
	...range( 1, 30 ).map( n => [ `/tag/t${ n }/`, () => listing( `Tag ${ n }`, 'archive tag', range( n, n + 3 ) ) ] as [ string, () => string ] ),
	...range( 1, 5 ).map( n => [ `/author/a${ n }/`, () => shell( `Author ${ n }`, 'archive author', `<main class="site-main"><section class="author-bio"><img class="avatar" src="/a.png" alt=""><h1>Author</h1></section><div class="post-grid"><article class="card"><h2>Post</h2></article></div></main>` ) ] as [ string, () => string ] ),
	[ '/shop/', () => shell( 'Shop', 'shop archive', '<main class="site-main"><ul class="products"><li class="product"><a href="/shop/product-1/">P</a><span class="price">$1</span></li></ul></main>' ) ],
	...range( 1, 40 ).map( n => [ `/shop/product-${ n }/`, () => shell( `Product ${ n }`, 'single-product', `<main class="site-main"><div class="product-gallery"><img src="/p${ n }.png" alt=""></div><div class="summary"><h1 class="product-title">P${ n }</h1><p class="price">$${ n }</p><button class="add-to-cart">Add</button></div><div class="product-description">${ paragraphs( 1 + n % 3, n ) }</div></main>` ) ] as [ string, () => string ] ),
];
const PAGES = new Map( routes.map( ( [ path, render ] ) => [ `${ ORIGIN }${ path }`, render ] ) );
const INVENTORY = routes.map( ( [ path ] ) => `${ ORIGIN }${ path }` );
/**
 * Template groups by construction: 13 templates (the paged blog listing carries
 * a `paged` body class, so it is its own template) plus 4 divergent posts.
 */
const EXPECTED_GROUPS = 17;

const response = ( url: string, status: number, body: string, contentType = 'text/html; charset=utf-8', finalUrl = url ): SafeFetchResult =>
	( { finalUrl, status, headers: new Headers( { 'content-type': contentType } ), body: Buffer.from( body ) } );

function fixtureFetch( options: { delay?: ( url: string ) => number } = {} ) {
	const requested: string[] = [];
	const fetch = async ( url: string ): Promise< SafeFetchResult > => {
		requested.push( url );
		if ( options.delay ) await new Promise( resolve => setTimeout( resolve, options.delay!( url ) ) );
		const render = PAGES.get( url );
		return render ? response( url, 200, render() ) : response( url, 404, 'Not found' );
	};
	return { fetch: fetch as unknown as typeof import('./media-fetch/safe-fetch.js').safeFetch, requested };
}

const fingerprint = ( path: string ) => templateFingerprint( PAGES.get( `${ ORIGIN }${ path }` )!(), `${ ORIGIN }${ path }` );

describe( 'templateFingerprint', () => {
	it( 'groups pages of one template regardless of text, content counts and per-page classes', () => {
		// 3 vs 10 paragraphs, 1 vs 3 figures, different titles, postid-N, wp-image-N.
		const key = fingerprint( '/blog/post-1/' ).key;
		for ( const path of [ '/blog/post-2/', '/blog/post-4/', '/blog/post-7/', '/blog/post-300/' ] ) expect( fingerprint( path ).key ).toBe( key );
		expect( fingerprint( '/about/' ).key ).toBe( fingerprint( '/terms/' ).key );
		expect( fingerprint( '/shop/product-1/' ).key ).toBe( fingerprint( '/shop/product-2/' ).key );
	} );

	it( 'ignores text and volatile class tokens but not stable ones', () => {
		const html = ( text: string, classes: string ) => `<html><body class="${ classes }"><main><p>${ text }</p></main></body></html>`;
		const base = templateFingerprint( html( 'One', 'single postid-1 current-menu-item is-active css-1x2y' ), ORIGIN ).key;
		expect( templateFingerprint( html( 'Two entirely different words', 'single postid-99' ), ORIGIN ).key ).toBe( base );
		expect( templateFingerprint( html( 'One', 'page' ), ORIGIN ).key ).not.toBe( base );
	} );

	it( 'separates pages with tabs, a form, page-local CSS or an embed from their template', () => {
		const template = fingerprint( '/blog/post-1/' );
		const divergent = Object.keys( DIVERGENT_POSTS ).map( n => fingerprint( `/blog/post-${ n }/` ) );
		expect( new Set( [ template.key, ...divergent.map( item => item.key ) ] ).size ).toBe( 5 );
		// Page-local CSS changes no structure: only the divergence fingerprint catches it.
		const localStyle = fingerprint( '/blog/post-111/' );
		expect( localStyle.skeleton ).toBe( template.skeleton );
		expect( localStyle.divergence.pageStyles ).not.toBeNull();
		expect( template.divergence.pageStyles ).toBeNull();
		expect( fingerprint( '/blog/post-37/' ).divergence.controls ).toEqual( expect.arrayContaining( [ 'tab:button[role=tab]', 'tab:div[role=tablist]' ] ) );
		expect( fingerprint( '/blog/post-205/' ).divergence.forms ).toEqual( [ 'form.newsletter' ] );
		expect( template.divergence.forms ).toEqual( [] );
		// The menu toggle is a control on every page; FAQ buttons add their own.
		expect( template.divergence.controls ).toEqual( [ 'disclosure:button.menu-toggle' ] );
		expect( fingerprint( '/blog/post-260/' ).divergence.embeds ).toEqual( [ 'iframe' ] );
		expect( fingerprint( '/contact/' ).key ).not.toBe( fingerprint( '/about/' ).key );
		expect( fingerprint( '/faq/' ).key ).toBe( fingerprint( '/support/' ).key );
		expect( fingerprint( '/faq/' ).key ).not.toBe( fingerprint( '/about/' ).key );
		expect( fingerprint( '/landing/' ).key ).not.toBe( fingerprint( '/about/' ).key );
	} );

	it( 'treats JSON script data as inert and resolves asset URLs against the page', () => {
		const html = ( head: string ) => `<html><head>${ head }</head><body><main></main></body></html>`;
		const plain = templateFingerprint( html( '<link rel="stylesheet" href="/a.css">' ), `${ ORIGIN }/x/` );
		expect( templateFingerprint( html( '<link rel="stylesheet" href="../a.css"><script type="application/ld+json">{"a":1}</script>' ), `${ ORIGIN }/x/` ).key ).toBe( plain.key );
		expect( templateFingerprint( html( '<link rel="stylesheet" href="/a.css"><script>var a = 1</script>' ), `${ ORIGIN }/x/` ).divergence.inlineScripts ).toBe( true );
	} );
} );

describe( 'buildTemplateGroups', () => {
	it( 'groups the fixture into its templates with the first member as representative', async () => {
		const report = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch() );
		expect( report.schema ).toBe( TEMPLATE_GROUPS_SCHEMA );
		expect( report.coverage ).toEqual( { routes: INVENTORY.length, fingerprinted: INVENTORY.length, unfingerprinted: 0, groups: EXPECTED_GROUPS, singletons: 9 } );
		expect( report.groups[ 0 ] ).toMatchObject( { id: 't1', representative: `${ ORIGIN }/`, size: 1 } );
		const posts = report.groups.find( group => group.representative === `${ ORIGIN }/blog/post-1/` )!;
		expect( posts.size ).toBe( 300 - 4 );
		for ( const n of Object.keys( DIVERGENT_POSTS ) ) expect( report.groups.find( group => group.members.includes( `${ ORIGIN }/blog/post-${ n }/` ) )!.size ).toBe( 1 );
		expect( report.groups.reduce( ( total, group ) => total + group.size, 0 ) ).toBe( INVENTORY.length );
	} );

	it( 'writes the same report whatever order responses arrive in', async () => {
		const first = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch() );
		const shuffled = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch( { delay: url => ( url.length * 7 ) % 5 } ) );
		expect( JSON.stringify( shuffled ) ).toBe( JSON.stringify( first ) );
	} );

	it( 'records why a route has no fingerprint and keeps it out of every group', async () => {
		const urls = [ `${ ORIGIN }/`, `${ ORIGIN }/missing/`, `${ ORIGIN }/feed/`, `${ ORIGIN }/moved/`, `${ ORIGIN }/broken/`, `${ ORIGIN }/about/` ];
		const fetch = async ( url: string ): Promise< SafeFetchResult > => {
			if ( url.endsWith( '/feed/' ) ) return response( url, 200, '<rss/>', 'application/rss+xml' );
			if ( url.endsWith( '/moved/' ) ) return response( url, 200, page( 'about' ), undefined, `${ ORIGIN }/about/` );
			if ( url.endsWith( '/broken/' ) ) throw new Error( 'connection reset' );
			const render = PAGES.get( url );
			return render ? response( url, 200, render() ) : response( url, 404, '' );
		};
		const report = await buildTemplateGroups( { sourceUrl: urls[ 0 ]!, urls }, { fetch: fetch as never } );
		expect( report.unfingerprinted ).toEqual( [
			{ url: `${ ORIGIN }/missing/`, reason: 'http_status', httpStatus: 404 },
			{ url: `${ ORIGIN }/feed/`, reason: 'not_html' },
			{ url: `${ ORIGIN }/moved/`, reason: 'redirected' },
			{ url: `${ ORIGIN }/broken/`, reason: 'fetch_failed' },
		] );
		expect( report.coverage ).toMatchObject( { routes: 6, fingerprinted: 2, unfingerprinted: 4, groups: 2 } );
	} );

	it( 'bounds the pass by route count, time and bytes, fetching an even spread first', async () => {
		const sampled = fixtureFetch();
		const byCount = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY, limits: { maxRoutes: 20 } }, sampled );
		expect( sampled.requested ).toHaveLength( 20 );
		expect( new Set( sampled.requested ) ).toEqual( new Set( spreadSample( INVENTORY, 20 ) ) );
		expect( byCount.unfingerprinted.filter( row => row.reason === 'not_sampled' ) ).toHaveLength( INVENTORY.length - 20 );

		const slow = fixtureFetch( { delay: () => 40 } );
		const byTime = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY, limits: { timeBudgetMs: 100, concurrency: 2 } }, slow );
		expect( byTime.coverage.fingerprinted ).toBeGreaterThan( 0 );
		expect( byTime.coverage.fingerprinted ).toBeLessThan( 20 );
		expect( byTime.unfingerprinted.every( row => row.reason === 'time_budget' ) ).toBe( true );
		// The first fetches spread over the inventory: entrypoint, middle, then quarters.
		const middle = INVENTORY.length >> 1;
		expect( slow.requested.slice( 0, 2 ) ).toEqual( [ INVENTORY[ 0 ], INVENTORY[ middle ] ] );

		const bytes = fixtureFetch();
		const byBytes = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY, limits: { maxTotalBytes: 1, concurrency: 1 } }, bytes );
		expect( bytes.requested ).toHaveLength( 1 );
		expect( byBytes.unfingerprinted.every( row => row.reason === 'byte_budget' ) ).toBe( true );
	} );
} );

describe( 'buildTemplateGroups whole-inventory coverage', () => {
	it( 'fingerprints every inventory route with maxRoutes: all, more than a numeric maxRoutes samples', async () => {
		const sampled = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY, limits: { maxRoutes: 20 } }, fixtureFetch() );
		const whole = fixtureFetch();
		const all = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY, limits: { maxRoutes: 'all' } }, whole );
		expect( sampled.coverage.fingerprinted ).toBe( 20 );
		expect( whole.requested ).toHaveLength( INVENTORY.length );
		expect( all.coverage ).toMatchObject( { fingerprinted: INVENTORY.length, unfingerprinted: 0, groups: EXPECTED_GROUPS } );
		expect( all.limits.maxRoutes ).toBe( 'all' );
	} );
} );

describe( 'buildTemplateGroups throttling', () => {
	it( 'paces itself against repeated throttling and still fingerprints every route', async () => {
		const urls = INVENTORY.slice( 0, 12 );
		const requested: string[] = [];
		let calls = 0;
		let throttled = 0;
		const fetch = async ( url: string ): Promise< SafeFetchResult > => {
			requested.push( url );
			calls++;
			// Requests 3, 4 and 5 (consecutive, including a retry) and every 7th after are refused.
			if ( ( calls >= 3 && calls <= 5 ) || calls % 7 === 0 ) {
				throttled++;
				return { ...response( url, 429, '' ), headers: new Headers( { 'retry-after': '0' } ) };
			}
			return response( url, 200, PAGES.get( url )!() );
		};
		const report = await buildTemplateGroups( { sourceUrl: urls[ 0 ]!, urls, limits: { concurrency: 3 } }, { fetch: fetch as never } );
		expect( throttled ).toBeGreaterThanOrEqual( 4 );
		expect( report.coverage.fingerprinted ).toBe( 12 );
		expect( report.unfingerprinted ).toEqual( [] );
		expect( report.throttle ).toEqual( { events: throttled } );
		expect( requested ).toHaveLength( 12 + throttled );
	} );

	it( 'keeps going when the retry succeeds', async () => {
		const urls = INVENTORY.slice( 0, 12 );
		let throttledOnce = false;
		const fetch = async ( url: string ): Promise< SafeFetchResult > => {
			await new Promise( resolve => setTimeout( resolve, 2 ) );
			if ( ! throttledOnce && url === urls[ 5 ] ) {
				throttledOnce = true;
				return { ...response( url, 503, '' ), headers: new Headers( { 'retry-after': '0' } ) };
			}
			return response( url, 200, PAGES.get( url )!() );
		};
		const report = await buildTemplateGroups( { sourceUrl: urls[ 0 ]!, urls, limits: { concurrency: 4 } }, { fetch: fetch as never } );
		expect( report.coverage.fingerprinted ).toBe( 12 );
		expect( report.throttle ).toEqual( { events: 1 } );
	} );

	it( 'leaves routes the deadline cut off during a throttle wait as time_budget', async () => {
		const urls = INVENTORY.slice( 0, 6 );
		const fetch = async ( url: string ): Promise< SafeFetchResult > => url === urls[ 0 ]
			? response( url, 200, PAGES.get( url )!() )
			: { ...response( url, 429, '' ), headers: new Headers( { 'retry-after': '30' } ) };
		const started = Date.now();
		const report = await buildTemplateGroups( { sourceUrl: urls[ 0 ]!, urls, limits: { concurrency: 1, timeBudgetMs: 100 } }, { fetch: fetch as never } );
		expect( Date.now() - started ).toBeLessThan( 2000 );
		expect( report.coverage.fingerprinted ).toBe( 1 );
		expect( report.unfingerprinted.every( row => row.reason === 'time_budget' ) ).toBe( true );
		expect( report.throttle ).toEqual( { events: 1 } );
	} );

	it( 'shares one governor with the rest of the capture', async () => {
		const governors = new SourceRequestGovernors();
		const urls = INVENTORY.slice( 0, 4 );
		let refused = false;
		const fetch = async ( url: string ): Promise< SafeFetchResult > => {
			if ( ! refused && url === urls[ 2 ] ) {
				refused = true;
				return { ...response( url, 429, '' ), headers: new Headers( { 'retry-after': '0' } ) };
			}
			return response( url, 200, PAGES.get( url )!() );
		};
		await buildTemplateGroups( { sourceUrl: urls[ 0 ]!, urls, governors }, { fetch: fetch as never } );
		expect( governors.forOrigin( ORIGIN ).throttleEvents ).toBe( 1 );
		expect( governors.forOrigin( `${ ORIGIN }/other/` ) ).toBe( governors.forOrigin( ORIGIN ) );
	} );
} );

describe( 'progressiveOrder', () => {
	it( 'visits every index once, entrypoint first, so every prefix is spread', () => {
		const order = progressiveOrder( 9 );
		expect( order ).toEqual( [ 0, 4, 2, 6, 1, 3, 5, 7, 8 ] );
		expect( progressiveOrder( 1 ) ).toEqual( [ 0 ] );
		expect( progressiveOrder( 0 ) ).toEqual( [] );
		expect( [ ...progressiveOrder( 1000 ) ].sort( ( a, b ) => a - b ) ).toEqual( Array.from( { length: 1000 }, ( _, index ) => index ) );
	} );
} );

describe( 'template-coverage route selection', () => {
	it( 'keeps one representative per group under the budget, entrypoint first, then the even spread', async () => {
		const report = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch() );
		const representatives = templateRepresentatives( report );
		const { selected, omitted } = selectRouteBudget( INVENTORY, 30, representatives );
		expect( selected ).toHaveLength( 30 );
		expect( selected[ 0 ] ).toBe( INVENTORY[ 0 ] );
		expect( new Set( selected ).size ).toBe( 30 );
		expect( selected.length + omitted.length ).toBe( INVENTORY.length );
		expect( templateSelectionCoverage( report, selected, 'template-coverage', 30 ) ).toMatchObject( { groupsRepresented: EXPECTED_GROUPS, groupsOmitted: [] } );
		// Representatives first (largest groups first), then fill.
		expect( selected.slice( 1, EXPECTED_GROUPS ) ).toEqual( representatives.filter( url => url !== INVENTORY[ 0 ] ) );
	} );

	it( 'prefers the largest groups when the budget is smaller than the group count', async () => {
		const report = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch() );
		const { selected } = selectRouteBudget( INVENTORY, 3, templateRepresentatives( report ) );
		expect( selected ).toEqual( [ `${ ORIGIN }/`, `${ ORIGIN }/blog/post-1/`, `${ ORIGIN }/shop/product-1/` ] );
	} );

	it( 'is the plain even spread without representatives, and keeps the whole inventory when it fits', () => {
		expect( selectRouteBudget( INVENTORY, 30 ).selected ).toEqual( spreadSample( INVENTORY, 30 ) );
		expect( selectRouteBudget( INVENTORY, 30, [] ).selected ).toEqual( spreadSample( INVENTORY, 30 ) );
		expect( selectRouteBudget( INVENTORY, undefined, [ INVENTORY.at( -1 )! ] ).selected ).toEqual( INVENTORY );
		// Unknown representatives are ignored.
		expect( selectRouteBudget( INVENTORY, 30, [ `${ ORIGIN }/not-in-inventory/` ] ).selected ).toEqual( spreadSample( INVENTORY, 30 ) );
	} );

	it( 'measures group coverage under the default budget: discovery order vs template coverage', async () => {
		const report = await buildTemplateGroups( { sourceUrl: INVENTORY[ 0 ]!, urls: INVENTORY }, fixtureFetch() );
		const discovery = templateSelectionCoverage( report, selectRouteBudget( INVENTORY, DEFAULT_ROUTE_LIMIT ).selected, 'discovery-order', DEFAULT_ROUTE_LIMIT );
		const coverage = templateSelectionCoverage( report, selectRouteBudget( INVENTORY, DEFAULT_ROUTE_LIMIT, templateRepresentatives( report ) ).selected, 'template-coverage', DEFAULT_ROUTE_LIMIT );
		process.stderr.write( `[template-groups fixture] ${ INVENTORY.length } routes, ${ report.groups.length } groups, budget ${ DEFAULT_ROUTE_LIMIT }: discovery-order ${ discovery.groupsRepresented }/${ report.groups.length } (missing ${ discovery.groupsOmitted.map( id => report.groups.find( group => group.id === id )!.representative.replace( ORIGIN, '' ) ).join( ' ' ) }), template-coverage ${ coverage.groupsRepresented }/${ report.groups.length }\n` );
		expect( coverage.groupsRepresented ).toBe( EXPECTED_GROUPS );
		expect( discovery.groupsRepresented ).toBeLessThan( EXPECTED_GROUPS );
	} );
} );
