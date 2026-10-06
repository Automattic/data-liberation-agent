import { cleanupPolicy } from '../source-cleanup.js';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	canonicalRoutePath,
	checkFidelity as checkLiveFidelity,
	checkWidthsFor,
	evidenceSlug,
	externalRequestHost,
	receiptCoversSourceUrl,
	observePage,
	resolveCheckDirectory,
	routeSourceMap,
} from './check.js';
import type { LayoutObservation } from './score.js';
// This suite exercises the retained live drift diagnostic; frozen stages have real-browser coverage in reference.test.ts.
const checkFidelity = ( options: Parameters<typeof checkLiveFidelity>[0] ) => checkLiveFidelity( { ...options, stage: 'drift' } );

// Tests that launch a real browser skip — not fail — in checkouts without
// Playwright's Chromium (`npm install` does not download it; `npm run setup:browser` does).
const skipBrowserTests = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function liberatedRun(): string {
	const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
	dirs.push( dir );
	mkdirSync( join( dir, 'website' ), { recursive: true } );
	writeFileSync( join( dir, 'website', 'index.html' ), '<h1>Home</h1>' );
	writeFileSync(
		join( dir, 'capture-receipt.json' ),
		JSON.stringify( { source: { url: 'https://example.com/' }, websiteRoot: 'website' } )
	);
	return dir;
}

const obs = ( viewport: number, extra: Partial< LayoutObservation > = {} ): LayoutObservation => ( {
	viewport,
	title: 'Home',
	textChars: 10,
	widestImage: viewport,
	images: [],
	docWidth: viewport,
	overflow: false,
	externalHosts: [],
	hashTargets: [],
	internalRoutes: [],
	dialogs: [],
	...extra,
} );

describe( 'resolveCheckDirectory', () => {
	it( 'accepts the run directory printed by liberation', () => {
		const run = liberatedRun();
		expect( resolveCheckDirectory( run ).websiteDir ).toBe( join( run, 'website' ) );
	} );

	it( 'accepts the website directory itself', () => {
		const run = liberatedRun();
		expect( resolveCheckDirectory( join( run, 'website' ) ).receiptPath ).toBe(
			join( run, 'capture-receipt.json' )
		);
	} );

	it( 'rejects a directory with no receipt', () => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		expect( () => resolveCheckDirectory( dir ) ).toThrow( /capture-receipt/ );
	} );
} );

describe( 'canonicalRoutePath', () => {
	it( 'gives a directory index one spelling', () => {
		for ( const route of [ '/', '/index.html' ] ) expect( canonicalRoutePath( route ) ).toBe( '/' );
		for ( const route of [ '/about', '/about/', '/about/index.html' ] )
			expect( canonicalRoutePath( route ) ).toBe( '/about/' );
	} );

	it( 'leaves a real file alone', () => {
		expect( canonicalRoutePath( '/feed.xml' ) ).toBe( '/feed.xml' );
		expect( canonicalRoutePath( 'blog/post.html' ) ).toBe( '/blog/post.html' );
	} );
} );

describe( 'evidenceSlug', () => {
	it.each( [
		[ '/', 'index' ],
		[ '---', 'index' ],
		[ '/about/', 'about' ],
		[ '///About---Us///', 'About-Us' ],
		[ '/café & menu/', 'caf-menu' ],
	] )( 'normalizes %s to %s', ( route, expected ) => {
		expect( evidenceSlug( route ) ).toBe( expected );
	} );
} );

describe( 'routeSourceMap', () => {
	it( 'maps the copy back to the URLs it was captured from', () => {
		expect( [
			...routeSourceMap( {
				websiteRoot: 'website',
				routes: [
					{ url: 'https://example.com/docs/start', path: 'website/index.html' },
					{ url: 'https://example.com/docs/api', path: 'website/api/index.html' },
				],
			} ),
		] ).toEqual( [
			[ '/', 'https://example.com/docs/start' ],
			[ '/api/', 'https://example.com/docs/api' ],
		] );
	} );
} );

describe( 'receiptCoversSourceUrl', () => {
	const receipt = {
		routes: [ { url: 'https://example.com/home', path: 'website/home/index.html' } ],
		duplicateRoutes: [ {
			url: 'https://example.com/home/',
			canonicalUrl: 'https://example.com/home',
			path: 'website/home/index.html',
		} ],
	};

	it( 'accepts an exact captured URL and an explicitly receipted alias to that same file', () => {
		expect( receiptCoversSourceUrl( receipt, 'https://example.com/home' ) ).toBe( true );
		expect( receiptCoversSourceUrl( receipt, 'https://example.com/home/' ) ).toBe( true );
	} );

	it( 'does not infer slash aliases without matching receipt proof and file identity', () => {
		expect( receiptCoversSourceUrl( receipt, 'https://example.com/home//nested' ) ).toBe( false );
		expect( receiptCoversSourceUrl( { ...receipt, duplicateRoutes: [ { ...receipt.duplicateRoutes[ 0 ]!, path: 'website/other/index.html' } ] }, 'https://example.com/home/' ) ).toBe( false );
		expect( receiptCoversSourceUrl( { ...receipt, duplicateRoutes: [] }, 'https://example.com/home/' ) ).toBe( false );
	} );
} );

