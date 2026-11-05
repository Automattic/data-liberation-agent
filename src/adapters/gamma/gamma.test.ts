import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { detectFromResponse } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { nextjsAdapter } from '../nextjs/index.js';
import { gammaAdapter } from './index.js';

const spinner = '<div data-node-view-wrapper=""><div class="video-box"><div class="chakra-spinner"><span>Loading...</span></div></div></div>';
const video = ( url: string ) => ( { type: 'video', attrs: { id: 'v1', source: 'video.youtube', embed: { url, aspectRatio: 16 / 9 }, meta: { title: 'Sample clip' } } } );

/** A published Gamma page: nav links to two of three tall cards, and video nodes still loading. */
function gammaPage( videoNodes: object[], renderedVideos = videoNodes.length ): string {
	const data = { props: { pageProps: { page: { publishedSnapshot: { content: { default: {
		type: 'doc',
		content: [
			{ type: 'card', attrs: { id: 'alpha' }, content: [ { type: 'paragraph', content: [ { type: 'text', text: 'First' } ] } ] },
			{ type: 'card', attrs: { id: 'beta' }, content: [ { type: 'paragraph', content: [ { type: 'text', text: 'Second' } ] }, ...videoNodes ] },
		],
	} } } } } } };
	return `<!doctype html><html><head><style>body{margin:0}.card-wrapper{min-height:1500px}</style></head><body>
		<nav><a href="#card-alpha" data-export-link="https://gamma.app/docs/abc#card-alpha">First</a>
		<a href="#card-beta" data-export-link="https://gamma.app/docs/abc#card-beta">Second</a></nav>
		<div class="ProseMirror">
			<div class="node-card"><div class="card-wrapper" data-card-id="alpha" data-card-scroll-element="true"><p>First</p></div></div>
			<div class="node-card"><div class="card-wrapper" data-card-id="unlinked" data-card-scroll-element="true"><p>Unlinked</p></div></div>
			<div class="node-card"><div class="card-wrapper" data-card-id="beta" data-card-scroll-element="true"><p>Second</p>
				${ `<div class="react-renderer node-video block block-video">${ spinner }</div>`.repeat( renderedVideos ) }
			</div></div>
		</div>
		<script id="__NEXT_DATA__" type="application/json">${ JSON.stringify( data ) }</script>
	</body></html>`;
}

