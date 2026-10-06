import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { captureNativeViewTimelines, observedRange } from './native-view-timelines.js';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { assembleResponsiveCapture } from '../responsive-assembly.js';
import { wireNativeViewTimelines } from '../native-view-timelines.js';

const FIXTURE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0} .spacer{height:65vh} #subject{height:55vh;width:80vw;margin:0 auto;position:relative}
#translate,#perspective,#fixed,#percent,#unknown{width:60vw;height:120px;background:linear-gradient(90deg,red,blue)}
#authored{width:20px;height:20px;animation:authored 10s linear infinite}@keyframes authored{to{transform:rotate(360deg)}}
</style><div class="spacer"></div><section id="subject"><div id="translate"></div><div id="perspective"></div><div id="fixed"></div><div id="percent"></div><div id="unknown"></div><div id="nearOffset"></div><div id="inset"></div><div id="shifted"></div><div id="authored"></div></section><div style="height:2200px"></div><script>(()=>{
const subject=document.getElementById('subject');
const timeline=new ViewTimeline({subject,axis:'block'});
const animations=[];
function make(id,frames,rangeEnd,easing='linear'){const animation=new Animation(new KeyframeEffect(document.getElementById(id),frames,{duration:'auto',fill:'both',easing}),timeline);animation.rangeStart='cover 0%';animation.rangeEnd=rangeEnd;animation.play();return animation}
animations.push(make('translate',[{transform:'translateX(8%)'},{transform:'translateX(calc(-8%))'}],'cover 100%'));
animations.push(make('perspective',[{transform:'perspective(100px) translateZ(11.54px)'},{transform:'perspective(100px) translateZ(-15px)'}],'cover 100%','cubic-bezier(0.445,0.05,0.55,0.95)'));
make('fixed',[{transform:'translateX(0px)'},{transform:'translateX(140px)'}],'cover 700px');
make('percent',[{transform:'translateX(0px)'},{transform:'translateX(180px)'}],'cover 75%');
const unknown=make('unknown',[{transform:'translateX(0px)'},{transform:'translateX(99px)'}],'cover 100%');
const nearOffset=make('nearOffset',[{transform:'translateX(0px)'},{transform:'translateX(140px)'}],'cover 100%');
const inset=new Animation(new KeyframeEffect(document.getElementById('inset'),[{opacity:'0'},{opacity:'1'}],{duration:'auto',fill:'both'}),new ViewTimeline({subject,inset:'10% 20px'}));inset.play();
const shifted=make('shifted',[{transform:'translateX(0px)'},{transform:'translateX(80px)'}],'cover 100%');requestAnimationFrame(()=>shifted.startTime=CSS.percent(20));
// A second, distinct no-op effect on the same target must not hide the first.
make('perspective',[{opacity:'1'},{opacity:'1'}],'cover 0px');
function update(){animations.forEach(a=>a.rangeEnd='cover calc(0% + '+(subject.clientHeight+timeline.source.clientHeight)+'px)');unknown.rangeEnd='cover '+(timeline.source.clientHeight*2+31)+'px';nearOffset.rangeEnd='cover calc(0% + '+(subject.clientHeight+timeline.source.clientHeight+0.005)+'px)'}
new ResizeObserver(update).observe(subject);addEventListener('resize',update);update();
})();</script>`;

const pose = async ( page: Page ) => page.evaluate( () => Object.fromEntries( [ 'translate', 'perspective', 'fixed', 'percent' ].map( id => {
	const node = document.getElementById( id )!;
	const rect = node.getBoundingClientRect();
	return [ id, { transform: getComputedStyle( node ).transform, x: rect.x, y: rect.y, width: rect.width, height: rect.height } ];
} ) ) );

it( 'keeps fixed and percent ranges fixed and rejects an unproven changing range', () => {
	expect( observedRange( [ { rangeName: 'cover', offset: '700px' }, { rangeName: 'cover', offset: '700px' } ], [ 900, 964 ] ) ).toEqual( { value: 'cover 700px' } );
	expect( observedRange( [ { rangeName: 'cover', offset: '75%' }, { rangeName: 'cover', offset: '75%' } ], [ 900, 964 ] ) ).toEqual( { value: 'cover 75%' } );
	expect( observedRange( [ { rangeName: 'cover', offset: '931px' }, { rangeName: 'cover', offset: '995px' } ], [ 900, 964 ] ) ).toBeUndefined();
	expect( observedRange( [ 900, 964, 852 ].map( extent => ({ rangeName: 'cover', offset: `calc(0% + ${ extent + 0.005 }px)` }) ), [ 900, 964, 852 ] ) ).toBeUndefined();
	expect( observedRange( [ { rangeName: 'cover', offset: '700.005px' }, { rangeName: 'cover', offset: '700.005px' } ], [ 900, 964 ] ) ).toEqual( { value: 'cover 700.005px' } );
} );

it( 'exports native motion with real scroll/resize parity and authored CSS, retaining source traces', async () => {
	const browser = await chromium.launch();
	const source = await browser.newPage( { viewport: { width: 1000, height: 900 } } );
	const copy = await browser.newPage( { viewport: { width: 1000, height: 900 } } );
	const artifact = join( process.cwd(), '.tmp-test', 'native-view-timelines-551' );
	mkdirSync( join( artifact, 'html' ), { recursive: true } );
	mkdirSync( join( artifact, 'screenshots' ), { recursive: true } );
	try {
		await source.setContent( FIXTURE );
		await source.waitForTimeout( 200 );
		const report = await captureNativeViewTimelines( source, 'neutral-desktop' );
		writeFileSync( join( artifact, 'source-trace.json' ), JSON.stringify( report, null, 2 ) );
		expect( report.preserved ).toBe( 5 );
		expect( report.losses ).toEqual( expect.arrayContaining( [ { target: expect.any( String ), reason: 'range relationship is not fixed or independently validated cover extent' }, { target: expect.any( String ), reason: 'timeline inset is not publicly readable or independently verified as default' }, { target: expect.any( String ), reason: 'animation phase is not independently verified as native range alignment' } ] ) );
		expect( report.losses ).toHaveLength( 4 );
		expect( await source.locator( '#nearOffset' ).getAttribute( 'data-dla-native-effects' ) ).toBeNull();
		const html = await capturePageHtml( source );
		writeFileSync( join( artifact, 'html', 'homepage.html' ), html );
		writeFileSync( join( artifact, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://neutral.example/': { html: 'html/homepage.html' } } } ) );
		exportWebsiteCapture( { outputDir: artifact, sourceUrl: 'https://neutral.example/', platform: 'generic', summary: {}, failures: [] } );
		const portable = readFileSync( join( artifact, 'website', 'index.html' ), 'utf8' );
		expect( portable ).toContain( 'data-dla-native-view-timeline-runtime' );
		expect( portable ).not.toContain( 'const subject=document' );
		await copy.setContent( sanitizeFrozenHtml( html ) );
		await copy.waitForTimeout( 100 );
		expect( ( await pose( copy ) ).translate.transform ).not.toEqual( ( await pose( source ) ).translate.transform );
		await copy.setContent( portable );
		const comparisons: unknown[] = [];
		for ( const size of [ { width: 1000, height: 900 }, { width: 1000, height: 964 }, { width: 390, height: 739 }, { width: 768, height: 820 } ] ) {
			await source.setViewportSize( size );
			await copy.setViewportSize( size );
			for ( const y of [ 0, 350, 650, 900, 0 ] ) {
				await source.evaluate( y => scrollTo( 0, y ), y );
				await copy.evaluate( y => scrollTo( 0, y ), y );
				await source.waitForTimeout( 150 );
				const expected = await pose( source ), actual = await pose( copy );
				comparisons.push( { size, y, expected, actual } );
				writeFileSync( join( artifact, 'comparisons.json' ), JSON.stringify( comparisons, null, 2 ) );
				for ( const id of Object.keys( expected ) ) {
					for ( const property of [ 'x', 'y', 'width', 'height' ] as const ) expect( actual[ id ][ property ], `${ id } ${ property } at ${ JSON.stringify( size ) } scroll ${ y }` ).toBeCloseTo( expected[ id ][ property ], 2 );
					expect( actual[ id ].transform ).toBe( expected[ id ].transform );
				}
			}
		}
		expect( await copy.locator( '[data-dla-native-runtime-loss]' ).count() ).toBe( 0 );
		expect( await copy.locator( '#authored' ).evaluate( node => node.getAnimations().map( animation => animation.constructor.name ) ) ).toEqual( [ 'CSSAnimation' ] );
		const authoredBefore = await copy.locator( '#authored' ).evaluate( node => getComputedStyle( node ).transform );
		await copy.waitForTimeout( 100 );
		expect( await copy.locator( '#authored' ).evaluate( node => getComputedStyle( node ).transform ) ).not.toBe( authoredBefore );
		// Same tree, distinct profile effects: assembly must retain both bindings.
		const phone = html.replace( /translateX\(8%\)/g, 'translateX(4%)' );
		const assembled = assembleResponsiveCapture( { rawDesktopHtml: html, rawMobileHtml: phone, portableDesktopHtml: sanitizeFrozenHtml( html ), portableMobileHtml: sanitizeFrozenHtml( phone ) } );
		expect( assembled.hasMobileDocument ).toBe( true );
		await copy.goto( `data:text/html,${ encodeURIComponent( wireNativeViewTimelines( assembled.html ) ) }` );
		await copy.waitForTimeout( 100 );
		expect( await copy.locator( '[data-dla-native-runtime-loss]' ).count() ).toBe( 0 );
		for ( const width of [ 1000, 390, 1000 ] ) {
			await source.setViewportSize( { width, height: 900 } );
			await source.goto( `data:text/html,${ encodeURIComponent( width > 767 ? FIXTURE : FIXTURE.replace( /translateX\(8%\)/g, 'translateX(4%)' ) ) }` );
			await copy.setViewportSize( { width, height: 900 } );
			await copy.evaluate( () => scrollTo( 0, 0 ) );
			await copy.waitForTimeout( 150 );
			const scope = width > 767 ? '.data-liberation-desktop-document' : '.data-liberation-mobile-document';
			const translation = await copy.locator( `${ scope } [id="translate"]` ).evaluate( node => {
				const transform = getComputedStyle( node ).transform;
				return { x: new DOMMatrix( transform ).m41, width: ( node as HTMLElement ).offsetWidth };
			} );
			const sourceTranslation = await source.locator( '#translate' ).evaluate( node => new DOMMatrix( getComputedStyle( node ).transform ).m41 );
			expect( translation.x ).toBeCloseTo( sourceTranslation, 2 );
			expect( await copy.locator( `${ scope } [id="translate"]` ).evaluate( node => node.getAnimations().length ) ).toBe( 1 );
		}
	} finally {
		await browser.close();
	}
}, 45_000 );

it( 'routes public-API motion capture through the owning browser pipeline and receipt', async () => {
	const server = createServer( ( _request, response ) => { response.setHeader( 'content-type', 'text/html' ); response.end( FIXTURE ); } );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${ address.port }/`;
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'native-view-timelines-pipeline-551-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ url ], outputDir, concurrency: 1, force: true, settleMs: 0, viewports: [ { id: 'desktop', width: 1000, height: 900 } ],
			prepareCapture: async page => { await page.evaluate( () => scrollTo( 0, 1600 ) ); },
			observeSource: async page => { expect( await page.evaluate( () => scrollY ) ).toBe( 0 ); },
		} );
		expect( result.failed ).toBe( 0 );
		const manifest = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) );
		const evidence = manifest.entries[ url ].nativeViewTimelines.desktop;
		expect( evidence.preserved ).toBe( 5 );
		expect( evidence.losses ).toHaveLength( 4 );
		expect( JSON.parse( readFileSync( join( outputDir, evidence.path ), 'utf8' ) ).samples ).toHaveLength( 5 );
		exportWebsiteCapture( { outputDir, sourceUrl: url, platform: 'generic', summary: {}, failures: [] } );
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.nativeViewTimelines.pages ).toEqual( [ { url, profiles: manifest.entries[ url ].nativeViewTimelines } ] );
		expect( receipt.nativeViewTimelines.binding.documentScopeAttribute ).toBe( 'data-dla-document-scope' );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'data-dla-native-view-timeline-runtime' );
	} finally {
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
	}
}, 60_000 );