describe( 'checkWidthsFor', () => {
	it( 'drops widths the sweep already sampled', () => {
		expect( checkWidthsFor( [ 1440, 1600, 1920 ] ) ).toEqual( [ 1728 ] );
	} );
} );

describe( 'observePage typography', () => {
	it.skipIf( skipBrowserTests )( 'does not compare line metrics for a clipped accessible-only label', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		try {
			await page.setContent( `<!doctype html><style>
				.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(1px,1px,1px,1px); white-space:nowrap; line-height:normal; }
			</style><header><span class="visually-hidden">Open Menu</span><p>Visible navigation label</p></header>` );
			const observation = await observePage( page, page.url(), 390, 0, null, undefined, undefined, true );
			expect( observation.typography?.map( ( item ) => item.key ) ).toContain( 'Visible navigation label' );
			expect( observation.typography?.map( ( item ) => item.key ) ).not.toContain( 'Open Menu' );
		} finally {
			await browser.close();
		}
	} );
} );

describe( 'externalRequestHost', () => {
	it( 'ignores browser-local and non-network request schemes', () => {
		expect( externalRequestHost( 'about:blank', 'http://127.0.0.1:3000' ) ).toBeNull();
		expect( externalRequestHost( 'data:text/plain,ok', 'http://127.0.0.1:3000' ) ).toBeNull();
		expect( externalRequestHost( 'file:///tmp/font.woff2', 'http://127.0.0.1:3000' ) ).toBeNull();
	} );

	it( 'reports only a host for an external network request', () => {
		expect( externalRequestHost( 'http://127.0.0.1:3000/assets/app.css', 'http://127.0.0.1:3000' ) ).toBeNull();
		expect( externalRequestHost( 'https://cdn.example.test/font.woff2', 'http://127.0.0.1:3000' ) ).toBe(
			'cdn.example.test'
		);
	} );
} );

