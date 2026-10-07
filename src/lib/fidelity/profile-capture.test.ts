import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector, type FidelityReference } from './reference.js';
import { checkFidelity } from './check.js';
import type { DeviceDocumentSelection } from '../document-selection.js';
import { replayBrowserIdentity, publicCaptureProfile } from '../screenshot/capture-profiles.js';

const directories: string[] = [];
afterAll( () => { if ( ! process.env.DLA_KEEP_DEVICE_EVIDENCE ) for ( const directory of directories ) rmSync( directory, { recursive: true, force: true } ); } );
const widths = [ 768, 1440 ];
const selection: DeviceDocumentSelection = {
	kind: 'device', id: 'neutral-three-source-identities/v1', defaultDocument: 'desktop', documents: [ 'desktop', 'mobile', 'tablet' ],
	rules: [ { userAgent: 'iPad', document: 'tablet' }, { userAgent: 'iPhone', document: 'mobile' } ],
	evidence: 'Fixture request selects its actual desktop, phone or tablet document, not a viewport breakpoint.',
};

async function captureFixture( failTablet = false, captureProfileArtifacts = false ) {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const directory = mkdtempSync( join( parent, 'profile-capture-' ) ); directories.push( directory );
	const source = createServer( ( request, response ) => {
		const ua = request.headers['user-agent'] ?? '';
		const identity = ua.includes( 'iPad' ) ? 'tablet' : ua.includes( 'iPhone' ) ? 'mobile' : 'desktop';
		if ( failTablet && identity === 'tablet' ) { response.writeHead( 403 ); response.end( 'This source profile is unavailable' ); return; }
		if ( request.url?.endsWith( '.svg' ) ) {
			response.setHeader( 'content-type', 'image/svg+xml' ); response.end( '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="green"/></svg>' ); return;
		}
		response.setHeader( 'content-type', 'text/html' );
		const meta = identity === 'mobile' ? 'width=320,user-scalable=yes' : identity === 'tablet' ? 'width=980,user-scalable=yes' : 'width=device-width,initial-scale=1';
		const width = identity === 'mobile' ? '320px' : identity === 'tablet' ? '980px' : 'max(980px,100vw)';
		const artifacts = captureProfileArtifacts ? `<div id="motion-${ identity }" style="height:80px;width:100px"></div><div style="height:1600px"></div><script>
const target=document.getElementById('motion-${ identity }');
const animation=new Animation(new KeyframeEffect(target,[{opacity:'0.25'},{opacity:'1'}],{duration:'auto',fill:'both'}),new ViewTimeline({subject:target}));animation.play();
function geometry(){target.style.width=innerWidth*${ identity === 'desktop' ? 0.5 : identity === 'mobile' ? 0.4 : 0.3 }+'px';}addEventListener('resize',geometry);geometry();
</script>` : '';
		response.end( `<!doctype html><html><head><meta charset="utf-8"><base href="/assets/${ identity }/"><meta id="${ identity }-viewport" name="viewport" content="${ meta }"><title>Neutral capture source</title><style>body{margin:0;font:16px Arial}main{width:${ width };height:400px}h1{margin:0;font:24px Arial}img{width:80px;height:60px}@media(max-width:980px){main{border:0}}@media(device-width:402px){body.mobile h1{font-size:29px}body.mobile img{width:96px;height:72px}}</style></head><body class="${ identity }"><main data-source-document="${ identity }"><h1>${ identity } source document</h1><p>Authored baseline content.</p><img src="${ identity }.svg" alt="${ identity } source image"></main>${ artifacts }</body></html>` );
	} );
	await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
	const collector = createReferenceCollector( directory, url, [ url ] );
	try {
		const captured = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir: directory, concurrency: 1, settleMs: 50, learnFluid: captureProfileArtifacts,
			...( captureProfileArtifacts ? { fluidWidths: [ 768, 1024, 1440 ] } : {} ),
			referenceWidths: widths, observeSource: collector.observe, declareSourceProfile: collector.declare,
			additionalProfiles: () => [ { id: 'tablet', ...( failTablet ? { context: { userAgent: 'Neutral iPad', isMobile: true, hasTouch: true } } : { device: 'iPad (gen 7)' } ), width: 768, height: 900, referenceWidths: widths } ],
		} );
		expect( captured.failed ).toBe( failTablet ? 1 : 0 );
		const receipt = exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'neutral', summary: {}, failures: [], resolveDocumentSelection: () => selection } );
		collector.finalize( receipt );
	} finally { await new Promise<void>( resolve => source.close( () => resolve() ) ); }
	return directory;
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'profile acquisition → static hosting → frozen comparison', () => {
	it( 'keeps baseline timeline and fluid custody while retaining tablet artifacts in its own profile', async () => {
		const directory = await captureFixture( false, true );
		const capture = JSON.parse( readFileSync( join( directory, 'screenshots/manifest.json' ), 'utf8' ) );
		const route = Object.values( capture.entries )[ 0 ] as import('../screenshot/manifest-queue.js').ManifestEntry;
		expect.soft( Object.keys( route.nativeViewTimelines ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
		for ( const key of [ 'desktop', 'mobile', 'tablet' ] ) {
			const profile = route.profiles![ key ]!;
			expect.soft( profile.fluid?.applied, key ).toBeGreaterThan( 0 );
			const timelines = profile.nativeViewTimelines;
			expect.soft( Object.keys( timelines ?? {} ), key ).toEqual( [ key ] );
			const evidence = timelines?.[ key ];
			if ( ! evidence ) continue;
			expect( evidence.preserved ).toBe( 1 );
			const report = JSON.parse( readFileSync( join( directory, evidence.path ), 'utf8' ) );
			expect( JSON.stringify( report ) ).toContain( `motion-${ key }` );
			expect( readFileSync( join( directory, profile.html! ), 'utf8' ) ).toContain( `data-dla-native-profile="${ key }"` );
			if ( key !== 'tablet' ) expect( route.nativeViewTimelines![ key ] ).toEqual( evidence );
		}
		expect( route.profiles!.desktop!.fluid ).toEqual( route.fluid );
		expect( route.profiles!.mobile!.fluid ).toEqual( route.fluidMobile );
	}, 180_000 );

	it( 'acquires a real third document and independently freezes each same-width identity', async () => {
		const directory = await captureFixture();
		const capture = JSON.parse( readFileSync( join( directory, 'screenshots/manifest.json' ), 'utf8' ) );
		const route = Object.values( capture.entries )[ 0 ] as import('../screenshot/manifest-queue.js').ManifestEntry;
		expect( route.profiles!.tablet!.html ).toMatch( /^html-tablet\// );
		expect( Object.keys( route.profiles! ).sort() ).toEqual( [ 'desktop', 'mobile', 'tablet' ] );
		expect( readFileSync( join( directory, route.profiles!.tablet!.html! ), 'utf8' ) ).toContain( 'tablet source document' );
		for ( const key of [ 'desktop', 'mobile', 'tablet' ] ) {
			const url = Object.keys( capture.entries )[ 0 ];
			expect( route.documents![ key ] ).toEqual( { url, baseUrl: `${ url }assets/${ key }/` } );
			expect( route.documents![ key ] ).toEqual( route.profiles![ key ]!.documentUrl );
		}
		const reference = JSON.parse( readFileSync( join( directory, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		expect( reference.scope.cells ).toHaveLength( 6 ); expect( reference.entries ).toHaveLength( 6 );
		expect( reference.entries.every( entry => entry.readiness.ready ) ).toBe( true );
		expect( reference.entries.filter( entry => entry.profile === 'tablet' ).every( entry => entry.viewportMeta === 'width=980,user-scalable=yes' ) ).toBe( true );
		expect( new Set( reference.entries.map( entry => entry.document?.path ) ).size ).toBe( 6 );
		expect( reference.entries.filter( entry => entry.viewport === 768 ).map( entry => entry.profile ).sort() ).toEqual( [ 'desktop', 'mobile', 'tablet' ] );
		const phoneScreen = replayBrowserIdentity( devices['iPhone 17'] ).screen;
		expect( phoneScreen ).toEqual( { width: 402, height: 874 } );
		const phoneEntries = reference.entries.filter( entry => entry.profile === 'mobile' );
		for ( const entry of phoneEntries ) {
			expect( entry.context?.screen ).toEqual( phoneScreen );
			const document = readFileSync( join( directory, entry.document!.path ), 'utf8' );
			expect( document ).toContain( 'mobile source document' );
		}
		const receipt = JSON.parse( readFileSync( join( directory, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.sourceProfile.documentSelection.routes[ 0 ].missing ).toEqual( [] );
		const report = await checkFidelity( { directory, settleMs: 50, screenshots: true } );
		expect( report.pass, JSON.stringify( { pending: report.pending, scores: report.scores.map( row => ( { profile: row.profile, width: row.viewport, failures: row.failures } ) ), selfConsistency: report.selfConsistency } ) ).toBe( true );
		expect( report.coverage ).toMatchObject( { required: 6, measured: 6, profiles: { desktop: { required: 2, measured: 2, pending: 0 }, mobile: { required: 2, measured: 2, pending: 0 }, tablet: { required: 2, measured: 2, pending: 0 } } } );
		for ( const score of report.scores.filter( row => row.profile === 'mobile' ) ) {
			expect( score.source.widestImage ).toBe( 96 );
			expect( score.liberated.widestImage ).toBe( 96 );
		}
		const tablet = await checkFidelity( { directory, profiles: [ 'tablet' ], widths: [ 768 ], settleMs: 50 } );
		expect( tablet.pass ).toBe( true ); expect( tablet.scores ).toHaveLength( 1 ); expect( tablet.scores[ 0 ]!.profile ).toBe( 'tablet' );
		const candidate = await ( await import('../replicate/local-site/static-server.js') ).startStaticServer( join( directory, 'website' ) );
		try {
			const materialization = await checkFidelity( { directory, candidateUrl: candidate.url, profiles: [ 'tablet' ], widths: [ 768 ], settleMs: 50 } );
			expect( materialization.pass ).toBe( true ); expect( materialization.scores[ 0 ]!.profile ).toBe( 'tablet' );
		} finally { await candidate.close(); }
		const unobserved = await checkFidelity( { directory, profiles: [ 'tablet' ], widths: [ 800 ], settleMs: 50 } );
		expect( unobserved.pass ).toBe( false ); expect( unobserved.pending ).toHaveLength( 1 );
		const unsupportedState = await checkFidelity( { directory, profiles: [ 'tablet' ], states: [ 'expanded' ] } );
		expect( unsupportedState.pass ).toBe( false ); expect( unsupportedState.pending!.length ).toBeGreaterThan( 0 );
		// Capture-stage replay is intentionally allowed to inspect changed output.
		// A candidate that silently substitutes another viewport must fail the
		// source-owned head contract, even if a tree's fixed canvas still fits.
		const pagePath = join( directory, 'website/index.html' );
		const original = readFileSync( pagePath, 'utf8' );
		writeFileSync( pagePath, original.replaceAll( 'width=980,user-scalable=yes', 'width=device-width,initial-scale=1' ) );
		const wrongHead = await checkFidelity( { directory, profiles: [ 'tablet' ], widths: [ 768 ], settleMs: 50 } );
		expect( wrongHead.pass ).toBe( false );
		expect( wrongHead.scores[ 0 ]!.failures.some( failure => failure.startsWith( 'source-selected viewport metadata differs:' ) ) ).toBe( true );
		writeFileSync( pagePath, original );
		// Frozen screen must not be inferred from the requested viewport. Losing
		// it changes source-authored device-width CSS despite identical UA/DPR.
		const referencePath = join( directory, 'fidelity-reference.json' );
		const referenceBytes = readFileSync( referencePath, 'utf8' );
		const wrongScreenReference = JSON.parse( referenceBytes ) as FidelityReference;
		for ( const entry of wrongScreenReference.entries ) if ( entry.profile === 'mobile' ) delete entry.context!.screen;
		writeFileSync( referencePath, JSON.stringify( wrongScreenReference ) );
		const wrongScreen = await checkFidelity( { directory, profiles: [ 'mobile' ], widths: [ 768 ], settleMs: 50 } );
		expect( wrongScreen.pass ).toBe( false );
		expect( wrongScreen.scores[ 0 ]!.source.widestImage ).toBe( 96 );
		expect( wrongScreen.scores[ 0 ]!.liberated.widestImage ).toBe( 80 );
		writeFileSync( referencePath, referenceBytes );
		writeFileSync( join( directory, 'full-profile-report.json' ), JSON.stringify( report, null, 2 ) );
		writeFileSync( join( directory, 'profile-proof.json' ), JSON.stringify( { directory, coverage: report.coverage, scores: report.scores.map( row => ( { profile: row.profile, viewport: row.viewport, pass: row.pass, failures: row.failures } ) ), tabletFilter: tablet.coverage }, null, 2 ) );
	}, 180_000 );

	it( 'keeps a failed profile in declared scope rather than silently lowering coverage', async () => {
		const directory = await captureFixture( true );
		const reference = JSON.parse( readFileSync( join( directory, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		expect( reference.scope.cells ).toHaveLength( 6 ); expect( reference.entries ).toHaveLength( 4 );
		const manifest = JSON.parse( readFileSync( join( directory, 'screenshots/manifest.json' ), 'utf8' ) );
		const attempted = Object.values( manifest.entries )[ 0 ] as { profiles: Record<string,{deviceScaleFactor: number}> };
		expect( attempted.profiles.tablet!.deviceScaleFactor ).toBe( 1 );
		const report = await checkFidelity( { directory, settleMs: 50 } );
		expect( report.pass ).toBe( false ); expect( report.status ).toBe( 'unproven' );
		expect( report.coverage ).toMatchObject( { required: 6, measured: 4, profiles: { tablet: { required: 2, measured: 0, pending: 2 } } } );
		expect( report.pending!.map( cell => cell.profile ) ).toEqual( [ 'tablet', 'tablet' ] );
	}, 180_000 );
} );

describe( 'credential-free replay identity', () => {
	it( 'stores only public rendering fields and deep-copies only screen dimensions', () => {
		const options = { userAgent: 'NeutralBrowser', isMobile: true, hasTouch: true, deviceScaleFactor: 2,
			screen: { width: 810, height: 1080, secret: 'screen-secret' }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const,
			storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { authorization: 'header-secret' }, httpCredentials: { username: 'user', password: 'password-secret' },
			cookies: [ 'cookie-secret' ], secret: 'top-level-secret',
		};
		const identity = replayBrowserIdentity( options );
		expect( identity ).toEqual( { userAgent: 'NeutralBrowser', isMobile: true, hasTouch: true, deviceScaleFactor: 2, screen: { width: 810, height: 1080 }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce' } );
		const recipe = publicCaptureProfile( { id: 'neutral', width: 768, height: 900, context: options, secret: 'recipe-secret' } as Parameters<typeof publicCaptureProfile>[0] );
		expect( JSON.stringify( recipe ) ).not.toMatch( /secret|storageState|cookies|HTTPHeaders|httpCredentials|password/ );
		expect( recipe.context?.screen ).not.toBe( options.screen );
	} );
} );
