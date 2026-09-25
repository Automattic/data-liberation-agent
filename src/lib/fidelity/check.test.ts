import { cleanupPolicy } from '../source-cleanup.js';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	canonicalRoutePath,
	checkFidelity,
	checkWidthsFor,
	evidenceSlug,
	externalRequestHost,
	resolveCheckDirectory,
	routeSourceMap,
} from './check.js';
import type { LayoutObservation } from './score.js';

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
	internalMissing: [],
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

describe( 'checkWidthsFor', () => {
	it( 'drops widths the sweep already sampled', () => {
		expect( checkWidthsFor( [ 1440, 1600, 1920 ] ) ).toEqual( [ 1728 ] );
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

	it( 'measures a source subpage in place when its nav links to fragments on another page', async () => {
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

describe( 'checkFidelity with a consent banner on the source', () => {
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
} );