describe( 'checkFidelity', () => {
	it( 'scores injected observations at each unsampled width', async () => {
		const seen: number[] = [];
		const report = await checkFidelity( {
			directory: liberatedRun(),
			observe: async ( _source, _local, viewport ) => {
				seen.push( viewport );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );
		expect( seen ).toEqual( [ 1600, 1728, 390 ] );
		expect( report.pass ).toBe( true );
		expect( report.sourceUrl ).toBe( 'https://example.com/' );
	} );

	it( 'fails source parity when identical static observations conceal unsupported motion', async () => {
		const directory = liberatedRun();
		writeFileSync( join( directory, 'source-interactivity.json' ), JSON.stringify( {
			schema: 'data-liberation/source-interactivity/v1',
			pages: [ { url: 'https://example.com/', status: 'unreproduced', signals: [ 'canvas-2d', 'pointer-input' ] } ],
		} ) );
		writeFileSync( join( directory, 'capture-receipt.json' ), JSON.stringify( {
			source: { url: 'https://example.com/' }, websiteRoot: 'website',
			sourceInteractivity: { schema: 'data-liberation/source-interactivity/v1', path: 'source-interactivity.json', unreproduced_route_count: 1 },
		} ) );
		const report = await checkFidelity( {
			directory,
			observe: async ( _source, _candidate, viewport ) => ( { source: obs( viewport ), liberated: obs( viewport ) } ),
		} );
		expect( report.pass ).toBe( false );
		expect( report.scores.every( ( score ) => score.failures.some( ( reason ) => reason.includes( 'source motion not reproduced' ) ) ) ).toBe( true );
	} );

	it.skipIf( skipBrowserTests )( 'ignores a clipped focus-only fragment link while retaining the matching visible link', async () => {
		const visible = '<nav><a href="#content">Skip to content</a></nav><main id="content"><h1>Home</h1><p>Visible editorial text.</p></main>';
		const candidate = '<style>.focus-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.focus-only:focus{clip-path:none;width:auto;height:auto}</style><a class="focus-only" href="#content">Skip to content</a>';
		const server = createServer( ( request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<!doctype html><html><head><title>Home</title></head><body>${ request.headers.host?.startsWith( 'localhost' ) ? candidate : '' }${ visible }</body></html>` );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const port = ( server.address() as { port: number } ).port;
		const directory = liberatedRun();
		writeFileSync( join( directory, 'website', 'index.html' ), `<!doctype html><html><head><title>Home</title></head><body>${ visible }</body></html>` );
		writeFileSync( join( directory, 'capture-receipt.json' ), JSON.stringify( { source: { url: `http://127.0.0.1:${ port }/` }, websiteRoot: 'website', routes: [ { url: `http://127.0.0.1:${ port }/`, path: 'website/index.html' } ] } ) );
		try {
			const report = await checkFidelity( { directory, candidateUrl: `http://localhost:${ port }`, widths: [ 1600, 390 ], settleMs: 0 } );
			const score = report.scores.find( ( row ) => row.viewport === 1600 )!;
			expect( score.source.textChars ).toBe( score.liberated.textChars );
			expect( score.failures.filter( ( failure ) => failure.startsWith( 'text' ) ) ).toEqual( [] );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	}, 90_000 );

	it.skipIf( skipBrowserTests )( 'measures a source subpage in place when its nav links to fragments on another page', async () => {
		// A client-routed builder: the subpage's nav links to sections of the home
		// page. Following one routes the app home, so the source must be measured
		// without treating another page's fragment as an in-page anchor.
		const other = ( routed: boolean ) => `<!doctype html><html><head><title>Other page</title></head><body>
<nav><a href="/#features">Features</a> <a href="/#contact">Contact</a></nav>
<main><h1>Other page</h1><p>${ 'Other page copy. '.repeat( 20 ) }</p></main>
${ routed ? `<script>document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  history.pushState({}, '', link.getAttribute('href'));
  document.title = 'Home page';
  document.body.innerHTML = '<main><h1>Home</h1><p>' + 'Home copy that is much longer. '.repeat(60) + '</p><section id="features">F</section><section id="contact">C</section></main>';
});</script>` : '' }
</body></html>`;
		const server = createServer( ( req, res ) => {
			res.setHeader( 'content-type', 'text/html' );
			res.end( req.url?.startsWith( '/other' ) ? other( true ) : '<!doctype html><html><head><title>Home page</title></head><body><main><h1>Home</h1></main></body></html>' );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website', 'other' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), '<!doctype html><html><head><title>Home page</title></head><body><main><h1>Home</h1></main></body></html>' );
		writeFileSync( join( dir, 'website', 'other', 'index.html' ), other( false ) );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: `${ origin }/` },
				websiteRoot: 'website',
				routes: [
					{ url: `${ origin }/`, path: 'website/index.html' },
					{ url: `${ origin }/other`, path: 'website/other/index.html' },
				],
			} )
		);
		try {
			const report = await checkFidelity( { directory: dir, widths: [ 1440 ], routes: [ '/other/' ], settleMs: 200 } );
			const score = report.scores.find( ( entry ) => entry.route === '/other/' && entry.viewport === 1440 )!;
			expect( score.source.title ).toBe( 'Other page' );
			expect( score.failures.filter( ( failure ) => failure.startsWith( 'title' ) || failure.startsWith( 'text' ) ) ).toEqual( [] );
			expect( score.source.hashTargets ).toEqual( [] );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	}, 90_000 );
	it( 'compares each route against a candidate copy instead of the capture', async () => {
		const pairs: Array< [ string, string ] > = [];
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			candidateUrl: 'http://127.0.0.1:8080/site/',
			observe: async ( sourceHref, localHref, viewport ) => {
				pairs.push( [ sourceHref, localHref ] );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );
		expect( [ ...new Set( pairs.map( ( pair ) => pair[ 1 ] ) ) ] ).toEqual( [ 'http://127.0.0.1:8080/site/' ] );
		expect( pairs.every( ( pair ) => pair[ 0 ] === 'https://example.com/' ) ).toBe( true );
		expect( report.pass ).toBe( true );
	} );

	it( 'reports attribution a candidate retains as a failed check, not a rejection', async () => {
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			candidateUrl: 'http://127.0.0.1:8080',
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport ),
				candidateRetained: viewport === 1600 ? 2 : 0,
			} ),
		} );
		expect( report.pass ).toBe( false );
		expect( report.scores.find( ( score ) => score.viewport === 1600 )!.failures ).toContain(
			'candidate retains advertising or source attribution (2 removable)'
		);
	} );

	it( 'refuses a candidate URL that is not a plain http(s) base', async () => {
		for ( const candidateUrl of [ 'not a url', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?x=1' ] ) {
			await expect(
				checkFidelity( { directory: liberatedRun(), candidateUrl, observe: async () => { throw new Error( 'unreachable' ); } } )
			).rejects.toThrow( /candidateUrl/ );
		}
	} );

	it( 'compares a subpath source against the page it captured, not the origin root', async () => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), '<h1>Home</h1>' );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: 'https://example.com/handbook/intro' },
				websiteRoot: 'website',
				routes: [ { url: 'https://example.com/handbook/intro', path: 'website/index.html' } ],
			} )
		);

		const requested: string[] = [];
		await checkFidelity( {
			directory: dir,
			widths: [ 1600 ],
			observe: async ( sourceHref, _local, viewport ) => {
				requested.push( sourceHref );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );

		// Every pass asks for the captured page, however many passes there are.
		// Pinning the exact call count is what broke when an interactivity pass
		// was added; the intent is that no pass reaches for the origin root.
		expect( requested.length ).toBeGreaterThan( 0 );
		expect( [ ...new Set( requested ) ] ).toEqual( [ 'https://example.com/handbook/intro' ] );
	} );

	it( 'compares a small sample to the source while checking every route offline', async () => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		for ( const sub of [ 'website', 'website/about', 'website/blog/a', 'website/blog/b' ] )
			mkdirSync( join( dir, sub ), { recursive: true } );
		const post = ( title: string, paragraphs: number ) =>
			`<html><body><main><article><h1>${ title }</h1>${ '<p>copy</p>'.repeat(
				paragraphs
			) }</article></main></body></html>`;
		writeFileSync(
			join( dir, 'website', 'index.html' ),
			'<html><body><header><nav></nav></header><main><section><h1>Home</h1></section></main></body></html>'
		);
		writeFileSync(
			join( dir, 'website', 'about', 'index.html' ),
			'<html><body><main><aside><p>About</p></aside><ul><li>x</li></ul></main></body></html>'
		);
		// Two posts on one template, differing only in how much copy they carry.
		writeFileSync( join( dir, 'website', 'blog', 'a', 'index.html' ), post( 'A', 3 ) );
		writeFileSync( join( dir, 'website', 'blog', 'b', 'index.html' ), post( 'B', 17 ) );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: 'https://example.com/' },
				websiteRoot: 'website',
				routes: [
					{ url: 'https://example.com/blog/b', path: 'website/blog/b/index.html' },
					{ url: 'https://example.com/', path: 'website/index.html' },
					{ url: 'https://example.com/about', path: 'website/about/index.html' },
					{ url: 'https://example.com/blog/a', path: 'website/blog/a/index.html' },
				],
			} )
		);

		const seen: string[] = [];
		const report = await checkFidelity( {
			directory: dir,
			widths: [ 1600 ],
			observe: async ( sourceHref, _local, viewport ) => {
				seen.push( sourceHref );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );

		// Small site: every route fits inside the sample.
		expect( report.routesAvailable ).toBe( 4 );
		expect( report.routes ).toEqual( [ '/', '/about/', '/blog/a/', '/blog/b/' ] );
		expect( seen[ 0 ] ).toBe( 'https://example.com/' );
		// Offline tier covers all of them regardless.
		expect( report.selfConsistency.routes ).toBe( 4 );
	} );

	it( 'compares every route with proven cleanup and reports the ones without', async () => {
		const dir = mkdtempSync( join( tmpdir(), 'fidelity-partial-cleanup-' ) );
		mkdirSync( join( dir, 'website', 'about' ), { recursive: true } );
		mkdirSync( join( dir, 'website', 'blog' ), { recursive: true } );
		for ( const path of [ 'index.html', 'about/index.html', 'blog/index.html' ] )
			writeFileSync( join( dir, 'website', path ), '<html><body><main><h1>Page</h1></main></body></html>' );
		const policy = cleanupPolicy();
		const clean = { policy, reports: [ { failures: [], residual: 0 } ] };
		writeFileSync( join( dir, 'capture-receipt.json' ), JSON.stringify( {
			source: { url: 'https://example.com/' },
			websiteRoot: 'website',
			routes: [
				{ url: 'https://example.com/', path: 'website/index.html' },
				{ url: 'https://example.com/about', path: 'website/about/index.html' },
				{ url: 'https://example.com/blog', path: 'website/blog/index.html' },
			],
			cleanup: { policy, evidencePath: 'cleanup-evidence.json', complete: false },
		} ) );
		// The blog page lost its cleanup evidence during capture.
		writeFileSync( join( dir, 'cleanup-evidence.json' ), JSON.stringify( { schema: policy.schema, pages: [
			{ url: 'https://example.com/', ...clean },
			{ url: 'https://example.com/about', ...clean },
			{ url: 'https://example.com/blog' },
		] } ) );

		const seen: string[] = [];
		const report = await checkFidelity( {
			directory: dir,
			widths: [ 1600 ],
			observe: async ( sourceHref, _local, viewport ) => {
				seen.push( sourceHref );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );

		expect( report.routes ).toEqual( [ '/', '/about/' ] );
		expect( report.routesCleanupUnproven ).toEqual( [ '/blog/' ] );
		expect( seen ).not.toContain( 'https://example.com/blog' );
	} );

	it( 'refuses a capture whose cleanup is unproven for every route', async () => {
		const dir = mkdtempSync( join( tmpdir(), 'fidelity-no-cleanup-' ) );
		mkdirSync( join( dir, 'website' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), '<html><body></body></html>' );
		const policy = cleanupPolicy();
		writeFileSync( join( dir, 'capture-receipt.json' ), JSON.stringify( {
			source: { url: 'https://example.com/' },
			websiteRoot: 'website',
			routes: [ { url: 'https://example.com/', path: 'website/index.html' } ],
			cleanup: { policy, evidencePath: 'cleanup-evidence.json', complete: false },
		} ) );
		writeFileSync( join( dir, 'cleanup-evidence.json' ), JSON.stringify( { schema: policy.schema, pages: [ { url: 'https://example.com/' } ] } ) );

		await expect( checkFidelity( { directory: dir, widths: [ 1600 ], observe: async () => { throw new Error( 'must not observe' ); } } ) )
			.rejects.toThrow( 'Capture cleanup was incomplete for every route' );
	} );

	it( 'spreads the source sample so a large blog does not crowd out other pages', async () => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website', 'shop' ), { recursive: true } );
		writeFileSync(
			join( dir, 'website', 'index.html' ),
			'<html><body><header><nav></nav></header><main><h1>Home</h1></main></body></html>'
		);
		// Sixty posts sort ahead of /shop/, so route-order selection never reached it.
		const routes = [ { url: 'https://example.com/', path: 'website/index.html' } ];
		for ( let index = 0; index < 60; index++ ) {
			const slug = `blog/post-${ String( index ).padStart( 3, '0' ) }`;
			mkdirSync( join( dir, 'website', slug ), { recursive: true } );
			writeFileSync(
				join( dir, 'website', slug, 'index.html' ),
				`<html><body><main><article><h1>Post ${ index }</h1>${ '<p>copy</p>'.repeat(
					index + 1
				) }</article></main></body></html>`
			);
			routes.push( { url: `https://example.com/${ slug }`, path: `website/${ slug }/index.html` } );
		}
		writeFileSync(
			join( dir, 'website', 'shop', 'index.html' ),
			'<html><body><main><section><h2>Shop</h2><ul><li>item</li></ul></section><aside><form></form></aside></main></body></html>'
		);
		routes.push( { url: 'https://example.com/shop', path: 'website/shop/index.html' } );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( { source: { url: 'https://example.com/' }, websiteRoot: 'website', routes } )
		);

		const report = await checkFidelity( {
			directory: dir,
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport ),
			} ),
		} );

		// Ordered selection spent every check inside /blog/; an even spread reaches /shop/.
		expect( report.routesAvailable ).toBe( 62 );
		expect( report.routes[ 0 ] ).toBe( '/' );
		expect( report.routes ).toContain( '/shop/' );
		expect( report.routes ).toHaveLength( 4 );
		// And every one of the 62 routes was checked offline.
		expect( report.selfConsistency.routes ).toBe( 62 );
	} );

	it( 'refuses to compare a route the capture never took', async () => {
		await expect(
			checkFidelity( {
				directory: liberatedRun(),
				routes: [ '/pricing' ],
				widths: [ 1600 ],
				observe: async ( _source, _local, viewport ) => ( {
					source: obs( viewport ),
					liberated: obs( viewport ),
				} ),
			} )
		).rejects.toThrow( /was not captured/ );
	} );

	it( 'fails the report when any viewport freezes', async () => {
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport, { widestImage: 1440 } ),
			} ),
		} );
		expect( report.pass ).toBe( false );
		expect( report.failed ).toBe( 1 );
	} );

	it( 'fails the report when the copy renders fewer images than the source', async () => {
		const slides = ( viewport: number ) => [
			{ key: 'slide-a.jpg', x: 0, y: 96, width: viewport, height: 600 },
			{ key: 'slide-b.jpg', x: 0, y: 96, width: viewport, height: 600 },
		];
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport, { images: slides( viewport ) } ),
				liberated: obs( viewport, { images: [] } ),
			} ),
		} );
		expect( report.pass ).toBe( false );
		expect( report.scores[ 0 ]?.failures[ 0 ] ).toMatch( /^images 2 of 2 missing: slide-a\.jpg/ );
	} );

	it( 'records a pixel score as evidence without letting it fail the gate', async () => {
		const black = new PNG( { width: 4, height: 4 } );
		const white = new PNG( { width: 4, height: 4 } );
		for ( let i = 0; i < black.data.length; i += 4 ) {
			black.data[ i + 3 ] = 255;
			white.data[ i ] = 255;
			white.data[ i + 1 ] = 255;
			white.data[ i + 2 ] = 255;
			white.data[ i + 3 ] = 255;
		}
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport ),
				sourcePng: PNG.sync.write( black ),
				liberatedPng: PNG.sync.write( white ),
			} ),
		} );
		expect( report.pass ).toBe( true );
		expect( report.scores[ 0 ]?.notes.join( ' ' ) ).toMatch( /evidence, not a gate/ );
	} );
} );

