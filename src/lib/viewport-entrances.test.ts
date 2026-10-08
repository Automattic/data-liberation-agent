import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { observeViewportEntrances, stampViewportEntrances } from './viewport-entrances.js';
import { exportWebsiteCapture } from './capture-export.js';
import { triggerLazyLoad } from './screenshot/page-helpers.js';
import { startStaticServer } from './replicate/local-site/static-server.js';
import { checkMotion } from './fidelity/rendered-contract-checks.js';
import { observePage, checkFidelity } from './fidelity/check.js';
import { createReferenceCollector } from './fidelity/reference.js';

const fixture = ( repeat: boolean ) => `<!doctype html><html><head><style>
body{margin:0} .spacer{height:1800px} .entrance{height:120px;opacity:0;transform:translateY(26px);transition:opacity .9s cubic-bezier(.22,1,.36,1),transform .9s cubic-bezier(.22,1,.36,1);transition-delay:180ms}
.entrance[data-active="true"]{opacity:1;transform:none} button{transition:background-color .2s} button:hover{background-color:red}
.ambient{width:100px;animation:drift 2s infinite}@keyframes drift{to{transform:translateX(3px)}}
@media(prefers-reduced-motion:reduce){.entrance{opacity:1;transform:none;transition:none}}
</style></head><body><button>Hover</button><div class="ambient">Ambient</div><div class="spacer"></div>
<section class="entrance" data-active="false">Viewport entrance</section><div class="spacer"></div><script>
setTimeout(()=>{const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){entry.target.dataset.active='true';${ repeat ? '' : 'observer.unobserve(entry.target);' }}${ repeat ? "else entry.target.dataset.active='false';" : '' }}},{rootMargin:'0px 0px -10% 0px',threshold:.2});observer.observe(document.querySelector('.entrance'));window.fixtureReady=true;},100);
</script></body></html>`;

async function pose( page: Page ) {
	return page.locator( '.entrance' ).evaluate( element => {
		const style = getComputedStyle( element );
		return { opacity: style.opacity, transform: style.transform, active: element.getAttribute( 'data-active' ) };
	} );
}

