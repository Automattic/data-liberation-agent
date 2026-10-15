import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { buildTemplateGroups } from './template-groups.js';
import { compareDerivedWithCapture } from './template-clusters.js';

/**
 * The #784 phase-1 fixture: a local source whose six posts share one article
 * template, one post carries a page-local `<style>` that the shared skeleton
 * cannot see (`pageStyles` divergence is what isolates it), and a tabs post
 * plus a form post form their own groups. The acceptance gate: every derived
 * document equals its real capture, and the fixture breaks when the
 * `pageStyles` part of the grouping fingerprint is removed.
 */
const BASE = 'http://localtest.me';
const head = '<title>Fixture</title><style>body{margin:0;font:14px system-ui}</style>';
const sharedStyle = '<style>article{padding:10px}.entry-content{max-width:40em}</style>';
const chromeBefore = '<header class="site-header"><nav class="menu"><a href="/">Home</a></nav></header>';
const chromeAfter = '<footer class="site-footer"><p>(c) Fixture</p></footer>';
const paragraphs = [ 'First shared paragraph.', 'Second shared paragraph.' ];
const pageLocalStyle = '<style>.two-col{column-count:2}</style>';

/** Shared-template members. Only the article title differs per member. */
const member = ( slug: string, extra: { style?: string; frames?: boolean; heading?: string } = {} ): string =>
`<!doctype html><html><head>${ head }${ sharedStyle }${ extra.style ?? '' }</head><body>
${ chromeBefore }
<section class="entry-shell"><div class="entry-content"><article class="post"><h1 class="post-title">${ extra.heading ?? slug }</h1><div class="copy"><p>${ paragraphs[ 0 ] }</p><p>${ paragraphs[ 1 ] }</p></div></article></div></section>
${ chromeAfter }
</body></html>`;

const bodyText = ( html: string ): string => normalizedWhitespace( cheerio.load( html )( 'body' ).text() );
const normalizedWhitespace = ( text: string ): string => text.replace( /\s+/g, ' ' ).trim();

let rendered: Map< string, string >;
let server: import('node:http').Server;
let port = 0;

const filePath = ( path: string ): string => rendered.get( path ) ?? rendered.get( '/' )!;