describe.skipIf( skipBrowserTests )( 'comparison screenshot transaction', () => {
	it( 'captures the baseline before dialog probes change scroll and visibility', async () => {
		const html = ( scroll: boolean ) => `<!doctype html><html><head><title>Dialog baseline</title>
			<style>body{margin:0;background:white}#top{height:900px;background:#123456}#bottom{height:2000px;background:#abcdef}</style>
			</head><body><main><div id="top"><h1>Article</h1>
			<button aria-haspopup="true" aria-controls="panel" onclick="document.getElementById('panel').hidden=false;${ scroll ? 'window.scrollTo(0,1500)' : '' }">Open</button>
			<div id="panel" role="dialog" hidden>Details</div></div><div id="bottom">Footer</div></main></body></html>`;
		const server = createServer( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( html( true ) );
		} );
		await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
		const dir = liberatedRun();
		writeFileSync( join( dir, 'website', 'index.html' ), html( false ) );
		writeFileSync( join( dir, 'capture-receipt.json' ), JSON.stringify( {
			source: { url: origin + '/' }, websiteRoot: 'website',
			routes: [ { url: origin + '/', path: 'website/index.html' } ],
		} ) );
		try {
			await checkFidelity( { directory: dir, widths: [ 1600 ], settleMs: 0, screenshots: true } );
			for ( const side of [ 'source', 'liberated' ] ) {
				const png = PNG.sync.read( readFileSync( join( dir, 'compare', 'index', '1600', `${ side }.png` ) ) );
				const offset = ( 400 * png.width + 800 ) * 4;
				expect( [ ...png.data.subarray( offset, offset + 3 ) ] ).toEqual( [ 0x12, 0x34, 0x56 ] );
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>( resolve => server.close( () => resolve() ) );
		}
	}, 90_000 );
} );

