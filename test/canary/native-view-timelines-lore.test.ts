import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { expect, it } from 'vitest';
import { captureNativeViewTimelines } from '../../src/lib/screenshot/native-view-timelines.js';
import { capturePageHtml, captureScreenshots } from '../../src/lib/screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../../src/lib/capture-export.js';
import { startStaticServer } from '../../src/lib/replicate/local-site/static-server.js';
import { CapturedResourceStore } from '../../src/lib/screenshot/resource-capture.js';

/** Bounded live evidence probe, not part of the offline suite or a parity claim
 * for the complete site. Portable motion is compared with the same captured CSS.
 */
it( 'retains the live Home photo native translation and separate phone perspective', async () => {
	const browser = await chromium.launch();
	const output = join( process.cwd(), '.tmp-test', 'lore-native-view-timelines-551' );
	mkdirSync( output, { recursive: true } );
	try {
		const { defaultBrowserType: _unused, ...phone } = devices[ 'iPhone 13' ];
		for ( const [ name, profile, width ] of [ [ 'desktop', {}, 1440 ], [ 'phone', phone, 390 ] ] as const ) {
			const captureDir = join( output, `${ name }-capture` );
			mkdirSync( join( captureDir, 'html' ), { recursive: true } );
			mkdirSync( join( captureDir, 'screenshots' ), { recursive: true } );
			const resources = new CapturedResourceStore( captureDir, 'https://www.lorecounselling.ca/' );
			const page = await browser.newPage( { ...profile, viewport: { width, height: 900 } } );
			resources.observe( page );
			await page.goto( 'https://www.lorecounselling.ca/', { waitUntil: 'domcontentloaded', timeout: 60_000 } );
			await page.waitForFunction( () => document.getElementById( 'bgMedia_comp-m558n8xt14' )?.getAnimations().length, { timeout: 30_000 } );
			// Controlled lazy-load stimulation, retaining Home rather than visiting routes.
			for ( const y of [ 400, 800, 1200, 0 ] ) {
				await page.evaluate( y => scrollTo( 0, y ), y );
				await page.waitForTimeout( 500 );
			}
			await page.waitForTimeout( 1200 );
			const trace = await captureNativeViewTimelines( page, name );
			writeFileSync( join( output, `${ name }-source-trace.json` ), JSON.stringify( trace, null, 2 ) );
			const sourceHtml = await capturePageHtml( page );
			writeFileSync( join( output, `${ name }-source.html` ), sourceHtml );
			writeFileSync( join( captureDir, 'html', 'homepage.html' ), sourceHtml );
			writeFileSync( join( captureDir, 'native-source-trace.json' ), JSON.stringify( trace, null, 2 ) );
			writeFileSync( join( captureDir, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://www.lorecounselling.ca/': { html: 'html/homepage.html', nativeViewTimelines: { [ name ]: { path: 'native-source-trace.json', preserved: trace.preserved, losses: trace.losses } } } } } ) );
			await resources.captureDomDependencies( sourceHtml, page.url() );
			await resources.settle( page );
			await resources.flush();
			exportWebsiteCapture( { outputDir: captureDir, sourceUrl: 'https://www.lorecounselling.ca/', platform: 'generic', summary: {}, failures: [] } );
			const portable = readFileSync( join( captureDir, 'website', 'index.html' ), 'utf8' );
			writeFileSync( join( output, `${ name }-portable.html` ), portable );
			const targetId = name === 'desktop' ? 'bgMedia_comp-m558n8xt14' : 'img_comp-m558n8xt14';
			const config = await page.locator( `[id="${ targetId }"]` ).getAttribute( 'data-dla-native-effects' );
			expect( config, `${ name } photo native animation is representable` ).toBeTruthy();
			expect( config ).toContain( name === 'desktop' ? 'translateX(8%)' : 'perspective(100px) translateZ(11.54px)' );
			// Same document geometry; this isolates effect retention from media localization
			// and from independently owned device-profile/fluid geometry work.
			const copy = await browser.newPage( { ...profile, viewport: { width, height: 900 } } );
			const server = await startStaticServer( join( captureDir, 'website' ) );
			try {
			const remoteRequests: Array<{ url: string; resourceType: string; mainFrame: boolean }> = [];
			await copy.route( '**/*', route => {
				const requestUrl = route.request().url();
				if ( /^https?:/.test( requestUrl ) && new URL( requestUrl ).origin !== new URL( server.url ).origin ) { remoteRequests.push( { url: requestUrl, resourceType: route.request().resourceType(), mainFrame: route.request().frame() === copy.mainFrame() } ); return route.abort(); }
				return route.continue();
			} );
			await copy.goto( server.url, { waitUntil: 'domcontentloaded' } );
			await copy.waitForTimeout( 1500 );
			const facts = async ( target: typeof page ) => target.locator( `[id="${ targetId }"]` ).evaluate( node => {
				const rect = node.getBoundingClientRect();
				return { transform: getComputedStyle( node ).transform, x: rect.x, width: rect.width, height: rect.height, innerHeight, clientHeight: document.documentElement.clientHeight, effects: node.getAnimations().length };
			} );
			const samples = [];
			const viewRange = await page.locator( `[id="${ targetId }"]` ).evaluate( node => {
				const animation = node.getAnimations()[ 0 ] as Animation & { timeline: AnimationTimeline & { subject: HTMLElement; source: HTMLElement } };
				const subject = animation.timeline.subject;
				const extent = subject.clientHeight + animation.timeline.source.clientHeight;
				return { start: subject.getBoundingClientRect().top + scrollY - animation.timeline.source.clientHeight, extent };
			} );
			for ( const y of [ 0, ...[ 0.25, 0.5, 0.75 ].map( fraction => Math.round( viewRange.start + viewRange.extent * fraction ) ), 0 ] ) {
				await page.evaluate( y => scrollTo( 0, y ), y );
				await copy.evaluate( y => scrollTo( 0, y ), y );
				await page.waitForTimeout( 200 );
				samples.push( { y, source: await facts( page ), portable: await facts( copy ) } );
			}
			writeFileSync( join( output, `${ name }-comparisons.json` ), JSON.stringify( samples, null, 2 ) );
			writeFileSync( join( output, `${ name }-offline-requests.json` ), JSON.stringify( remoteRequests, null, 2 ) );
			await page.screenshot( { path: join( output, `${ name }-source.png` ) } );
			await copy.screenshot( { path: join( output, `${ name }-portable.png` ) } );
			expect( await copy.locator( '[data-dla-native-runtime-loss]' ).count() ).toBe( 0 );
			expect( samples[ 0 ].portable.transform ).not.toBe( 'none' );
			// All remote requests are blocked. Existing remote iframe documents are
			// retained as explicit evidence; photo/CSS/font resources must be local.
			expect( remoteRequests.every( request => request.resourceType === 'document' && ! request.mainFrame ) ).toBe( true );
			for ( const sample of samples ) {
				expect( sample.portable.transform ).toBe( sample.source.transform );
				for ( const key of [ 'x', 'width', 'height' ] as const ) expect( sample.portable[ key ] ).toBeCloseTo( sample.source[ key ], 2 );
			}
			} finally { await copy.close(); await server.close(); await page.close(); }
		}
	} finally { await browser.close(); }
}, 150_000 );

it( 'retains the desktop photo through the owning pipeline at its canonical source baseline', async () => {
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'lore-native-pipeline-551-' ) );
	const url = 'https://www.lorecounselling.ca/';
	let observed: unknown;
	const result = await captureScreenshots( {
		urls: [ url ], outputDir, concurrency: 1, settleMs: 800, viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		observeSource: async page => {
			observed = await page.locator( '#bgMedia_comp-m558n8xt14' ).evaluate( node => {
				const rect = node.getBoundingClientRect();
				return { transform: getComputedStyle( node ).transform, x: rect.x, width: rect.width, height: rect.height, scrollY };
			} );
			writeFileSync( join( outputDir, 'home-photo-source.json' ), JSON.stringify( observed, null, 2 ) );
		},
	} );
	expect( result.failed ).toBe( 0 );
	exportWebsiteCapture( { outputDir, sourceUrl: url, platform: 'generic', summary: { routesCaptured: 1 }, failures: [] } );
	const portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
	const manifest = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) );
	const native = manifest.entries[ url ].nativeViewTimelines.desktop;
	expect( native.preserved ).toBeGreaterThanOrEqual( 1 );
	expect( portable ).toContain( 'data-dla-native-view-timeline-runtime' );
	const server = await startStaticServer( join( outputDir, 'website' ) );
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		const remoteRequests: Array<{ url: string; resourceType: string; mainFrame: boolean }> = [];
		await page.route( '**/*', route => {
			const requestUrl = route.request().url();
			if ( /^https?:/.test( requestUrl ) && new URL( requestUrl ).origin !== new URL( server.url ).origin ) { remoteRequests.push( { url: requestUrl, resourceType: route.request().resourceType(), mainFrame: route.request().frame() === page.mainFrame() } ); return route.abort(); }
			return route.continue();
		} );
		await page.goto( server.url, { waitUntil: 'domcontentloaded' } );
		await page.waitForTimeout( 1000 );
		const actual = await page.locator( '#bgMedia_comp-m558n8xt14' ).evaluate( node => {
			const rect = node.getBoundingClientRect();
			return { transform: getComputedStyle( node ).transform, x: rect.x, width: rect.width, height: rect.height };
		} );
		writeFileSync( join( outputDir, 'home-photo-portable.json' ), JSON.stringify( { observed, actual, remoteRequests }, null, 2 ) );
		await page.screenshot( { path: join( outputDir, 'home-photo-portable.png' ) } );
		expect( actual.transform ).toBe( ( observed as { transform: string } ).transform );
		expect( actual.x ).toBeCloseTo( ( observed as { x: number } ).x, 2 );
		expect( remoteRequests.every( request => request.resourceType === 'document' && ! request.mainFrame ) ).toBe( true );
		writeFileSync( join( outputDir, 'motion-gate.json' ), JSON.stringify( { status: 'passed', scope: 'desktop photo baseline native transform and x geometry; external iframe documents blocked', observed, actual, remoteRequests }, null, 2 ) );
	} finally { await browser.close(); await server.close(); }
}, 180_000 );