it.each( [ 'resize', 'snapshot', 'baseline' ] as const )( 'bounds a nonresponding native %s source and retains failure evidence through cleanup', async boundary => {
	const server = createServer( ( _request, response ) => { response.setHeader( 'content-type', 'text/html' ); response.end( FIXTURE ); } );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', `native-${ boundary }-stall-551-` ) );
	try {
		const started = Date.now();
		const result = await captureScreenshots( {
			urls: [ url ], outputDir, concurrency: 1, settleMs: 0, evaluateTimeoutMs: 500, viewports: [ { id: 'desktop', width: 1000, height: 900 } ],
			prepareCapture: async page => {
				await page.evaluate( boundary => {
					if ( boundary === 'resize' ) addEventListener( 'resize', () => { for (;;) { /* real renderer main-thread stall */ } }, { once: true } );
					else if ( boundary === 'snapshot' ) document.getAnimations = () => { for (;;) { /* real renderer main-thread stall */ } };
					else window.scrollTo = () => { for (;;) { /* baseline restoration cannot return */ } };
				}, boundary );
			},
		} );
		const elapsedMs = Date.now() - started;
		writeFileSync( join( outputDir, 'deadline-gate.json' ), JSON.stringify( { boundary, elapsedMs, result }, null, 2 ) );
		expect( elapsedMs ).toBeLessThan( 30_000 );
		expect( result.failed ).toBe( 1 );
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'failures.json' ), 'utf8' ) );
		expect( failures ).toHaveLength( 1 );
		expect( failures[ 0 ].stage ).toBe( 'evaluate' );
		expect( failures[ 0 ].error ).toMatch( /unproven.*evaluate timeout/ );
		const manifest = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) );
		expect( manifest.entries[ url ].html ).toBeUndefined();
		if ( boundary !== 'baseline' ) {
			const evidence = manifest.entries[ url ].nativeViewTimelines.desktop;
			expect( evidence.status ).toBe( 'unproven' );
			expect( evidence.preserved ).toBe( 0 );
			const trace = JSON.parse( readFileSync( join( outputDir, evidence.path ), 'utf8' ) );
			expect( trace.status ).toBe( 'unproven' );
			expect( trace.losses.length ).toBeGreaterThan( 0 );
			if ( boundary === 'resize' ) expect( trace.failures.join( '\n' ) ).toMatch( /restore scroll.*evaluate timeout/ );
		}
	} finally { await new Promise<void>( resolve => server.close( () => resolve() ) ); }
}, 60_000 );