describe.skipIf( skipBrowserTests )( 'checkFidelity with a source that pings on exit', () => {
	// Substack publications send analytics beacons when the page is left
	// (POST /api/v1/firehose/batch to the site and to substack.com). compare
	// measured the source and then navigated the same tab to the copy with the
	// copy's request listener already attached, so the source's exit pings were
	// reported as "copy requested 2 external host(s): substack.com,
	// www.derekthompson.org" on every route of a clean copy.
	const body = `<main><h1>A post</h1><p>${ 'Body copy that does not change. '.repeat( 20 ) }</p></main>`;
	const html = ( extra = '' ) =>
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post</title></head><body>${ body }${ extra }</body></html>`;
	const exitBeacon = `<script>addEventListener('beforeunload', () => navigator.sendBeacon('/ping', 'left'));</script>`;

	/** Serve a live source that beacons on exit, write `copy` (given the source origin) to disk, and compare. */
	async function compare( copy: ( origin: string ) => string ) {
		let pings = 0;
		const server = createServer( ( request, response ) => {
			if ( request.url === '/ping' || request.url === '/pixel.gif' ) {
				if ( request.url === '/ping' ) pings++;
				response.end();
				return;
			}
			response.setHeader( 'content-type', 'text/html' );
			response.end( html( exitBeacon ) );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), copy( origin ) );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: `${ origin }/` },
				websiteRoot: 'website',
				routes: [ { url: `${ origin }/`, path: 'website/index.html' } ],
			} )
		);
		try {
			const report = await checkFidelity( { directory: dir, widths: [ 1440 ], settleMs: 200 } );
			const external = report.scores.flatMap( ( score ) => score.failures.filter( ( failure ) => failure.startsWith( 'copy requested' ) ) );
			return { pings, external };
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	}

	it( 'does not blame the copy for the source page\'s exit beacons', async () => {
		const { pings, external } = await compare( () => html() );
		// The scenario is real: the source did send its exit beacon.
		expect( pings ).toBeGreaterThan( 0 );
		expect( external ).toEqual( [] );
	}, 90_000 );

	it( 'still reports a request the copy itself makes to the source', async () => {
		const { external } = await compare( ( origin ) => html( `<img src="${ origin }/pixel.gif" alt="">` ) );
		expect( external ).toEqual( [ expect.stringMatching( /^copy requested 1 external host\(s\): localtest\.me:\d+/ ) ] );
	}, 90_000 );
} );

describe.skipIf( skipBrowserTests )( 'checkFidelity with a consent banner on the source', () => {
	// The live source raises a cookie banner; capture dismisses it before it
	// serializes, so the copy never has one. Measuring the source with the
	// banner still up made every route on such a site fail by exactly the
	// banner's length — 355 characters on www.tallersherrera.com (run r64),
	// identically on /contacto/, /privacidad/ and /servicios/.
	const banner = `<div id="cookie-consent-container" class="cookie-consent-container" style="position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#eee;padding:24px">
<p>Politica de cookies. Esta pagina utiliza cookies para mejorar su experiencia.</p>
<button type="button">Aceptar</button> <button type="button">Declinar</button> <button type="button">Gestionar ajustes</button>
</div>`;
	const body = `<p>${ 'Reparamos faros de coche. '.repeat( 20 ) }</p>`;
	const alsoOnTheSource = `<p>${ 'Horario de apertura de lunes a viernes. '.repeat( 10 ) }</p>`;
	const page = ( parts: { banner?: boolean; extra?: boolean } ) =>
		`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Taller</title></head><body>
<main><h1>Servicios</h1>${ body }${ parts.extra === false ? '' : alsoOnTheSource }</main>
${ parts.banner ? banner : '' }
</body></html>`;

	/** Serve `page({banner:true})` live, write `copy` to disk, and compare. */
	async function compare( copy: string ) {
		const server = createServer( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( page( { banner: true } ) );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), copy );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: `${ origin }/` },
				websiteRoot: 'website',
				routes: [ { url: `${ origin }/`, path: 'website/index.html' } ],
			} )
		);
		try {
			return await checkFidelity( { directory: dir, widths: [ 1440 ], settleMs: 200 } );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	}

	const textFailures = ( report: Awaited< ReturnType< typeof compare > > ) =>
		report.scores.flatMap( ( score ) => score.failures.filter( ( failure ) => failure.startsWith( 'text' ) ) );

	it( 'does not fail a copy for the banner the capture dismissed', async () => {
		const report = await compare( page( { banner: false } ) );
		expect( textFailures( report ) ).toEqual( [] );
		// And says why the two documents were allowed to differ.
		const dismissed = report.overlays.filter( ( record ) => record.side === 'source' );
		expect( dismissed.length ).toBeGreaterThan( 0 );
		expect( dismissed.flatMap( ( record ) => record.dismissed.map( ( overlay ) => overlay.kind ) ) ).toContain(
			'consent'
		);
		expect( report.overlays.filter( ( record ) => record.side === 'copy' ) ).toEqual( [] );
	}, 90_000 );

	it( 'still fails a copy that lost real content behind the banner', async () => {
		const report = await compare( page( { banner: false, extra: false } ) );
		expect( textFailures( report ).length ).toBeGreaterThan( 0 );
	}, 90_000 );

	// A source-observed mobile bottom-tab bar: buttons whose clicks are client-side
	// route changes. Capture records which button changed which URL; compare must
	// prove the portable copy's native link actually navigates under a real
	// visitor click at the widths a phone and tablet use — and that an empty
	// fixed shell parked over the tabs (the pre-fix state) is reported as the
	// click interception it is, not silently passed. A destination conversion
	// may also materialize each tab as an editable group that splits it into an
	// icon link plus a paragraph-wrapped labeled link — every link still
	// navigates, and the verifier must follow the labels through the wrappers.
	const TAB_LABELS = [ 'Home', 'Services', 'Resources', 'Contact', 'Refresh' ];

	const sourceApp = (): string => `<!doctype html><html><head><title>Home</title><style>
		#bottom{display:flex;position:fixed;bottom:0;left:0;right:0;height:64px;background:#fff;border-top:1px solid #ddd;z-index:10}
		#bottom button{flex:1;border:0;background:none;font-size:16px}
		.shell{position:fixed;bottom:0;right:0;width:60%;height:70px;z-index:100}
		@media(min-width:1000px){#bottom{display:none}}
	</style></head><body>
	<main><h1>Home</h1><p>Home copy.</p></main>
	<nav id="bottom" aria-label="Pages"><button type="button">Home</button><button type="button">Services</button><button type="button">Resources</button><button type="button">Contact</button><button type="button">Refresh</button></nav>
	<div class="shell"></div>
	<script>
		var titles = { '': 'Home', services: 'Services', resources: 'Resources', contact: 'Contact' };
		document.querySelectorAll('#bottom button').forEach(function (button) {
			button.addEventListener('click', function () {
				var id = button.textContent.trim().toLowerCase();
				history.pushState({}, '', id ? '/' + id + '/' : '/');
				document.querySelector('h1').textContent = titles[id === '' ? '' : id] || 'Home';
			});
		});
	</script>
	</body></html>`;

	const copyPage = ( variant: 'flat' | 'shell' | 'wrapped' | 'wrapped-broken' | 'contents' | 'contents-negative', route: string ): string => {
		const wrapped = variant === 'wrapped' || variant === 'wrapped-broken' || variant === 'contents' || variant === 'contents-negative';
		const labelLink = ( label: string, href: string ): string => {
			if ( variant === 'contents' ) return `<p class="tab-label"><a href="${ href }" style="display:contents"><mark>${ label }</mark></a></p>`;
			// Negative controls: a link the import left genuinely hidden
			// (display:none, so its mark never paints) must stay missing, and
			// a box-less link that renders but no longer reaches its captured
			// route must still be reported.
			if ( variant === 'contents-negative' ) {
				if ( label === 'Services' ) return `<p class="tab-label"><a href="${ href }" style="display:none"><mark>${ label }</mark></a></p>`;
				if ( label === 'Contact' ) return `<p class="tab-label"><a href="/contact-missing/" style="display:contents"><mark>${ label }</mark></a></p>`;
			}
			return `<p class="tab-label"><a href="${ href }">${ label }</a></p>`;
		};
		const nav = ! wrapped
			? `<nav id="bottom" aria-label="Pages"><a href="/">Home</a><a href="/services/">Services</a><a href="/resources/">Resources</a><a href="/contact/">Contact</a><button type="button">Refresh</button></nav>`
			: `<nav id="bottom" aria-label="Pages">${ [ [ 'Home', '/' ], [ 'Services', '/services/' ], [ 'Resources', '/resources/' ], [ 'Contact', variant === 'wrapped-broken' ? '/contact-missing/' : '/contact/' ] ].map( ( [ label, href ] ) => `<div class="tab"><a href="${ href }"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20"/></svg></a>${ labelLink( label, href ) }</div>` ).join( '' ) }<button type="button">Refresh</button></nav>`;
		return `<!doctype html><html><head><title>${ route === '/' ? 'Home' : route }</title><style>
		#bottom{display:flex;position:fixed;bottom:0;left:0;right:0;height:64px;background:#fff;border-top:1px solid #ddd;z-index:10}
		#bottom a,#bottom button{flex:1;display:flex;align-items:center;justify-content:center;font-size:16px}
		#bottom .tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px}
		#bottom p{margin:0}
		.shell{position:fixed;bottom:0;right:0;width:60%;height:70px;z-index:100}
		@media(min-width:1000px){#bottom{display:none}}
	</style></head><body>
	<main><h1>${ route === '/' ? 'Home' : route }</h1><p>${ route === '/' ? 'Home copy.' : route + ' copy.' }</p></main>
	${ nav }
	${ variant === 'shell' ? '<div class="shell"></div>' : '' }
	</body></html>`;
	};

	const routeTabRun = ( origin: string, variant: 'flat' | 'shell' | 'wrapped' | 'wrapped-broken' | 'contents' | 'contents-negative' ): string => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-tabs-' ) );
		dirs.push( dir );
		mkdirSync( join( dir, 'website', 'services' ), { recursive: true } );
		mkdirSync( join( dir, 'website', 'resources' ), { recursive: true } );
		mkdirSync( join( dir, 'website', 'contact' ), { recursive: true } );
		writeFileSync( join( dir, 'website', 'index.html' ), copyPage( variant, '/' ) );
		writeFileSync( join( dir, 'website', 'services', 'index.html' ), copyPage( variant, 'Services' ) );
		writeFileSync( join( dir, 'website', 'resources', 'index.html' ), copyPage( variant, 'Resources' ) );
		writeFileSync( join( dir, 'website', 'contact', 'index.html' ), copyPage( variant, 'Contact' ) );
		writeFileSync( join( dir, 'interaction-states.json' ), JSON.stringify( {
			schema: 'data-liberation/captured-interactions/v2',
			pages: [
				{
					url: `${ origin }/`,
					routeNavigation: [ 'services', 'resources', 'contact' ].map( ( id ) => ( {
						selector: `body > nav:nth-of-type(2) > button:nth-of-type(${ 2 + [ 'services', 'resources', 'contact' ].indexOf( id ) })`,
						id,
						label: id[ 0 ].toUpperCase() + id.slice( 1 ),
						siblings: TAB_LABELS,
						url: `${ origin }/${ id }`,
					} ) ),
				},
				{
					url: `${ origin }/services`,
					routeNavigation: [ { selector: 'body > nav:nth-of-type(2) > button:nth-of-type(1)', id: 'home', label: 'Home', siblings: TAB_LABELS, url: `${ origin }/` } ],
				},
			],
		} ) );
		writeFileSync(
			join( dir, 'capture-receipt.json' ),
			JSON.stringify( {
				source: { url: `${ origin }/` },
				websiteRoot: 'website',
				routes: [
					{ url: `${ origin }/`, path: 'website/index.html' },
					{ url: `${ origin }/services`, path: 'website/services/index.html' },
					{ url: `${ origin }/resources`, path: 'website/resources/index.html' },
					{ url: `${ origin }/contact`, path: 'website/contact/index.html' },
				],
			} )
		);
		return dir;
	};

	const routeTabServer = async (): Promise< { origin: string; close: () => Promise< void > } > => {
		const server = createServer( ( request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( sourceApp() );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		return {
			origin: `http://localtest.me:${ ( server.address() as { port: number } ).port }`,
			close: async () => {
				server.closeAllConnections();
				await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			},
		};
	};

	it( 'proves real clicks on observed route tabs at 390 and 768', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'flat' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const interactivity = report.scores.find( ( score ) => score.viewport === 390 )!;
			expect( interactivity.notes ).toContain( 'route tabs @ 390px: clicks verified' );
			expect( interactivity.notes ).toContain( 'route tabs @ 768px: clicks verified' );
			expect( report.pass ).toBe( true );
		} finally {
			await server.close();
		}
	}, 90_000 );

	it( 'fails when an empty fixed shell still blocks the tab clicks', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'shell' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const blocked = report.scores.flatMap( ( score ) => score.failures ).filter( ( failure ) => failure.includes( 'click blocked' ) );
			expect( blocked.length ).toBeGreaterThan( 0 );
			expect( report.pass ).toBe( false );
		} finally {
			await server.close();
		}
	}, 90_000 );

	// Editable-block materialization splits each source tab into an icon link
	// and a paragraph-wrapped labeled link inside a per-tab group: no direct
	// anchor/button siblings remain. Every labeled link still reaches its
	// route, so the verifier must follow the source-observed group labels
	// through the wrappers — and a labeled link that no longer reaches its
	// captured route must still be reported.
	it( 'verifies route tabs an editable conversion split into icon and labeled links', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'wrapped' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const interactivity = report.scores.find( ( score ) => score.viewport === 390 )!;
			expect( interactivity.notes ).toContain( 'route tabs @ 390px: clicks verified' );
			expect( interactivity.notes ).toContain( 'route tabs @ 768px: clicks verified' );
			expect( report.pass ).toBe( true );
		} finally {
			await server.close();
		}
	}, 90_000 );

	it( 'fails a split route tab whose labeled link no longer reaches its route', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'wrapped-broken' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const broken = report.scores.flatMap( ( score ) => score.failures ).filter( ( failure ) => failure.includes( 'links to /contact-missing/' ) );
			expect( broken.length ).toBeGreaterThan( 0 );
			expect( report.pass ).toBe( false );
		} finally {
			await server.close();
		}
	}, 90_000 );

	// WordPress import lowering can leave the tab's label anchor itself
	// box-less: the conversion marks the label link display:contents so its
	// child <mark> paints in the anchor's place. The anchor then has a zero
	// rect and empty client rects even though a real click navigates, so a
	// rect-only visibility predicate reports the tab as missing. The link must
	// count as visible when a child of a display:contents anchor actually
	// paints — and a genuinely hidden (display:none) or re-pointed counterpart
	// must stay reported.
	it( 'verifies route tabs whose label anchor is display:contents around a rendered mark', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'contents' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const interactivity = report.scores.find( ( score ) => score.viewport === 390 )!;
			expect( interactivity.notes ).toContain( 'route tabs @ 390px: clicks verified' );
			expect( interactivity.notes ).toContain( 'route tabs @ 768px: clicks verified' );
			expect( report.pass ).toBe( true );
		} finally {
			await server.close();
		}
	}, 90_000 );

	it( 'fails a display:contents tab that is hidden or no longer reaches its route', async () => {
		const server = await routeTabServer();
		try {
			const report = await checkFidelity( { directory: routeTabRun( server.origin, 'contents-negative' ), widths: [ 1440 ], routes: [ '/' ], settleMs: 200 } );
			const failures = report.scores.flatMap( ( score ) => score.failures );
			expect( failures.filter( ( failure ) => failure.includes( 'route tab Services @ 390px missing native link' ) ).length ).toBe( 1 );
			expect( failures.filter( ( failure ) => failure.includes( 'route tab Services @ 768px missing native link' ) ).length ).toBe( 1 );
			expect( failures.filter( ( failure ) => failure.includes( 'route tab Contact @ 390px links to /contact-missing/' ) ).length ).toBe( 1 );
			expect( failures.filter( ( failure ) => failure.includes( 'route tab Contact @ 768px links to /contact-missing/' ) ).length ).toBe( 1 );
			expect( report.pass ).toBe( false );
		} finally {
			await server.close();
		}
	}, 90_000 );
} );
