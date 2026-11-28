import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fetching from './media-fetch/safe-fetch.js';
import { applyHydrationClassRules, hiddenMainContent, learnHydrationClassRules } from './hydration-classes.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { ManifestQueue } from './screenshot/manifest-queue.js';
import { acquireEscalatedMembers, HTTP_ROUTE_CONTENT_HIDDEN } from './template-cluster-fallback.js';

const source = 'https://hydration.example/';
const post = `${ source }posts/first-post`;
const unhide = `<script>document.getElementById('page').classList.remove('loading')</script>`;
// Server HTML: the runtime script removes `loading`; site CSS hides it until then.
const homeServer = `<html><head><link rel="stylesheet" href="/site.css"></head><body><main id="page" class="page loading"><div class="tile loading">A</div><div class="tile loading">B</div></main>${ unhide }</body></html>`;
// What Chromium serialized after the script ran; the second tile is still loading.
const homeCaptured = `<html><head><link rel="stylesheet" href="/site.css"></head><body><main id="page" class="page"><div class="tile">A</div><div class="tile loading">B</div></main></body></html>`;
// A different template: an article list, never browser-captured.
const postServer = `<html><head><link rel="stylesheet" href="/site.css"></head><body><main id="page" class="page loading"><article class="entry"><h1>First post</h1></article><div class="tile loading">C</div></main>${ unhide }</body></html>`;

const directories: string[] = [];
afterEach( () => {
	vi.restoreAllMocks();
	for ( const root of directories.splice( 0 ) ) rmSync( root, { recursive: true, force: true } );
} );

async function acquirePost( capturedHomepage: boolean ) {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'hydration-classes-' ) );
	directories.push( outputDir );
	const queue = new ManifestQueue( join( outputDir, 'screenshots/manifest.json' ) );
	await queue.init();
	if ( capturedHomepage ) {
		writeFileSync( join( outputDir, 'screenshots/home.html' ), homeCaptured );
		await queue.updateEntry( source, { slug: 'home', html: 'screenshots/home.html', capturedAt: new Date().toISOString() } );
	}
	vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => {
		const css = url.endsWith( '/site.css' );
		const body = css ? '.loading{opacity:0}' : url === post ? postServer : homeServer;
		return { body: Buffer.from( body ), status: 200, finalUrl: url, headers: new Headers( { 'content-type': css ? 'text/css' : 'text/html' } ) };
	} );
	const result = await acquireEscalatedMembers( {
		outputDir, sourceUrl: source, queue, governors: new SourceRequestGovernors(),
		profile: { id: 'neutral', variants: [ { id: 'desktop' } ], prepare: html => ( { html } ) },
		members: [ { url: post, gate: 'route_omitted_by_budget', reason: 'browser window spent' } ],
	} );
	expect( result.acquired ).toEqual( [ post ] );
	return { html: readFileSync( join( outputDir, queue.getEntry( post )!.html! ), 'utf8' ), diagnostics: result.diagnostics };
}

describe( 'hydration classes learned from browser-captured routes', () => {
	it( 'removes a pre-hydration class from an HTTP-acquired route of another template', async () => {
		const { html, diagnostics } = await acquirePost( true );
		expect( html ).toContain( '<main id="page" class="page">' );
		expect( html ).not.toMatch( /class="[^"]*\bloading\b[^"]*"><article/ );
		expect( diagnostics.filter( row => row.code === HTTP_ROUTE_CONTENT_HIDDEN ) ).toEqual( [] );
	} );

	it( 'keeps a token the captured DOM keeps on an element of the same identity', async () => {
		const { html } = await acquirePost( true );
		expect( html ).toContain( '<div class="tile loading">C</div>' );
		expect( html ).toContain( '<main id="page" class="page">' );
		expect( learnHydrationClassRules( [ { server: homeServer, captured: homeCaptured } ] ) ).toEqual( [
			{ id: 'page', token: 'loading' },
			{ tag: 'main', stableClass: 'page', token: 'loading' },
		] );
	} );

	it( 'reports a route whose main content stays hidden when nothing was learned', async () => {
		const { html, diagnostics } = await acquirePost( false );
		expect( html ).toContain( 'class="page loading"' );
		expect( diagnostics ).toContainEqual( expect.objectContaining( { code: HTTP_ROUTE_CONTENT_HIDDEN, url: post } ) );
	} );

	it( 'pairs elements without ids by tag path and shared classes, editing only class attributes', () => {
		const rules = learnHydrationClassRules( [ {
			server: '<ul><li><article class="item grid-hidden">x</article></li></ul>',
			captured: '<ul><li><article class="item">x</article></li></ul>',
		} ] );
		expect( rules ).toEqual( [ { tag: 'article', stableClass: 'item', token: 'grid-hidden' } ] );
		const source = '<div><ARTICLE data-x=\'1\' class = "grid-hidden item  extra">y</ARTICLE><article class="grid-hidden">z</article></div>';
		expect( applyHydrationClassRules( source, rules ) ).toEqual( {
			html: '<div><ARTICLE data-x=\'1\' class="item extra">y</ARTICLE><article class="grid-hidden">z</article></div>',
			removed: [ 'grid-hidden' ],
		} );
	} );

	it( 'finds hiding rules on main content or its ancestors', () => {
		expect( hiddenMainContent( '<style>.busy main{display:none}</style><body class="busy"><main>x</main></body>', [] ) ).toBe( '.busy main' );
		expect( hiddenMainContent( '<main class="a">x</main>', [ '.loading' ] ) ).toBeUndefined();
		expect( hiddenMainContent( '<div role="main" class="loading">x</div>', [ '.loading' ] ) ).toBe( '.loading' );
	} );
} );