it( 'binds duplicate node tokens within generic device document scopes and reports missing local subjects', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport: { width: 1000, height: 900 } } );
		const config = ( subject: string ) => JSON.stringify( [ { subject, source: 'root', axis: 'block', inset: 'auto', frames: [ { transform: 'translateX(0px)' }, { transform: 'translateX(80px)' } ], timing: { duration: 'auto', fill: 'both' }, composite: 'replace', rangeStart: { value: 'cover 0%' }, rangeEnd: { value: 'cover 100%' } } ] ).replace( /"/g, '&quot;' );
		const device = ( profile: string, subject = 'n1' ) => `<div data-dla-device-document="${ profile }" data-dla-document-scope><section data-dla-native-node="n1" style="height:400px"><div data-dla-native-node="n2" data-dla-native-profile="${ profile }" data-dla-native-effects="${ config( subject ) }" style="height:30px;width:200px"></div></section></div>`;
		const desktop = device( 'desktop' ).replace( '</section>', '<span data-dla-native-node="foreign" hidden></span></section>' );
		await page.setContent( wireNativeViewTimelines( `<!doctype html><html><head></head><body>${ desktop }${ device( 'phone' ) }${ device( 'missing', 'foreign' ) }</body></html>` ) );
		await page.waitForTimeout( 150 );
		for ( const profile of [ 'desktop', 'phone' ] ) {
			const facts = await page.locator( `[data-dla-native-profile="${ profile }"]` ).evaluate( target => {
				const animation = target.getAnimations()[ 0 ] as Animation & { timeline: AnimationTimeline & { subject: Element } };
				return { count: target.getAnimations().length, ownSubject: animation.timeline.subject === target.parentElement, loss: target.getAttribute( 'data-dla-native-runtime-loss' ) };
			} );
			expect( facts ).toEqual( { count: 1, ownSubject: true, loss: null } );
		}
		expect( await page.locator( '[data-dla-native-profile="missing"]' ).getAttribute( 'data-dla-native-runtime-loss' ) ).toBe( 'subject or source binding missing or ambiguous' );
	} finally { await browser.close(); }
} );
