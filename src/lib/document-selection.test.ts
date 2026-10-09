import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from 'node:inspector/promises';
import { chromium, devices, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { exportWebsiteCapture } from './capture-export.js';
import { startStaticServer } from './replicate/local-site/static-server.js';
import type { DeviceDocumentSelection } from './document-selection.js';

const directories: string[] = [];
afterAll( () => { if ( ! process.env.DLA_KEEP_DEVICE_EVIDENCE ) for ( const dir of directories ) rmSync( dir, { recursive: true, force: true } ); } );
const selection: DeviceDocumentSelection = {
	kind: 'device', id: 'neutral-request-identity/v1', documents: [ 'desktop', 'mobile', 'tablet' ], defaultDocument: 'desktop',
	rules: [ { userAgent: 'iPad', document: 'tablet' }, { userAgent: 'iPhone', document: 'mobile' } ],
	evidence: 'Fixture server selects an authored document by request UA, independently of width or pointer.',
};
const linkedCss = 'h1{letter-spacing:3px}body.mobile h1{letter-spacing:4px}';
const fixture = ( key: string ) => {
	const width = key === 'mobile' ? 320 : key === 'tablet' ? 980 : undefined;
	return `<!doctype html><html><head><meta charset="utf-8"><meta id="${ key }-viewport" name="viewport" content="${ width ? `width=${ width },user-scalable=yes` : 'width=device-width,initial-scale=1' }"><title>Neutral device source</title><style>:root{font-size:${ key === 'mobile' ? 20 : key === 'tablet' ? 18 : 16 }px}body{margin:0}body.${ key } .canvas{width:${ width ? `${ width }px` : 'max(980px,100vw)' };height:200px;background:${ key === 'mobile' ? 'red' : key === 'tablet' ? 'green' : 'blue' }}h1{font-size:2rem;margin:0}@media(max-width:980px){.canvas{border:0}}</style><link rel="stylesheet" href="/typography.css"></head><body class="${ key }"><main class="canvas" data-fixture-document="${ key }"><h1>${ key } document</h1></main><script>window.sourceOnly=true</script></body></html>`;
};

function directory(): string {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const dir = mkdtempSync( join( parent, 'device-selection-' ) ); directories.push( dir );
	for ( const name of [ 'html', 'html-mobile', 'html-tablet', 'screenshots' ] ) mkdirSync( join( dir, name ) );
	return dir;
}

function exported( dir: string, tablet = true, decorate?: (html: string, key: string) => string ) {
	mkdirSync( join( dir, 'resources' ) );
	writeFileSync( join( dir, 'resources/typography.css' ), linkedCss );
	writeFileSync( join( dir, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources: { 'https://fixture.test/typography.css': { path: 'resources/typography.css', contentType: 'text/css' } }, failures: [] } ) );
	const documentFor = ( key: string ) => decorate ? decorate( fixture( key ), key ) : fixture( key );
	writeFileSync( join( dir, 'html/home.html' ), documentFor( 'desktop' ) );
	writeFileSync( join( dir, 'html-mobile/home.html' ), documentFor( 'mobile' ) );
	if ( tablet ) writeFileSync( join( dir, 'html-tablet/home.html' ), documentFor( 'tablet' ) );
	writeFileSync( join( dir, 'breakpoints.json' ), JSON.stringify( { maxWidth: [ 980 ], minWidth: [ 981 ] } ) );
	writeFileSync( join( dir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://fixture.test/': {
		html: 'html/home.html', profiles: tablet ? { tablet: { html: 'html-tablet/home.html' } } : {},
		fluid: { applied: 1, unmodelled: 0, canvasFloor: 980, breakpoints: [ 981 ], byKind: { floored: 1 } },
	} } } ) );
	exportWebsiteCapture( { outputDir: dir, sourceUrl: 'https://fixture.test/', platform: 'neutral', summary: {}, failures: [], resolveDocumentSelection: () => selection } );
	return readFileSync( join( dir, 'website/index.html' ), 'utf8' );
}

async function observation( page: Page ) {
	return page.evaluate( () => {
		const canvas = [ ...document.querySelectorAll<HTMLElement>( '.canvas' ) ].find( node => node.getClientRects().length );
		const title = canvas?.querySelector( 'h1' );
		return { selected: canvas?.dataset.fixtureDocument, width: canvas?.getBoundingClientRect().width,
			viewport: document.querySelector( 'meta[name="viewport"]' )?.getAttribute( 'content' ),
			innerWidth, fontSize: title ? getComputedStyle( title ).fontSize : undefined,
			letterSpacing: title ? getComputedStyle( title ).letterSpacing : undefined,
			rootFontSize: getComputedStyle( document.documentElement ).fontSize,
			count: document.querySelectorAll( 'meta[name="viewport"]' ).length,
		};
	} );
}