describe( 'source-observed viewport transition entrances', () => {
	for ( const repeat of [ false, true ] ) it.skipIf( process.env.SKIP_BROWSER_TESTS )(
		`captures and exports real timed viewport transitions (${ repeat ? 'repeating' : 'one-shot' })`, async () => {
		const browser = await chromium.launch( { headless: true } );
		const directory = mkdtempSync( join( tmpdir(), 'dla-viewport-entrances-' ) );
		let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
		try {
			const source = await browser.newPage( { viewport: { width: 1024, height: 700 } } );
			await source.addInitScript( observeViewportEntrances );
			await source.goto( `data:text/html,${ encodeURIComponent( fixture( repeat ) ) }` );
			await source.waitForFunction( () => ( window as typeof window & { fixtureReady?: boolean } ).fixtureReady );
			expect( ( await pose( source ) ).opacity ).toBe( '0' );
			await triggerLazyLoad( source );
			await stampViewportEntrances( source );
			const evidence = await source.locator( '.entrance' ).getAttribute( 'data-dla-viewport-entrance' );
			expect( JSON.parse( evidence! ) ).toMatchObject( { repeat, rootMargin: '0px 0px -10% 0px', attributes: { 'data-active': { before: 'false', after: 'true' } } } );
			expect( JSON.parse( evidence! ).threshold[ 0 ] ).toBeCloseTo( 0.2 );
			for ( const path of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, path ) );
			writeFileSync( join( directory, 'html/home.html' ), await source.content() );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://fixture.test/': { html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: 'https://fixture.test/', platform: 'generic', summary: {}, failures: [] } );
			const html = readFileSync( join( directory, 'website/index.html' ), 'utf8' );
			expect( html ).not.toContain( 'window.fixtureReady' );
			expect( html ).toContain( 'data-dla-viewport-entrances' );
			server = await startStaticServer( join( directory, 'website' ) );
			const candidate = await browser.newPage( { viewport: { width: 1024, height: 700 } } );
			await candidate.goto( server.url );
			expect( await pose( candidate ) ).toMatchObject( { opacity: '0', active: 'false' } );
			await candidate.locator( '.entrance' ).scrollIntoViewIfNeeded();
			await candidate.waitForFunction( () => document.querySelector( '.entrance' )?.getAttribute( 'data-active' ) === 'true' );
			const effects = await candidate.locator( '.entrance' ).evaluate( element => element.getAnimations().map( animation => ( {
				property: ( animation as CSSTransition ).transitionProperty,
				...animation.effect?.getTiming(),
			} ) ) );
			expect( effects ).toEqual( expect.arrayContaining( [ expect.objectContaining( { property: 'opacity', duration: 900, delay: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' } ), expect.objectContaining( { property: 'transform', duration: 900 } ) ] ) );
			await candidate.locator( '.entrance' ).evaluate( async element => { await Promise.all( element.getAnimations().map( effect => effect.finished ) ); } );
			expect( await pose( candidate ) ).toMatchObject( { opacity: '1', transform: 'none' } );
			expect( await candidate.locator( '.ambient' ).evaluate( element => element.getAnimations()[ 0 ]?.effect?.getTiming().iterations ) ).toBe( Infinity );
			await candidate.locator( 'button' ).hover();
			expect( await candidate.locator( 'button' ).evaluate( element => element.getAnimations().some( effect => effect instanceof CSSTransition ) ) ).toBe( true );
			if ( repeat ) await candidate.waitForFunction( () => document.querySelector( '.entrance' )?.getAttribute( 'data-active' ) === 'false' );
			else expect( ( await pose( candidate ) ).active ).toBe( 'true' );
			const reduced = await browser.newPage( { reducedMotion: 'reduce' } );
			await reduced.goto( server.url );
			expect( await pose( reduced ) ).toMatchObject( { opacity: '1', transform: 'none' } );
			const noScript = await browser.newPage( { javaScriptEnabled: false } );
			await noScript.goto( server.url );
			expect( ( await pose( noScript ) ).opacity ).toBe( '1' );
		} finally { await server?.close(); await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );

	it.skipIf( process.env.SKIP_BROWSER_TESTS )( 'fidelity observes lost entrances even without named finite CSS animations', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1024, height: 700 } } );
			const source = await observePage( page, `data:text/html,${ encodeURIComponent( fixture( false ) ) }`, 1024, 300, null );
			const frozen = await observePage( page, `data:text/html,${ encodeURIComponent( fixture( false ).replace( /<script>[\s\S]*?<\/script>/, '' ).replace( 'data-active="false"', 'data-active="true"' ) ) }`, 1024, 300, null );
			expect( source.animations ).toEqual( [] );
			expect( source.entranceTransitions ).toHaveLength( 2 );
			expect( checkMotion( source, frozen ).failures?.[ 0 ] ).toContain( 'viewport entrance transition coverage 0 of 2' );
		} finally { await browser.close(); }
	}, 30_000 );

	it.skipIf( process.env.SKIP_BROWSER_TESTS )( 'frozen capture comparison independently executes the portable entrances', async () => {
		const browser = await chromium.launch( { headless: true } );
		const directory = mkdtempSync( join( tmpdir(), 'dla-entrance-reference-' ) );
		try {
			const sourceUrl = 'https://fixture.test/';
			const context = await browser.newContext( { viewport: { width: 1440, height: 900 } } );
			await context.addInitScript( observeViewportEntrances );
			await context.route( 'https://fixture.test/**', route => route.fulfill( { contentType: 'text/html', body: fixture( false ) } ) );
			const source = await context.newPage();
			await source.goto( sourceUrl );
			await source.waitForFunction( () => ( window as typeof window & { fixtureReady?: boolean } ).fixtureReady );
			await triggerLazyLoad( source );
			await stampViewportEntrances( source );
			const reference = createReferenceCollector( directory, sourceUrl, [ sourceUrl ] );
			await reference.observe( source, sourceUrl, 'desktop', [], { isMobile: false, hasTouch: false } );
			for ( const path of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, path ) );
			writeFileSync( join( directory, 'html/home.html' ), await source.content() );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ sourceUrl ]: { html: 'html/home.html' } } } ) );
			const receipt = exportWebsiteCapture( { outputDir: directory, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
			reference.finalize( receipt );
			const report = await checkFidelity( { directory, stage: 'capture', routes: [ '/' ], widths: [ 1440 ] } );
			expect( report.pending ).toEqual( [] );
			expect( report.scores.flatMap( score => score.failures ) ).toEqual( [] );
			expect( report.pass ).toBe( true );
		} finally { await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 60_000 );
} );
