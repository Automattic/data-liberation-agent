import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { observeViewportEntrances, stampViewportEntrances, collectViewportEntranceStartup } from './viewport-entrances.js';
import { exportWebsiteCapture } from './capture-export.js';
import { observePage } from './fidelity/check.js';
import { checkMotion } from './fidelity/rendered-contract-checks.js';

const fixture = ( repeat: boolean, startup = false ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;width:980px}.spacer{height:${ startup ? 350 : 1100 }px}.entrance{position:relative;left:${ startup ? 10 : 740 }px;width:200px;height:150px;background:red}
.entrance:not([data-state="complete"]){animation:neutralFade 450ms linear backwards paused,neutralClip 800ms cubic-bezier(.22,1,.36,1) backwards paused}
@keyframes neutralFade{from{opacity:0}to{opacity:1}}@keyframes neutralClip{from{clip-path:inset(0 20% 0 0)}to{clip-path:inset(0)}}
.ambient{animation:ambient 2s infinite}@keyframes ambient{to{transform:translateX(3px)}}
</style></head><body><div class="ambient">Authored ambience</div><div class="spacer"></div><section id="entrance" class="entrance" data-state="pending">Deferred authored entrance</section><div class="spacer"></div><section class="entrance" data-state="complete">Completed content</section><script>
const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting&&entry.intersectionRatio>=observer.thresholds[0]){
${ startup ? "document.querySelector('meta[name=viewport]').content='width=320,user-scalable=yes';" : '' }
setTimeout(()=>{const effects=entry.target.getAnimations();effects.forEach(effect=>effect.play());Promise.all(effects.map(effect=>effect.finished)).then(()=>{entry.target.dataset.state='complete';${ repeat ? '' : 'observer.unobserve(entry.target);' }});},30);
}${ repeat ? "else if(entry.target.dataset.state==='complete')entry.target.dataset.state='pending';" : '' } }},{threshold:.6,rootMargin:'0px'});
document.querySelectorAll('.entrance').forEach(element=>observer.observe(element));
</script></body></html>`;

const pose = ( page: Page ) => page.locator( '#entrance' ).evaluate( element => {
	const style = getComputedStyle( element );
	return { opacity: style.opacity, clipPath: style.clipPath, state: element.getAttribute( 'data-state' ), effects: element.getAnimations().map( animation => ( {
		name: ( animation as CSSAnimation ).animationName, state: animation.playState, timeline: animation.timeline === document.timeline,
		timing: animation.effect?.getTiming(), frames: ( animation.effect as KeyframeEffect ).getKeyframes(),
	} ) ) };
} );

async function exportSource( source: Page, directory: string ) {
	await stampViewportEntrances( source );
	for ( const path of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, path ) );
	writeFileSync( join( directory, 'html/home.html' ), await source.content() );
	writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://fixture.test/': { html: 'html/home.html' } } } ) );
	exportWebsiteCapture( { outputDir: directory, sourceUrl: 'https://fixture.test/', platform: 'generic', summary: {}, failures: [] } );
	return readFileSync( join( directory, 'website/index.html' ), 'utf8' );
}

it.each( [ false, true ] )( 'replays actual finite CSS start and completion, scroll/resize and repeated re-entry (%s)', async repeat => {
	const browser = await chromium.launch();
	mkdirSync( '.tmp-test', { recursive: true } );
	const directory = mkdtempSync( join( process.cwd(), '.tmp-test/finite-css-' ) );
	try {
		const source = await browser.newPage( { viewport: { width: 1000, height: 700 } } );
		await source.addInitScript( observeViewportEntrances );
		await source.goto( `data:text/html,${ encodeURIComponent( fixture( repeat ) ) }` );
		await source.evaluate( () => scrollTo( 0, 1100 ) );
		await source.waitForTimeout( 1200 );
		expect( await pose( source ) ).toMatchObject( { state: 'complete', opacity: '1', effects: [] } );
		await source.evaluate( () => scrollTo( 0, 0 ) ); await source.waitForTimeout( 100 );
		const portable = await exportSource( source, directory );
		const binding = JSON.parse( ( await source.locator( '#entrance' ).getAttribute( 'data-dla-viewport-entrance' ) )! );
		expect( binding.cssAnimations.map( ( effect: {name: string} ) => effect.name ) ).toEqual( [ 'neutralFade', 'neutralClip' ] );
		expect( binding.repeat ).toBe( repeat );
		expect( await source.locator( '.entrance' ).nth( 1 ).getAttribute( 'data-dla-viewport-entrance' ) ).toBeNull();
		const copy = await browser.newPage( { viewport: { width: 1000, height: 700 } } );
		await copy.goto( `data:text/html,${ encodeURIComponent( portable ) }` );
		await copy.waitForTimeout( 100 ); expect( await pose( copy ) ).toMatchObject( { state: 'pending', opacity: '0' } );
		await copy.setViewportSize( { width: 768, height: 700 } );
		await copy.evaluate( () => scrollTo( 0, 1100 ) ); await copy.waitForTimeout( 100 );
		expect( ( await pose( copy ) ).effects.every( effect => effect.state === 'paused' ) ).toBe( true );
		await copy.evaluate( () => scrollTo( 200, 1100 ) ); await copy.waitForTimeout( 120 );
		expect( ( await pose( copy ) ).effects.map( effect => ( {name: effect.name,state: effect.state,timeline:effect.timeline} ) ) ).toEqual( [
			{ name:'neutralFade',state:'running',timeline:true }, {name:'neutralClip',state:'running',timeline:true},
		] );
		await copy.locator( '#entrance' ).evaluate( element => element.getAnimations().forEach( animation => { animation.pause(); animation.currentTime = 250; } ) );
		const reference = await browser.newPage( { viewport: { width:768,height:700 } } );
		await reference.goto( `data:text/html,${ encodeURIComponent( fixture(repeat) ) }` );
		await reference.evaluate( () => scrollTo(200,1100) ); await reference.waitForTimeout(120);
		await reference.locator('#entrance').evaluate( element => element.getAnimations().forEach( animation => {animation.pause();animation.currentTime=250;} ) );
		expect( await pose(copy) ).toEqual( await pose(reference) );
		const effects = ( await pose( copy ) ).effects;
		expect( effects.map( effect => ( {name:effect.name,timing:effect.timing,frames:effect.frames} ) ) ).toEqual( binding.cssAnimations );
		await copy.locator( '#entrance' ).evaluate( element => element.getAnimations().forEach( animation => animation.play() ) );
		await copy.waitForTimeout( 1000 ); expect( await pose( copy ) ).toMatchObject( { state:'complete',opacity:'1',effects:[] } );
		await copy.evaluate( () => scrollTo( 0, 0 ) ); await copy.waitForTimeout( 120 );
		expect( ( await pose( copy ) ).state ).toBe( repeat ? 'pending' : 'complete' );
		const noScript = await browser.newPage( { javaScriptEnabled:false } );
		await noScript.goto( `data:text/html,${ encodeURIComponent( portable ) }` );
		expect( await pose( noScript ) ).toMatchObject( { state:'complete',opacity:'1',effects:[] } );
	} finally { await browser.close(); if ( ! process.env.DLA_KEEP_DEVICE_EVIDENCE ) rmSync( directory, { recursive:true,force:true } ); }
}, 30_000 );

it( 'retains a real phone startup witness across transient viewport reflow and deferred play', async () => {
	const browser = await chromium.launch(); mkdirSync( '.tmp-test', {recursive:true} );
	const directory = mkdtempSync( join( process.cwd(), '.tmp-test/finite-startup-' ) );
	try {
		const context = await browser.newContext( { ...devices['iPhone 17'], viewport:{width:1440,height:900} } );
		await context.addInitScript( observeViewportEntrances );
		const source = await context.newPage(); await source.goto( `data:text/html,${ encodeURIComponent( fixture( false,true ) ) }` );
		await source.waitForTimeout( 1400 );
		expect( await pose( source ) ).toMatchObject( { state:'complete',opacity:'1' } );
		await collectViewportEntranceStartup( source,source );
		const portable = await exportSource( source,directory );
		const copyContext = await browser.newContext( { ...devices['iPhone 17'],viewport:{width:1440,height:900} } );
		const copy = await copyContext.newPage(); await copy.goto( `data:text/html,${ encodeURIComponent( portable ) }` );
		await copy.waitForTimeout( 100 );
		expect( ( await pose( copy ) ).effects.every( effect => effect.state === 'running' ) ).toBe( true );
		expect( ( await pose( copy ) ).effects ).toHaveLength( 2 );
		await copy.waitForTimeout( 1000 ); expect( await pose( copy ) ).toMatchObject( {state:'complete',opacity:'1',effects:[]} );
		expect( await copy.locator( '#entrance' ).getAttribute( 'data-dla-viewport-entrance-loss' ) ).toBeNull();
		const unknown = await browser.newPage( { ...devices['iPhone 17'],viewport:{width:1200,height:900} } );
		await unknown.goto( `data:text/html,${ encodeURIComponent( portable ) }` );
		expect( await unknown.locator( '#entrance' ).getAttribute( 'data-dla-viewport-entrance-loss' ) ).toBe( 'CSS startup context was not observed' );
		const measured = await observePage( unknown, `data:text/html,${ encodeURIComponent( portable ) }`,1200,100,null,undefined,undefined,false,true );
		expect( checkMotion(measured,measured).failures?.[0] ).toContain( 'viewport animation lifecycle unproven' );
	} finally {await browser.close();if(!process.env.DLA_KEEP_DEVICE_EVIDENCE)rmSync(directory,{recursive:true,force:true})}
},30_000 );

it( 'rejects altered authored timing even when every named CSS animation is registered', async () => {
	const browser = await chromium.launch(); mkdirSync('.tmp-test',{recursive:true});
	const directory=mkdtempSync(join(process.cwd(),'.tmp-test/finite-tamper-'));
	try {
		const source=await browser.newPage({viewport:{width:1000,height:700}});await source.addInitScript(observeViewportEntrances);
		await source.goto(`data:text/html,${encodeURIComponent(fixture(false))}`);
		await source.evaluate(()=>scrollTo(0,1100));await source.waitForTimeout(1200);
		const portable=await exportSource(source,directory);
		const copy=await browser.newPage({viewport:{width:1000,height:700}});
		await copy.goto(`data:text/html,${encodeURIComponent(portable.replace('neutralFade 450ms','neutralFade 451ms'))}`);
		await copy.evaluate(()=>scrollTo(0,1100));await copy.waitForTimeout(150);
		expect((await pose(copy)).effects).toHaveLength(2);
		expect((await pose(copy)).effects.every(effect=>effect.state==='paused')).toBe(true);
		expect(await copy.locator('#entrance').getAttribute('data-dla-viewport-entrance-loss')).toBe('authored paused CSS animation binding changed');
	} finally {await browser.close();if(!process.env.DLA_KEEP_DEVICE_EVIDENCE)rmSync(directory,{recursive:true,force:true})}
},15_000 );

it( 'keeps cancelled source motion and unwitnessed pending lifecycles explicitly unproven', async () => {
	const browser=await chromium.launch();
	try {
		const page=await browser.newPage({viewport:{width:1000,height:700}});await page.addInitScript(observeViewportEntrances);
		await page.goto(`data:text/html,${encodeURIComponent(fixture(false))}`);
		await stampViewportEntrances(page);
		expect(await page.locator('#entrance').getAttribute('data-dla-viewport-entrance-loss')).toBe('CSS viewport lifecycle was not observed');
		await page.evaluate(()=>scrollTo(0,1100));await page.waitForTimeout(150);
		await page.locator('#entrance').evaluate(e=>e.getAnimations().forEach(a=>a.cancel()));
		await page.waitForTimeout(50);await stampViewportEntrances(page);
		expect(await page.locator('#entrance').getAttribute('data-dla-viewport-entrance')).toBeNull();
		expect(await page.locator('#entrance').getAttribute('data-dla-viewport-entrance-loss')).toBe('Source CSS animation was cancelled before completion');
	} finally {await browser.close()}
},15_000 );

it( 'exposes missing terminal lifecycle evidence without manufacturing completion', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( {viewport:{width:1000,height:700}} ); await page.addInitScript(observeViewportEntrances);
		await page.goto(`data:text/html,${encodeURIComponent(fixture(false).replace("entry.target.dataset.state='complete';",''))}`);
		await page.evaluate(()=>scrollTo(0,1100));await page.waitForTimeout(1200);await stampViewportEntrances(page);
		expect(await page.locator('#entrance').getAttribute('data-dla-viewport-entrance')).toBeNull();
		expect(await page.locator('#entrance').getAttribute('data-dla-viewport-entrance-loss')).toBe('CSS entrance has no observed terminal attribute switch');
	} finally {await browser.close()}
},15_000 );

it( 'keeps animation object identity when a same-name sibling disappears during the scroll probe', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage( { viewport:{ width:1000,height:700 } } );
		const html = '<style>body{height:4000px}.effect{animation:same 2s both paused}@keyframes same{from{opacity:.2}to{opacity:1}}</style><div id="first" class="effect">First</div><div class="effect">Still paused</div>';
		const observation = await observePage( page, `data:text/html,${ encodeURIComponent(html) }`, 1000,0,null,undefined,async () => {
			await page.evaluate( () => {
				document.getElementById('first')!.getAnimations()[0]!.currentTime=200;
				addEventListener('scroll',()=>document.getElementById('first')!.remove(),{once:true});
			} );
		} );
		expect( observation.animations ).toEqual( ['same','same'] );
		expect( observation.responsiveAnimations ).toEqual( [] );
	} finally { await browser.close(); }
},30_000 );