it.each( [ false, true ] )( 'normalizes each distinct captured document once for assembly and evidence (identical: %s)', async ( identical ) => {
	const session = new Session(); session.connect();
	try {
		await session.post( 'Profiler.enable' );
		await session.post( 'Profiler.startPreciseCoverage', { callCount: true, detailed: false } );
		const dir = directory();
		const html = exported( dir, true, document => ( identical ? fixture( 'desktop' ) : document ).replace(
			'</main>', '</main><div data-note="HS-FORM-FRAME">Authored &amp; marker</div><div class="other-hs-form-frame">Not a form frame</div>'
		) );
		const coverage = await session.post( 'Profiler.takePreciseCoverage' );
		await session.post( 'Profiler.stopPreciseCoverage' );
		const normalization = coverage.result
			.filter( script => script.url.endsWith( '/src/lib/capture-export.ts' ) )
			.flatMap( script => script.functions )
			.find( fn => fn.functionName === 'renderedHtml' );
		expect( normalization ).toBeDefined();
		// Measure the actual export owner, without replacing its parser or I/O.
		// Desktop/mobile previously ran twice while tablet ran once.
		expect( normalization!.ranges[ 0 ].count ).toBe( identical ? 1 : 3 );
		const $ = cheerio.load( html );
		expect( $( '[data-dla-document-scope]' ).toArray().map( node => node.attribs['data-dla-device-document'] ) ).toEqual( [ 'desktop', 'mobile', 'tablet' ] );
		for ( const key of selection.documents ) expect( $( `[data-dla-device-document="${ key }"]` ).text() ).toContain( `${ identical ? 'desktop' : key } document` );
		expect( $( '[data-note="HS-FORM-FRAME"]' ) ).toHaveLength( 3 );
		expect( $( '.other-hs-form-frame' ) ).toHaveLength( 3 );
		expect( html ).toContain( 'Authored &amp; marker' );
		expect( $( 'iframe[src*="hsforms"]' ) ).toHaveLength( 0 );
		expect( $( 'html' ) ).toHaveLength( 1 );
		expect( $( 'body' ) ).toHaveLength( 1 );
		expect( html ).not.toContain( 'sourceOnly' );
		expect( JSON.parse( readFileSync( join( dir, 'source-profile.json' ), 'utf8' ) ) ).toMatchObject( { documentsPerRoute: 3, documentSelection: { kind: 'device' } } );
	} finally { session.disconnect(); }
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'portable source-owned document selection', () => {
	it( 'preserves class-only body box styling on the real selected body', async () => {
		const decorate = ( html: string, key: string ) => {
			const $ = cheerio.load( html );
			const index = [ 'desktop', 'mobile', 'tablet' ].indexOf( key );
			$( 'body' ).addClass( `body-identity-${ key }` );
			$( 'head' ).append( `<style>@media screen{.body-identity-${ key }{margin:${ 11 + index * 7 }px;background:rgb(${ 20 + index * 30 },40,60);padding:3px;overflow-x:hidden}.body-identity-${ key } .canvas{color:rgb(70,80,90)}}</style>` );
			return $.html();
		};
		const dir = directory(); exported( dir, true, decorate );
		const site = await startStaticServer( join( dir, 'website' ) );
		const browser = await chromium.launch();
		try {
			for ( const [ key, userAgent ] of [ [ 'desktop', 'NeutralDesktop' ], [ 'mobile', 'Neutral iPhone' ], [ 'tablet', 'Neutral iPad' ] ] ) {
				const page = await browser.newPage( { userAgent, viewport: { width: 1440, height: 900 } } );
				const read = () => page.evaluate( () => {
					const style = getComputedStyle( document.body );
					const canvas = Array.from( document.querySelectorAll<HTMLElement>( '.canvas' ) ).find( node => node.getClientRects().length )!;
					return { margin: style.margin, padding: style.padding, background: style.backgroundColor, overflowX: style.overflowX,
						x: canvas.getBoundingClientRect().x, y: canvas.getBoundingClientRect().y, color: getComputedStyle( canvas ).color };
				} );
				await page.setContent( decorate( fixture( key ), key ) );
				const expected = await read();
				await page.goto( site.url );
				expect.soft( await read(), key ).toEqual( expected );
				await page.context().close();
			}
		} finally { await browser.close(); await site.close(); }
	}, 60_000 );

	it( 'renders the default document where the selection runtime never runs', async () => {
		const dir = directory(); const html = exported( dir );
		const visibility = cheerio.load( html )( 'style[data-dla-device-visibility]' ).text();
		expect( visibility ).toContain( `html:not([data-dla-selected-document]) [data-dla-device-document="${ selection.defaultDocument }"]{display:contents!important}` );
		const site = await startStaticServer( join( dir, 'website' ) );
		const browser = await chromium.launch();
		try {
			// The block editor canvas renders this markup without the selection
			// runtime, so nothing ever sets data-dla-selected-document. Disabling
			// scripts reproduces that consumer without depending on WordPress.
			const context = await browser.newContext( { javaScriptEnabled: false, viewport: { width: 1440, height: 900 } } );
			const page = await context.newPage();
			await page.goto( site.url );
			const seen = await page.evaluate( () => ( {
				selected: document.documentElement.getAttribute( 'data-dla-selected-document' ),
				displays: Object.fromEntries( [ ...document.querySelectorAll<HTMLElement>( '[data-dla-device-document]' ) ]
					.map( node => [ node.getAttribute( 'data-dla-device-document' ), getComputedStyle( node ).display ] ) ),
				canvas: [ ...document.querySelectorAll<HTMLElement>( '.canvas' ) ].find( node => node.getClientRects().length )?.dataset.fixtureDocument,
				painted: document.body.scrollHeight,
			} ) );
			expect( seen.selected ).toBeNull();
			expect( seen.displays ).toEqual( Object.fromEntries( selection.documents.map( key =>
				[ key, key === selection.defaultDocument ? 'contents' : 'none' ] ) ) );
			expect( seen.canvas ).toBe( selection.defaultDocument );
			expect( seen.painted ).toBeGreaterThan( 0 );
			await context.close();
		} finally { await browser.close(); await site.close(); }
	}, 60_000 );

	it( 'selects three request identities on static hosting before paint and keeps identity through resize', async () => {
		const dir = directory(); const html = exported( dir );
		const serialized = cheerio.load( html );
		expect( serialized( 'meta[name="viewport"]' ) ).toHaveLength( 1 );
		expect( serialized( 'meta[name="viewport"]' ).attr( 'data-dla-selected-viewport' ) ).toBeDefined();
		const visibility = serialized( 'style[data-dla-device-visibility]' ).text();
		for ( const key of selection.documents ) expect( visibility ).toContain( `html[data-dla-selected-document="${ key }"] [data-dla-device-document="${ key }"]{display:contents!important}` );
		const selector = serialized( 'script[data-dla-device-selection]' ).text();
		expect( selector ).not.toMatch( /appendChild|insertBefore|createElement\(['"](?:meta|style|script)['"]\)|new\s+URL|\.src\s*=/ );
		expect( html ).not.toContain( 'sourceOnly' );
		expect( html ).not.toContain( '@media(max-width:980px){.data-liberation-desktop-document' );
		const profile = JSON.parse( readFileSync( join( dir, 'source-profile.json' ), 'utf8' ) );
		expect( profile ).toMatchObject( { documentsPerRoute: 3, switchWidth: null, switchWidthSource: 'not-applicable', documentSelection: { kind: 'device' } } );
		expect( JSON.parse( readFileSync( join( dir, 'capture-receipt.json' ), 'utf8' ) ).document_scope_classes ).toContain( 'data-liberation-tablet-document' );
		const scopes = cheerio.load( html )( '[data-dla-document-scope]' );
		expect( scopes ).toHaveLength( 3 );
		expect( scopes.toArray().map( node => node.attribs['data-dla-device-document'] ) ).toEqual( [ 'desktop', 'mobile', 'tablet' ] );
		const staticSite = await startStaticServer( join( dir, 'website' ) );
		const source = createServer( ( req, res ) => {
			if ( req.url === '/typography.css' ) { res.setHeader( 'content-type', 'text/css' ); res.end( linkedCss ); return; }
			res.setHeader( 'content-type', 'text/html' ); res.end( fixture( /iPad/.test( req.headers['user-agent'] ?? '' ) ? 'tablet' : /iPhone/.test( req.headers['user-agent'] ?? '' ) ? 'mobile' : 'desktop' ) );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }`;
		const browser = await chromium.launch();
		const { defaultBrowserType: _iphoneType, ...iphone } = devices['iPhone 17'];
		const { defaultBrowserType: _ipadType, ...ipad } = devices['iPad (gen 7)'];
		const cases = [
			{ key: 'desktop', options: { userAgent: 'NeutralDesktop', isMobile: false, hasTouch: false }, widths: [ 390, 768, 980, 981, 1440 ] },
			{ key: 'desktop', options: { userAgent: 'NeutralDesktop', isMobile: false, hasTouch: true }, widths: [ 768 ] },
			{ key: 'mobile', options: iphone, widths: [ 768, 1440 ] },
			{ key: 'tablet', options: ipad, widths: [ 768, 1440 ] },
		];
		const rows = [];
		try {
			for ( const test of cases ) for ( const width of test.widths ) {
				const context = await browser.newContext( { ...test.options, viewport: { width, height: 900 } } );
				await context.addInitScript( () => {
					const frames: unknown[] = []; ( window as unknown as { framesProof: unknown[] } ).framesProof = frames;
					function observeFrame() {
						const node = [ ...document.querySelectorAll<HTMLElement>( '.canvas' ) ].find( element => element.getClientRects().length );
						if ( node ) frames.push( { selected: node.dataset.fixtureDocument, innerWidth, width: node.getBoundingClientRect().width, viewport: document.querySelector( 'meta[name="viewport"]' )?.getAttribute( 'content' ), letterSpacing: getComputedStyle( node.querySelector( 'h1' )! ).letterSpacing } );
						if ( frames.length < 3 ) requestAnimationFrame( observeFrame );
					}
					requestAnimationFrame( observeFrame );
				} );
				const page = await context.newPage();
				await page.goto( origin ); const expected = await observation( page );
				await page.goto( staticSite.url, { waitUntil: 'load' } );
				const actual = await observation( page );
				expect( actual ).toEqual( expected );
				expect( actual.selected ).toBe( test.key ); expect( actual.count ).toBe( 1 );
				await page.waitForFunction( () => ( window as unknown as { framesProof: unknown[] } ).framesProof.length >= 3 );
				const frames = await page.evaluate( () => ( window as unknown as { framesProof: Array<{selected: string; innerWidth: number; width: number; viewport: string}> } ).framesProof );
				for ( const frame of frames ) expect( frame ).toMatchObject( { selected: test.key, innerWidth: actual.innerWidth, width: actual.width, viewport: actual.viewport, letterSpacing: actual.letterSpacing } );
				if ( test.key === 'mobile' ) expect( actual.innerWidth ).toBe( 320 );
				if ( test.key === 'desktop' ) expect( actual.width ).toBe( Math.max( 980, width ) );
				if ( test.options.hasTouch && test.key === 'desktop' ) expect( await page.evaluate( () => matchMedia( '(pointer:coarse)' ).matches ) ).toBe( true );
				await page.setViewportSize( { width: 500, height: 900 } );
				expect( ( await observation( page ) ).selected ).toBe( test.key );
				if ( test.key === 'mobile' ) expect( ( await observation( page ) ).innerWidth ).toBe( 320 );
				if ( process.env.DLA_KEEP_DEVICE_EVIDENCE ) await page.screenshot( { path: join( dir, `${ test.key }-${ width }-${ test.options.hasTouch }.png` ) } );
				rows.push( { key: test.key, requested: width, hasTouch: test.options.hasTouch, actual, frames } );
				await context.close();
			}
			writeFileSync( join( dir, 'browser-proof.json' ), JSON.stringify( rows, null, 2 ) );
		} finally { await browser.close(); await staticSite.close(); await new Promise<void>( resolve => source.close( () => resolve() ) ); }
	}, 60_000 );

	it( 'overlays source root ownership in a host document before paint and retains authored media provenance', async () => {
		const dir = directory();
		const keys = [ 'desktop', 'mobile', 'tablet' ];
		const html = exported( dir, true, ( document, key ) => {
			const $ = cheerio.load( document );
			$( 'html' ).attr( 'class', `source-html-shared source-html-${ key }` ).attr( 'style',
				`--source-mode:${ key };--${ key }-html-only:${ key };${ key === 'tablet' ? '' : `color:rgb(11,22,33)${ key === 'mobile' ? '!important' : '' };` }` );
			$( 'body' ).addClass( 'source-body-shared' ).attr( 'style', `--source-body-mode:${ key };--${ key }-body-only:${ key }` );
			$( 'style' ).attr( 'media', 'screen' );
			$( 'link[rel="stylesheet"]' ).attr( 'media', 'screen and (min-width: 0px), print' );
			return $.html();
		} );
		const $ = cheerio.load( html );
		// Neutral embedding shell: stale source tokens coexist with unrelated
		// host state before DLA's synchronous head/body scripts execute.
		$( 'html' ).attr( 'class', `host-html source-html-shared ${ keys.map( key => `source-html-${ key }` ).join( ' ' ) }` ).attr( 'style',
			`--HostTheme:stable!important;isolation:isolate;--source-mode:stale;color:red;${ keys.map( key => `--${ key }-html-only:stale;` ).join( '' ) }` );
		$( 'body' ).attr( 'class', `host-body source-body-shared ${ keys.join( ' ' ) }` ).attr( 'style',
			`--host-surface:anchored!important;outline-offset:7px;--source-body-mode:stale;${ keys.map( key => `--${ key }-body-only:stale;` ).join( '' ) }` );
		for ( const node of $( '[data-dla-device-style]' ).toArray() ) {
			expect( $( node ).attr( 'media' ) ).toBe( 'not all' );
			expect( $( node ).attr( 'data-dla-source-media' ) ).toBe( node.name === 'link' ? 'screen and (min-width: 0px), print' : 'screen' );
		}
		const snapshot = `<script data-neutral-embedding-proof>function embeddingSnapshot(){
function root(node,kind){return {classes:Array.from(node.classList),host:node.style.getPropertyValue(kind==='html'?'--HostTheme':'--host-surface'),hostPriority:node.style.getPropertyPriority(kind==='html'?'--HostTheme':'--host-surface'),other:node.style.getPropertyValue(kind==='html'?'isolation':'outline-offset'),source:node.style.getPropertyValue(kind==='html'?'--source-mode':'--source-body-mode'),color:node.style.getPropertyValue('color'),colorPriority:node.style.getPropertyPriority('color'),exclusive:['desktop','mobile','tablet'].map(function(key){return node.style.getPropertyValue('--'+key+'-'+kind+'-only');})};}
return {selected:document.documentElement.getAttribute('data-dla-selected-document'),html:root(document.documentElement,'html'),body:root(document.body,'body'),viewport:document.querySelector('meta[name="viewport"]').content,innerWidth:innerWidth,letterSpacing:getComputedStyle(document.querySelector('[data-dla-device-document="'+document.documentElement.getAttribute('data-dla-selected-document')+'"] h1')).letterSpacing};}
window.embeddingBeforeFrame=embeddingSnapshot();window.embeddingFrames=[];function frame(){window.embeddingFrames.push(embeddingSnapshot());if(window.embeddingFrames.length<3)requestAnimationFrame(frame);}requestAnimationFrame(frame);</script>`;
		// A parser-time consumer probe, after the selected roots and trees exist;
		// it neither supplies nor repairs selection/viewport/host state.
		$( 'body' ).append( snapshot );
		writeFileSync( join( dir, 'website/index.html' ), $.html() );
		const site = await startStaticServer( join( dir, 'website' ) ); const browser = await chromium.launch();
		const { defaultBrowserType: _iphone, ...iphone } = devices['iPhone 17'];
		const { defaultBrowserType: _ipad, ...ipad } = devices['iPad (gen 7)'];
		const rows = [];
		try {
			for ( const item of [ { key: 'desktop', options: { userAgent: 'NeutralDesktop', hasTouch: true } }, { key: 'mobile', options: iphone }, { key: 'tablet', options: ipad } ] ) {
				const page = await browser.newPage( { ...item.options, viewport: { width: 1440, height: 900 } } );
				await page.goto( site.url );
				await page.waitForFunction( () => ( window as unknown as { embeddingFrames: unknown[] } ).embeddingFrames.length === 3 );
				const proof = await page.evaluate( () => {
					const windowProof = window as unknown as { embeddingBeforeFrame: unknown; embeddingFrames: unknown[] };
					return { before: windowProof.embeddingBeforeFrame, frames: windowProof.embeddingFrames };
				} ) as { before: any; frames: any[] };
				for ( const state of [ proof.before, ...proof.frames ] ) {
					expect( state.selected ).toBe( item.key );
					expect( state.html.classes.sort() ).toEqual( [ 'host-html', 'source-html-shared', `source-html-${ item.key }` ].sort() );
					expect( state.body.classes.sort() ).toEqual( [ 'host-body', 'source-body-shared', item.key ].sort() );
					expect( state.html ).toMatchObject( { host: 'stable', hostPriority: 'important', other: 'isolate', source: item.key,
						color: item.key === 'tablet' ? '' : 'rgb(11, 22, 33)', colorPriority: item.key === 'mobile' ? 'important' : '' } );
					expect( state.body ).toMatchObject( { host: 'anchored', hostPriority: 'important', other: '7px', source: item.key } );
					expect( state.html.exclusive ).toEqual( keys.map( key => key === item.key ? item.key : '' ) );
					expect( state.body.exclusive ).toEqual( keys.map( key => key === item.key ? item.key : '' ) );
					expect( state.viewport ).toBe( item.key === 'mobile' ? 'width=320,user-scalable=yes' : item.key === 'tablet' ? 'width=980,user-scalable=yes' : 'width=device-width,initial-scale=1' );
					if ( item.key === 'mobile' ) expect( state.innerWidth ).toBe( 320 );
				}
				// The selected linked sheet blocks rendering, not later parser-time
				// scripts: every painted frame carries its typography.
				for ( const state of proof.frames ) expect( state.letterSpacing ).toBe( item.key === 'mobile' ? '4px' : '3px' );
				const activeMedia = await page.locator( 'link[data-dla-source-media]:not([data-dla-device-style])' ).evaluateAll( nodes => nodes.map( node => ( { media: node.getAttribute( 'media' ), source: node.getAttribute( 'data-dla-source-media' ) } ) ) );
				expect( activeMedia ).toEqual( [ { media: 'screen and (min-width: 0px), print', source: 'screen and (min-width: 0px), print' } ] );
				expect( await page.locator( '[data-dla-document-scope]' ).count() ).toBe( 3 );
				rows.push( { profile: item.key, ...proof, activeMedia } );
				await page.context().close();
			}
			writeFileSync( join( dir, 'embedding-proof.json' ), JSON.stringify( rows, null, 2 ) );
		} finally { await browser.close(); await site.close(); }
	}, 60_000 );

	it( 'marks a single device document boundary without manufacturing another identity', async () => {
		const dir = directory();
		writeFileSync( join( dir, 'html/home.html' ), fixture( 'desktop' ) );
		writeFileSync( join( dir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://fixture.test/': { html: 'html/home.html' } } } ) );
		exportWebsiteCapture( { outputDir: dir, sourceUrl: 'https://fixture.test/', platform: 'neutral', summary: {}, failures: [], resolveDocumentSelection: () => ( { ...selection, documents: [ 'desktop' ], rules: [] } ) } );
		const $ = cheerio.load( readFileSync( join( dir, 'website/index.html' ), 'utf8' ) );
		expect( $( '[data-dla-document-scope]' ) ).toHaveLength( 1 );
		expect( $( '[data-dla-device-document]' ).attr( 'data-dla-device-document' ) ).toBe( 'desktop' );
		expect( $( '[data-dla-device-unavailable]' ) ).toHaveLength( 0 );
	} );

	it( 'emits the relocated declared stylesheet without constructing another asset reference', async () => {
		const dir = directory(); const html = exported( dir ); const $ = cheerio.load( html );
		mkdirSync( join( dir, 'website/relocated' ) );
		writeFileSync( join( dir, 'website/relocated/source.css' ), linkedCss );
		$( 'link[data-dla-device-style]' ).attr( 'href', '/relocated/source.css' );
		writeFileSync( join( dir, 'website/index.html' ), $.html() );
		const site = await startStaticServer( join( dir, 'website' ) ); const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { userAgent: 'NeutralDesktop', viewport: { width: 768, height: 900 } } );
			await page.goto( site.url );
			expect( ( await observation( page ) ).letterSpacing ).toBe( '3px' );
			const active = page.locator( 'link[data-dla-source-media]:not([data-dla-device-style])' );
			expect( await active.count() ).toBe( 1 );
			expect( await active.getAttribute( 'href' ) ).toBe( '/relocated/source.css' );
			expect( await active.getAttribute( 'media' ) ).toBe( 'all' );
			expect( await active.getAttribute( 'data-dla-source-media' ) ).toBe( 'all' );
		} finally { await browser.close(); await site.close(); }
	} );

	it( 'exposes an uncaptured tablet without substituting a phone or desktop tree', async () => {
		const dir = directory(); exported( dir, false );
		const receipt = JSON.parse( readFileSync( join( dir, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.sourceProfile.documentSelection.routes[ 0 ].missing ).toEqual( [ 'tablet' ] );
		const site = await startStaticServer( join( dir, 'website' ) ); const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { userAgent: 'Neutral iPad' } ); await page.goto( site.url );
			expect( ( await observation( page ) ).selected ).toBeUndefined();
			expect( await page.locator( '[data-dla-device-unavailable]' ).isVisible() ).toBe( true );
			expect( await page.locator( 'html' ).getAttribute( 'data-dla-document-unavailable' ) ).toBe( 'tablet' );
			expect( await page.locator( 'meta[name="viewport"]' ).count() ).toBe( 1 );
			expect( await page.locator( 'meta[name="viewport"]' ).getAttribute( 'content' ) ).toBeNull();
		} finally { await browser.close(); await site.close(); }
	} );

	it( 'activates every route\'s ordered device styles from one document runtime before paint', async () => {
		// Neutral multi-route, multi-style source: equal-specificity inline rules and
		// linked sheets only resolve correctly in document order, and media-scoped
		// styles keep their authored conditions.
		const keys = [ 'desktop', 'mobile', 'tablet' ];
		const routes = [ { url: 'https://fixture.test/', file: 'home', path: '' }, { url: 'https://fixture.test/menu/', file: 'menu', path: 'menu/' } ];
		const sheets: Record<string, string> = { '/base.css': '.card{margin:5px}h1{font-size:30px}', '/wide.css': '.card{margin:9px;background-color:rgb(1,2,3)}h1{letter-spacing:2px}' };
		const source = ( key: string, route: string ) => {
			const index = keys.indexOf( key ); const width = key === 'mobile' ? 320 : key === 'tablet' ? 980 : undefined;
			return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="${ width ? `width=${ width }` : 'width=device-width,initial-scale=1' }"><title>${ route }</title>` +
				`<style>h1{color:rgb(200,0,0);margin:0}</style><link rel="stylesheet" href="/base.css"><style>h1{color:rgb(${ index * 40 },${ route === 'menu' ? 90 : 60 },0)}</style>` +
				`<link rel="stylesheet" href="/wide.css" media="(min-width: 700px)"><style media="(max-width: 699px)">.card{padding:${ 3 + index }px}</style>` +
				`<style>.card{border:${ index + 1 }px solid rgb(0,0,${ route === 'menu' ? 150 : 100 })}</style></head>` +
				`<body class="${ key }"><main class="canvas" data-fixture-document="${ key }"><h1>${ key } ${ route }</h1><p class="card">${ route }</p></main></body></html>`;
		};
		const dir = directory();
		mkdirSync( join( dir, 'resources' ) );
		for ( const [ path, css ] of Object.entries( sheets ) ) writeFileSync( join( dir, `resources${ path }` ), css );
		writeFileSync( join( dir, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources: Object.fromEntries( Object.keys( sheets ).map( path => [ `https://fixture.test${ path }`, { path: `resources${ path }`, contentType: 'text/css' } ] ) ) } ) );
		const entries: Record<string, unknown> = {};
		for ( const route of routes ) {
			writeFileSync( join( dir, `html/${ route.file }.html` ), source( 'desktop', route.file ) );
			writeFileSync( join( dir, `html-mobile/${ route.file }.html` ), source( 'mobile', route.file ) );
			writeFileSync( join( dir, `html-tablet/${ route.file }.html` ), source( 'tablet', route.file ) );
			entries[ route.url ] = { html: `html/${ route.file }.html`, profiles: { tablet: { html: `html-tablet/${ route.file }.html` } } };
		}
		writeFileSync( join( dir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		exportWebsiteCapture( { outputDir: dir, sourceUrl: 'https://fixture.test/', platform: 'neutral', summary: {}, failures: [], resolveDocumentSelection: () => selection } );

		const counts = routes.map( route => {
			const $ = cheerio.load( readFileSync( join( dir, 'website', route.path, 'index.html' ), 'utf8' ) );
			return { route: route.file, deviceStyles: $( '[data-dla-device-style]' ).length, runtimes: $( 'script[data-dla-device-selection]' ).length,
				activators: $( 'script[data-dla-device-styles]' ).length, documentWrites: $( 'script' ).toArray().filter( node => /document\.write/.test( $( node ).text() ) ).length };
		} );
		writeFileSync( join( dir, 'device-style-counts.json' ), JSON.stringify( counts, null, 2 ) );
		expect( counts ).toEqual( routes.map( route => ( { route: route.file, deviceStyles: keys.length * 6, runtimes: 1, activators: 0, documentWrites: 0 } ) ) );

		const origin = createServer( ( request, response ) => {
			const [ path ] = ( request.url ?? '/' ).split( '?' );
			if ( sheets[ path ] ) { response.setHeader( 'content-type', 'text/css' ); response.end( sheets[ path ] ); return; }
			const userAgent = request.headers[ 'user-agent' ] ?? '';
			response.setHeader( 'content-type', 'text/html' );
			response.end( source( /iPad/.test( userAgent ) ? 'tablet' : /iPhone/.test( userAgent ) ? 'mobile' : 'desktop', path.startsWith( '/menu' ) ? 'menu' : 'home' ) );
		} );
		await new Promise<void>( resolve => origin.listen( 0, '127.0.0.1', resolve ) );
		const originUrl = `http://127.0.0.1:${ ( origin.address() as { port: number } ).port }/`;
		const site = await startStaticServer( join( dir, 'website' ) ); const siteUrl = site.url.replace( /\/?$/, '/' );
		const browser = await chromium.launch();
		const { defaultBrowserType: _phoneType, ...phone } = devices['iPhone 17'];
		const { defaultBrowserType: _tabletType, ...tablet } = devices['iPad (gen 7)'];
		const profiles = [ { key: 'desktop', options: { userAgent: 'NeutralDesktop' }, widths: [ 390, 1440 ] }, { key: 'mobile', options: phone, widths: [ 390 ] }, { key: 'tablet', options: tablet, widths: [ 768 ] } ];
		const rows = [];
		try {
			for ( const profile of profiles ) for ( const width of profile.widths ) for ( const route of routes ) {
				const context = await browser.newContext( { ...profile.options, viewport: { width, height: 900 } } );
				// Slow stylesheets prove the selected sheets block first paint.
				await context.route( '**/*', async request => {
					if ( request.request().resourceType() === 'stylesheet' ) await new Promise( resolve => setTimeout( resolve, 300 ) );
					await request.continue();
				} );
				await context.addInitScript( () => {
					const read = () => {
						const canvas = [ ...document.querySelectorAll<HTMLElement>( '.canvas' ) ].find( node => node.getClientRects().length );
						if ( ! canvas ) return undefined;
						const title = getComputedStyle( canvas.querySelector( 'h1' )! ), card = getComputedStyle( canvas.querySelector( '.card' )! );
						return { selected: canvas.dataset.fixtureDocument, innerWidth, color: title.color, fontSize: title.fontSize, letterSpacing: title.letterSpacing,
							margin: card.margin, padding: card.padding, border: card.borderTop, background: card.backgroundColor };
					};
					const frames: unknown[] = []; Object.assign( window, { readDeviceStyles: read, deviceStyleFrames: frames } );
					const frame = () => { const state = read(); if ( state ) frames.push( state ); if ( frames.length < 3 ) requestAnimationFrame( frame ); };
					requestAnimationFrame( frame );
				} );
				const page = await context.newPage();
				const settled = () => page.evaluate( () => ( window as unknown as { readDeviceStyles: () => unknown } ).readDeviceStyles() );
				await page.goto( originUrl + route.path, { waitUntil: 'load' } ); const expected = await settled();
				await page.goto( siteUrl + route.path, { waitUntil: 'load' } );
				await page.waitForFunction( () => ( window as unknown as { deviceStyleFrames: unknown[] } ).deviceStyleFrames.length >= 3 );
				const actual = await settled();
				const frames = await page.evaluate( () => ( window as unknown as { deviceStyleFrames: unknown[] } ).deviceStyleFrames );
				const media = await page.evaluate( () => [ ...document.querySelectorAll( '[data-dla-source-media]' ) ].map( node => ( {
					device: node.getAttribute( 'data-dla-device-style' ), media: node.getAttribute( 'media' ), source: node.getAttribute( 'data-dla-source-media' ) } ) ) );
				expect( actual ).toEqual( expected );
				expect( ( actual as { selected: string } ).selected ).toBe( profile.key );
				for ( const state of frames ) expect( state ).toEqual( actual );
				// Each selected style is active once, directly after its inert declaration; all others stay inert.
				const declared = media.filter( node => node.device );
				expect( declared.every( node => node.media === 'not all' ) ).toBe( true );
				const active = media.filter( node => ! node.device );
				expect( active ).toEqual( declared.filter( node => node.device === profile.key ).map( node => ( { device: null, media: node.source, source: node.source } ) ) );
				rows.push( { profile: profile.key, width, route: route.file, actual } );
				await context.close();
			}
			const context = await browser.newContext( { javaScriptEnabled: false, viewport: { width: 1440, height: 900 } } );
			const page = await context.newPage();
			for ( const route of routes ) {
				await page.goto( siteUrl + route.path );
				expect( await page.evaluate( () => ( {
					inert: [ ...document.querySelectorAll( '[data-dla-device-style]' ) ].every( node => node.getAttribute( 'media' ) === 'not all' ),
					activated: document.querySelectorAll( '[data-dla-source-media]:not([data-dla-device-style])' ).length,
					color: getComputedStyle( document.querySelector( '[data-dla-device-document="desktop"] h1' )! ).color,
				} ) ) ).toEqual( { inert: true, activated: 0, color: 'rgb(0, 0, 0)' } );
			}
			await context.close();
			writeFileSync( join( dir, 'device-style-proof.json' ), JSON.stringify( rows, null, 2 ) );
		} finally { await browser.close(); await site.close(); await new Promise<void>( resolve => origin.close( () => resolve() ) ); }
	}, 120_000 );

	it( 'retains a source-declared width transition at 800 despite a 980 geometry floor', async () => {
		const dir = directory();
		const widthDocument = ( key: string ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.canvas{width:max(980px,100vw);height:200px}@media(max-width:980px){h1{color:blue}}</style></head><body><${ key === 'narrow' ? 'article' : 'main' } class="canvas" data-fixture-document="${ key }"><h1>${ key }</h1>${ key === 'narrow' ? '<aside>Narrow navigation</aside>' : '' }</${ key === 'narrow' ? 'article' : 'main' }></body></html>`;
		writeFileSync( join( dir, 'html/home.html' ), widthDocument( 'wide' ) ); writeFileSync( join( dir, 'html-mobile/home.html' ), widthDocument( 'narrow' ) );
		writeFileSync( join( dir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://fixture.test/': { html: 'html/home.html', fluid: { canvasFloor: 980, applied: 1, unmodelled: 0, breakpoints: [], byKind: {} } } } } ) );
		exportWebsiteCapture( { outputDir: dir, sourceUrl: 'https://fixture.test/', platform: 'neutral', summary: {}, failures: [], resolveDocumentSelection: () => ( { kind: 'width', switchWidth: 800, evidence: 'Fixture changes its tree at matchMedia(max-width:800px) within the same request identity' } ) } );
		expect( JSON.parse( readFileSync( join( dir, 'source-profile.json' ), 'utf8' ) ) ).toMatchObject( { switchWidth: 800, switchWidthSource: 'observed', documentSelection: { kind: 'width' } } );
		const source = createServer( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			const body = ( key: string ) => widthDocument( key ).match( /<body>([\s\S]*)<\/body>/ )![ 1 ];
			response.end( widthDocument( 'wide' ).replace( '</body>', `<script>var query=matchMedia('(max-width:800px)');function render(){document.body.innerHTML=query.matches?${ JSON.stringify( body( 'narrow' ) ) }:${ JSON.stringify( body( 'wide' ) ) };}query.addEventListener('change',render);render();</script></body>` ) );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }`;
		const site = await startStaticServer( join( dir, 'website' ) ); const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { userAgent: 'NeutralDesktop', viewport: { width: 800, height: 900 } } );
			for ( const url of [ origin, site.url ] ) {
				await page.setViewportSize( { width: 800, height: 900 } );
				await page.goto( url ); expect( ( await observation( page ) ).selected ).toBe( 'narrow' );
				await page.setViewportSize( { width: 801, height: 900 } );
				await page.waitForFunction( () => [ ...document.querySelectorAll<HTMLElement>( '.canvas' ) ].some( node => node.dataset.fixtureDocument === 'wide' && node.getClientRects().length ) );
				expect( ( await observation( page ) ).selected ).toBe( 'wide' );
				await page.setViewportSize( { width: 900, height: 900 } ); expect( ( await observation( page ) ).selected ).toBe( 'wide' );
			}
			const phoneUA = await browser.newPage( { userAgent: devices['iPhone 17'].userAgent, viewport: { width: 900, height: 900 } } );
			await phoneUA.goto( site.url );
			expect( ( await observation( phoneUA ) ).selected ).toBe( 'wide' );
			expect( await phoneUA.locator( 'html' ).getAttribute( 'data-dla-selected-document' ) ).toBeNull();
		} finally { await browser.close(); await site.close(); await new Promise<void>( resolve => source.close( () => resolve() ) ); }
	} );
} );