describe( 'gamma platform', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	async function prepared( html: string ) {
		const page = await browser.newPage( { viewport: { width: 1280, height: 800 } } );
		await page.setContent( html );
		await gammaAdapter.liberation!.prepare!( page, { url: 'https://fixture.test/', viewport: 'desktop' } );
		return page;
	}

	it( 'detects a custom domain from Gamma headers and page source', () => {
		expect( detectFromResponse( new Headers( { server: 'gamma' } ), '' ) ).toMatchObject( { platform: 'gamma' } );
		const source = '<link rel="stylesheet" href="https://assets.gammahosted.com/x1/_next/static/chunks/a.css"><script src="https://assets.gammahosted.com/x1/_next/static/chunks/main.js"></script>';
		expect( detectFromResponse( new Headers(), source ).platform ).toBe( 'gamma' );
		expect( detectFromResponse( new Headers(), '<script src="/_next/static/chunks/main.js"></script>' ).platform ).toBe( 'nextjs' );
		expect( resolvePlatform( 'gamma' ) ).toBe( gammaAdapter );
	} );

	it( 'keeps the Next.js cleanup, since Gamma publishes with Next.js', () => {
		expect( gammaAdapter.liberation?.removeSelectors ).toEqual( expect.arrayContaining( nextjsAdapter.liberation!.removeSelectors! ) );
		expect( gammaAdapter.liberation?.removeSelectors ).toContain( '[data-testid="media-placeholder"]' );
		expect( gammaAdapter.liberation?.clientErrorShellSelectors ).toEqual( nextjsAdapter.liberation?.clientErrorShellSelectors );
		expect( gammaAdapter.resolveImageOriginal?.( 'https://site.test/_next/image?url=%2Fphoto.jpg&w=640' ) ).toBe( 'https://site.test/photo.jpg' );
	} );

	it( 'gives each linked card the id its section links name, so they scroll without Gamma', async () => {
		const page = await prepared( gammaPage( [] ) );
		try {
			expect( await page.locator( '#card-beta' ).getAttribute( 'data-card-id' ) ).toBe( 'beta' );
			expect( await page.locator( '[data-card-id="unlinked"]' ).getAttribute( 'id' ) ).toBeNull();
			await page.locator( 'a[href="#card-beta"]' ).click();
			await expect.poll( () => page.evaluate( () => Math.round( scrollY ) ) ).toBeGreaterThan( 1000 );
		} finally { await page.close(); }
	} );

	it( 'keeps an id the card already has and never duplicates an existing target', async () => {
		const html = gammaPage( [] )
			.replace( 'data-card-id="alpha"', 'id="owner-id" data-card-id="alpha"' )
			.replace( '<nav>', '<nav><span id="card-beta"></span>' );
		const page = await prepared( html );
		try {
			expect( await page.locator( '[data-card-id="alpha"]' ).getAttribute( 'id' ) ).toBe( 'owner-id' );
			expect( await page.locator( '[data-card-id="beta"]' ).getAttribute( 'id' ) ).toBeNull();
			expect( await page.locator( '#card-beta' ).count() ).toBe( 1 );
		} finally { await page.close(); }
	} );

	it( 'replaces a loading video node with the embed from the published document', async () => {
		const page = await prepared( gammaPage( [ video( 'https://www.youtube.com/embed/abc123?rel=0' ) ] ) );
		try {
			const frame = page.locator( '.node-video iframe' );
			expect( await frame.getAttribute( 'src' ) ).toBe( 'https://www.youtube.com/embed/abc123?rel=0' );
			expect( await frame.getAttribute( 'title' ) ).toBe( 'Sample clip' );
			expect( await page.locator( '.node-video .chakra-spinner' ).count() ).toBe( 0 );
			const box = await frame.boundingBox();
			expect( box!.width / box!.height ).toBeCloseTo( 16 / 9, 1 );
		} finally { await page.close(); }
	} );

	it( 'turns toggles, nested ones included, into native details that open without Gamma', async () => {
		const toggle = ( open: boolean, title: string, body: string ) =>
			`<div class="react-renderer node-toggle block block-toggle"><div data-node-view-wrapper=""><div class="toggle box-style" data-open="${ open }"><div data-node-view-content=""><div data-node-view-content-inner="toggle">` +
			`<div class="react-renderer node-toggleSummary" contenteditable="false" draggable="true"><div data-node-view-wrapper="" style="white-space:normal"><div class="chakra-text css-18qvlmk" style="display:flex;flex-direction:column;align-items:var(--flex-align)"><button type="button" contenteditable="false" draggable="true" class="chakra-button css-o7zlpc" data-testid="toggle-button"><p class="chakra-text css-c9cz2g"><svg class="svg-inline--fa fa-play"></svg></p></button><div dir="auto" class="themed-heading" style="white-space:pre-wrap;min-width:min(100%, 10em)"><div data-node-view-content-inner="toggleSummary">${ title }</div></div></div></div></div>` +
			`${ body }</div></div></div></div></div>`;
		const html = gammaPage( [] )
			.replace( '<style>', '<style>body{font-size:18px;line-height:28.8px}.themed-heading{font-size:14px;line-height:20px}.block-toggle [data-open="false"] [data-node-view-content-inner="toggle"] > :not(:first-child){display:none}.animatable-on-load-content-parent:not(.animate-has-animated){opacity:0}' )
			.replace( '<p>First</p>', toggle( false, 'Archive <strong>2025</strong>', `<div class="node-smartLayout animatable-on-load-content-parent"><p class="body">Outer body</p></div>${ toggle( false, 'More', '<p class="body">Inner body</p>' ) }` ) + toggle( true, 'Open one', '<p>Shown</p>' ) );
		const page = await prepared( html );
		try {
			expect( await page.locator( '[data-open]' ).count() ).toBe( 0 );
			expect( await page.locator( 'details' ).count() ).toBe( 3 );
			expect( await page.locator( 'details summary' ).allTextContents() ).toEqual( [ 'Archive 2025', 'More', 'Open one' ] );
			expect( await page.locator( 'details button' ).count() ).toBe( 0 );
			const summary = page.locator( 'summary' ).first();
			expect( await summary.getAttribute( 'class' ) ).toBe( 'themed-heading' );
			expect( await summary.evaluate( ( node ) => ( node as HTMLElement ).style.whiteSpace ) ).toBe( 'pre-wrap' );
			// One title line, as tall as Gamma's row: no strut from the 28.8px body line.
			expect( ( await summary.boundingBox() )!.height ).toBe( 20 );
			expect( await summary.locator( 'button, svg, span, .css-18qvlmk, [contenteditable], [draggable], [data-node-view-content]' ).count() ).toBe( 0 );
			expect( await summary.evaluate( ( node ) => ( node as HTMLElement ).style.listStylePosition ) ).toBe( 'outside' );
			expect( await page.locator( 'details details summary' ).textContent() ).toBe( 'More' );
			expect( await page.locator( 'details.box-style' ).count() ).toBe( 3 );
			expect( await page.locator( 'details' ).last().getAttribute( 'open' ) ).toBe( '' );
			const outerBody = page.locator( 'p.body', { hasText: 'Outer body' } );
			expect( await outerBody.isVisible() ).toBe( false );
			await page.locator( 'summary', { hasText: 'Archive' } ).click();
			expect( await outerBody.isVisible() ).toBe( true );
			// Gamma's entrance fade never ran on closed content; it opens fully visible.
			expect( await outerBody.evaluate( ( node ) => getComputedStyle( node.parentElement! ).opacity ) ).toBe( '1' );
			await page.locator( 'summary', { hasText: 'More' } ).click();
			expect( await page.locator( 'p.body', { hasText: 'Inner body' } ).isVisible() ).toBe( true );
		} finally { await page.close(); }
	} );

	it( 'leaves video nodes alone when they cannot be paired with a safe embed', async () => {
		for ( const html of [
			gammaPage( [ video( 'https://www.youtube.com/embed/abc123' ) ], 2 ),
			gammaPage( [ video( 'javascript:alert(1)' ) ] ),
		] ) {
			const page = await prepared( html );
			try {
				expect( await page.locator( '.node-video iframe' ).count() ).toBe( 0 );
				expect( await page.locator( '.node-video .chakra-spinner' ).count() ).toBeGreaterThan( 0 );
			} finally { await page.close(); }
		}
	} );
} );