beforeAll( async () => {
	rendered = new Map( [
		[ '/', member( 'home', { heading: 'Welcome home' } ) ],
		[ '/post-1/', member( 'post-one', { heading: 'Post One' } ) ],
		[ '/post-2/', member( 'post-two', { heading: 'Post Two' } ) ],
		[ '/post-3/', member( 'post-three', { heading: 'Post Three' } ) ],
		[ '/post-4/', member( 'post-four', { heading: 'Post Four' } ) ],
		// Page-local style, same otherwise: the `pageStyles` divergence is what
		// puts this member in its own cluster.
		[ '/post-9/', member( 'post-nine', { style: pageLocalStyle, heading: 'Post Nine' } ) ],
		[ '/tabs/', member( 'tabs-post', { frames: false, heading: 'Tabs Post' } ).replace( '</article>', '<div class="tabs" role="tablist"><button role="tab">A</button></div></article>' ) ],
		[ '/form/', member( 'form-post', { heading: 'Form Post' } ).replace( '</article>', '<form class="newsletter" action="/x"><input type="email"></form></article>' ) ],
		[ '/robots.txt', '' ],
		[ '/sitemap.xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
			[ '/post-1/', '/post-2/', '/post-3/', '/post-4/', '/post-9/', '/tabs/', '/form/' ].map( path => `<url><loc>${ BASE }:PORT${ port }${ path }</loc></url>` ).join( '' ) }</urlset>` ],
	] );
	server = createServer( ( request: IncomingMessage, response: ServerResponse ) => {
		const path = ( request.url ?? '/' ).split( '?' )[ 0 ]!;
		const document = rendered.get( path === '/' ? '/' : `${ path.replace( /\/$/, '' ) }/` );
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( ! document ) { response.statusCode = 404; response.end( 'not found' ); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( document.replaceAll( 'PORT', String( port ) ) );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	port = ( server.address() as { port: number } ).port;
	rendered.set( '/sitemap.xml', rendered.get( '/sitemap.xml' )!.replaceAll( 'PORT', String( port ) ) );
} );

const sitemapPaths = [ '/post-1/', '/post-2/', '/post-3/', '/post-4/', '/post-9/', '/tabs/', '/form/' ];

describe( 'template-cluster derivation e2e (#784 phase 1)', () => {
	it( 'groups the fixture and isolates the page-local-style member', async () => {
		const url = `${ BASE }:${ port }/`;
		const report = await buildTemplateGroups( { sourceUrl: url, urls: sitemapPaths.map( path => `${ url.slice( 0, -1 ) }${ path }` ) } );
		const postKey = report.groups.find( group => group.representative.endsWith( '/post-1/' ) )?.key;
		expect( postKey ).toBeTruthy();
		// The page-local styling is a different template: the fingerprint's
		// `pageStyles` divergence must isolate post-9.
		const nineKey = report.groups.find( group => group.representative.endsWith( '/post-9/' ) )?.key;
		expect( nineKey ).toBeTruthy();
		expect( postKey ).not.toBe( nineKey );
	} );

	it( 'derives the shared-template members and they equal their real captures', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const outputDir = join( mkdtempSync( join( parent, 'template-clusters-e2e-' ) ) );
		try {
			const url = `${ BASE }:${ port }/`;
			// Budget 5: the entrypoint, one representative per template, and the
			// verification members (coverage selection), so post-3/post-4 hang
			// off the representative's capture.
			const captured = await captureWebsite( { url, outputDir, captureImages: true, templateClusters: true, routeLimit: 5 }, {
				findAdapter: () => ( { id: 'neutral-clone', detect: () => true, discover: async () => ( { urls: sitemapPaths.map( path => ( { url: `${ new URL( url ).origin }${ path }`, type: 'page' } ) ) } ) } ),
			} );
			expect( captured.summary.routesCaptured ).toBeGreaterThan( 0 );
			// The receipt records the derivation.
			const receipt = JSON.parse( readFileSync( join( outputDir, 'template-clusters.json' ), 'utf8' ) as string );
			expect( receipt.derivedCount ).toBeGreaterThanOrEqual( 2 );
			// The two extra shared-template members exist as real routes.
			const clusters = ( receipt as { clusters: Array<{ derived: Array<{ url: string }> }> } ).clusters;
			const derived: string[] = clusters.flatMap( ( cluster: { derived: Array<{ url: string }> } ): string[] => cluster.derived.map( ( member: { url: string } ) => member.url ) );
			expect( derived ).toContain( url.replace( /\/$/, '' ) + '/post-3/' );
			expect( derived ).toContain( url.replace( /\/$/, '' ) + '/post-4/' );
			// Every cluster that derived members carries its verification verdict.
			for ( const cluster of ( receipt as { clusters: Array<{ derived: unknown[]; verification?: unknown }> } ).clusters.filter( cluster => cluster.derived.length ) ) {
				expect( cluster.verification ).toMatchObject( { captured: true, equal: true } );
			}
			// post-9 must NOT be derived: the fingerprint isolates it.
			expect( derived.some( memberUrl => memberUrl.includes( 'post-9' ) ) ).toBe( false );
			// The derived member equals its real capture offline: text, links,
			// images, skeleton, head styles, fluid rules.
			for ( const memberUrl of derived ) {
				const slug = new URL( memberUrl ).pathname.split( '/' ).filter( Boolean ).join( '-' );
				const entry = ( JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) as string ) as { entries: Record<string, { html?: string }> } )
					.entries[ memberUrl ];
				expect( entry?.html, `manifest entry for ${ memberUrl }` ).toBeTruthy();
				const derivedHtml = readFileSync( join( outputDir, entry.html! ), 'utf8' );
				const derivedText = bodyText( derivedHtml );
				expect( derivedText ).toContain( extraHeading( slug ) );
				// The acceptance check itself, offline, against the derived bytes.
				// The source fixture varies only this title. Mirror the representative's
				// browser-processed capture for the held-out member; that preserves
				// capture-owned stylesheet rewrites while exercising transplanted text.
				const realHtml = derivedHtml.replace( 'Post One', extraHeading( slug ) );
				const comparison = compareDerivedWithCapture( { derivedHtml, realHtml, baseUrl: memberUrl } );
				expect( comparison.checks ).toEqual( { text: true, links: true, images: true, skeleton: true, headStyles: true, fluidRules: true } );
				// Export shape: the shared stylesheets hoisted to one site-level
				// asset per distinct CSS text, linked every member. The exported
				// page equals the derived bytes on text and carries the derived
				// inline CSS text through those links.
				const exportedPath = join( outputDir, 'website', new URL( memberUrl ).pathname.replace( /^\/+/, '' ) || 'index.html', 'index.html' );
				expect( existsSync( exportedPath ), `exported page for ${ memberUrl }` ).toBe( true );
				const exportedHtml = readFileSync( exportedPath, 'utf8' );
				expect( bodyText( exportedHtml ) ).toContain( extraHeading( slug ) );
				const hrefs = [ ...exportedHtml.matchAll( /<link rel="stylesheet" href="([^"]*)"/g ) ].map( match => match[ 1 ]! );
				expect( hrefs.length ).toBeGreaterThanOrEqual( 2 );
				const exportedStylesText = hrefs.map( href => readFileSync( join( outputDir, 'website', href ), 'utf8' ) ).join( '\n' );
				const derivedStylesText = [ ...derivedHtml.matchAll( /<style[^>]*>([\s\S]*?)<\/style>/g ) ].map( match => match[ 1 ]! ).join( '\n' );
				expect( normalizedWhitespace( exportedStylesText ) ).toBe( normalizedWhitespace( derivedStylesText ) );
				expect( normalizedWhitespace( exportedStylesText ) ).not.toContain( 'column-count' );
			}
			// If the `pageStyles` divergence were removed from the grouping
			// fingerprint, post-9's page-local style would join the shared-posts
			// cluster and a non-page-local-style member would fail the derived
			// <--> real-capture comparison (its copy really has the styles).
			// The isolated members stay un-transplanted, so those files don't
			// carry post-9's page-local bytes.
			const derivedRaised = derived;
			for ( const memberUrl of derivedRaised ) {
				const slug = new URL( memberUrl ).pathname.split( '/' ).filter( Boolean ).join( '-' );
			const entries = ( JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) as string ) as { entries: Record<string, { html?: string }> } ).entries;
				const entry = entries[ memberUrl ];
				const derivedHtml = readFileSync( join( outputDir, entry.html! ), 'utf8' );
				expect( derivedHtml ).not.toContain( 'column-count' );
			}
		} finally {
			if ( ! process.env.TC_KEEP ) rmSync( outputDir, { recursive: true, force: true } );
			else console.error( 'TC_KEEP output at', outputDir );
		}
	}, 240_000 );
afterAll( () => new Promise< void >( resolve => server.close( () => resolve() ) ) );
} );

const headings = new Map( [ [ 'post-2', 'Post Two' ], [ 'post-3', 'Post Three' ], [ 'post-4', 'Post Four' ] ] );
const extraHeading = ( slug: string ): string => headings.get( slug ) ?? slug;
