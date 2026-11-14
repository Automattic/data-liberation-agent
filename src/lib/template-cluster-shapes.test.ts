//
// #1805: a template cluster whose structured-content members span several
// adapter-declared shapes derives one sub-cluster per shape. An outlier
// representative (many images, no single price) must not fail every member.
//
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shopifyStructuredContent, productMemberShape } from '../adapters/shopify/template-content.js';
import { shopifyTemplateIdentity } from '../adapters/shopify/template-identity.js';
import { captureWebsite } from './capture.js';
import { rankTemplateClusterRoutes } from './route-budget.js';
import { templateClusterRankingGroups, templateClusterUnits } from './template-groups.js';

describe( 'template cluster member-shape partition', () => {
	const urls = [ 'outlier', 'a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'odd', 'frontier' ].map( slug => `https://shop.example/products/${ slug }` );
	const shapes: Record< string, string > = { outlier: 'many', odd: 'odd', a1: 'a', a2: 'a', a3: 'a', b1: 'b', b2: 'b', b3: 'b' };
	const shapeOf = ( url: string ) => shapes[ url.split( '/' ).pop()! ];
	const group = { id: 't2', key: 'k', representative: urls[ 0 ]!, size: urls.length, members: urls };

	it( 'is unchanged without a declared shape or with one shape', () => {
		expect( templateClusterUnits( group ) ).toEqual( { units: [ group ], unclustered: [] } );
		expect( templateClusterUnits( group, url => url.includes( 'frontier' ) ? undefined : 'same' ) ).toEqual( { units: [ group ], unclustered: [] } );
	} );

	it( 'splits by shape, largest first, with a representative of each shape', () => {
		const { units, unclustered } = templateClusterUnits( group, shapeOf );
		expect( units ).toEqual( [
			{ id: 't2.1', key: 'k', parent: 't2', shape: 'a', representative: urls[ 1 ], size: 3, members: [ urls[ 1 ], urls[ 3 ], urls[ 5 ] ] },
			{ id: 't2.2', key: 'k', parent: 't2', shape: 'b', representative: urls[ 2 ], size: 3, members: [ urls[ 2 ], urls[ 4 ], urls[ 6 ] ] },
		] );
		expect( unclustered ).toEqual( [ urls[ 0 ], urls[ 7 ], urls[ 8 ] ] );
		// The group's representative keeps its role inside its own shape.
		expect( templateClusterUnits( { ...group, representative: urls[ 5 ]! }, shapeOf ).units[ 0 ]!.representative ).toBe( urls[ 5 ] );
	} );

	it( 'seeds every sub-cluster representative and verifier ahead of derivable members', () => {
		const ranked = rankTemplateClusterRoutes( [ 'https://shop.example/', ...urls ], 'https://shop.example/', templateClusterRankingGroups( [ { ...group, skeleton: '', divergence: {} as never } ], shapeOf ), new Set() );
		const at = ( slug: string ) => ranked.indexOf( `https://shop.example/products/${ slug }` );
		for ( const seed of [ 'a1', 'a2', 'b1', 'b2' ] ) expect( at( seed ) ).toBeLessThan( at( 'outlier' ) );
		// Unclustered members are templates nothing derives: ahead of derivable members.
		for ( const member of [ 'outlier', 'odd' ] ) expect( at( member ) ).toBeLessThan( at( 'a3' ) );
	} );

	it( 'declares Shopify gallery cardinality and price shape', () => {
		const entry = { permalink: 'https://shop.example/products/a1', slug: 'a1', kind: 'page' as const, title: 'A1', contentHtml: '<p>A1</p>', published: '', updated: '', author: '', terms: [] };
		expect( shopifyStructuredContent.memberShape ).toBe( productMemberShape );
		expect( productMemberShape( { ...entry, images: [ 'x', 'y', 'z' ], price: '10.00' } as never ) ).toBe( 'images=3;price=single' );
		expect( productMemberShape( { ...entry, images: [ 'x', 'y', 'z' ] } as never ) ).toBe( 'images=3;price=none' );
	} );
} );

// A neutral Shopify-like storefront: the first product in the catalog is a
// variant product with 22 images and no single price; the rest are 3- and
// 4-image products with one price. Product pages carry runtime handlers in
// their gallery, so the gallery is never derivable through raw server HTML:
// only the structured-content path can derive a member.
const PNG = Buffer.from( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64' );
const products = [
	{ handle: 'outlier', images: 22, prices: [ '5.00', '7.00' ] },
	...[ 1, 2, 3, 4 ].map( i => ( { handle: `three-${ i }`, images: 3, prices: [ `1${ i }.00` ] } ) ),
	...[ 1, 2, 3, 4 ].map( i => ( { handle: `four-${ i }`, images: 4, prices: [ `2${ i }.00` ] } ) ),
];
let server: Server;
let origin = '';
const title = ( handle: string ) => `Product ${ handle }`;
const description = ( handle: string ) => `<p>Neutral description of ${ handle }.</p>`;
const image = ( handle: string, i: number ) => `${ origin }/img/${ handle }-${ i }.png`;
const productPage = ( product: typeof products[ number ] ) => `<!doctype html><html><head><title>${ title( product.handle ) } — Fixture store</title><style>body{margin:0;font:14px system-ui}.product__media{display:flex}</style></head>
<body class="template-product"><header class="site-header"><a href="/">Fixture store</a></header>
<main><section class="product" id="ProductInfo-main">
<div class="product__media">${ Array.from( { length: product.images }, ( _, i ) => `<div class="product__media-item"><img src="${ image( product.handle, i ) }" alt="${ title( product.handle ) }"><button type="button" onclick="this.parentNode.classList.toggle('zoom')">Zoom</button></div>` ).join( '' ) }</div>
<div class="product__info"><h1 class="product__title">${ title( product.handle ) }</h1>
<span class="price-item--regular">${ product.prices.length === 1 ? `$${ product.prices[ 0 ] }` : `From $${ product.prices[ 0 ] }` }</span>
<div class="product__description">${ description( product.handle ) }</div></div>
</section></main><footer class="site-footer"><p>(c) Fixture</p></footer></body></html>`;

beforeAll( async () => {
	server = createServer( ( request, response ) => {
		const url = new URL( request.url ?? '/', origin );
		const json = ( value: unknown ) => { response.setHeader( 'Content-Type', 'application/json' ); response.end( JSON.stringify( value ) ); };
		if ( url.pathname === '/products.json' ) return json( { products: url.searchParams.get( 'page' ) === '1' ? products.map( product => ( {
			handle: product.handle, title: title( product.handle ), body_html: description( product.handle ), vendor: 'Fixture', tags: [],
			published_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z',
			images: Array.from( { length: product.images }, ( _, i ) => ( { src: image( product.handle, i ) } ) ),
			variants: product.prices.map( price => ( { price } ) ),
		} ) ) : [] } );
		if ( url.pathname === '/collections.json' ) return json( { collections: [] } );
		if ( url.pathname.startsWith( '/img/' ) ) { response.setHeader( 'Content-Type', 'image/png' ); response.end( PNG ); return; }
		const product = products.find( product => url.pathname.replace( /\/$/, '' ) === `/products/${ product.handle }` );
		response.setHeader( 'Content-Type', 'text/html; charset=utf-8' );
		if ( product ) { response.end( productPage( product ) ); return; }
		if ( url.pathname === '/' ) { response.end( '<!doctype html><html><head><title>Fixture store</title></head><body><header class="site-header"><a href="/">Fixture store</a></header><main><h1>Welcome</h1></main></body></html>' ); return; }
		response.statusCode = 404; response.end( 'not found' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
} );
afterAll( async () => {
	server.closeAllConnections();
	await new Promise< void >( resolve => server.close( () => resolve() ) );
} );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'outlier template-cluster representative (#1805, real Chromium)', () => {
	it( 'derives each shape through the feed path and acquires the outlier normally', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'template-cluster-shapes-' ) );
		const url = `${ origin }/`;
		const product = ( handle: string ) => `${ origin }/products/${ handle }`;
		try {
			// Budget 6: the entrypoint, each shape's representative and verifier,
			// and the outlier; the other four products are left to derivation.
			const result = await captureWebsite( { url, outputDir, templateClusters: true, routeLimit: 6, learnFluid: false, trustedOrigins: [ url ] }, {
				findAdapter: () => ( {
					id: 'neutral-shop', detect: () => true, discover: async () => ( { urls: [] } ),
					structuredContent: shopifyStructuredContent, templateIdentity: shopifyTemplateIdentity,
				} ),
			} );
			const receipt = JSON.parse( readFileSync( join( outputDir, 'template-clusters.json' ), 'utf8' ) ) as { clusters: Array< { id: string; parent?: string; shape?: string; representative: string; subClusters?: Array< { shape: string; representative: string } >; derived: Array< { url: string } >; verification?: { equal?: boolean; checks?: Record< string, boolean > } } > };
			const derived = receipt.clusters.flatMap( cluster => cluster.derived.map( member => member.url ) ).sort();
			expect( derived ).toEqual( [ 'three-3', 'three-4', 'four-3', 'four-4' ].map( product ).sort() );
			expect( result.summary.routesDerived ).toBe( 4 );
			const partitioned = receipt.clusters.find( cluster => cluster.subClusters );
			expect( partitioned?.representative ).toBe( product( 'outlier' ) );
			expect( partitioned?.subClusters ).toEqual( [
				expect.objectContaining( { shape: 'images=3;price=single', representative: product( 'three-1' ) } ),
				expect.objectContaining( { shape: 'images=4;price=single', representative: product( 'four-1' ) } ),
			] );
			for ( const cluster of receipt.clusters.filter( cluster => cluster.parent ) ) {
				expect( cluster.verification ).toMatchObject( { equal: true, checks: { feedBody: true } } );
			}
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).entries as Record< string, { html?: string } >;
			const outlier = Object.entries( manifest ).find( ( [ key ] ) => key.replace( /\/$/, '' ) === product( 'outlier' ) )?.[ 1 ];
			expect( outlier?.html ).toBeTruthy();
			expect( outlier?.html ).not.toMatch( /derived|http\// );
			for ( const handle of [ 'three-3', 'four-4' ] ) {
				const page = join( outputDir, 'website', 'products', handle, 'index.html' );
				expect( existsSync( page ) ).toBe( true );
				expect( readFileSync( page, 'utf8' ) ).toContain( `Neutral description of ${ handle }.` );
			}
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 300_000 );
} );
