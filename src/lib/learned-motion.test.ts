import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSourceBehavior, type SourceBehavior } from './screenshot/behavior-capture.js';
import { learnMotion, type LearnedMotion } from './learned-motion.js';
import { learnedMotionContract } from './learned-motion-promotion.js';
import { MOTION_RUNTIME } from './motion-runtime.js';
import { verifyCandidateMotion } from './fidelity/candidate-motion.js';

// Neutral source: names, copy, timings and glyphs share nothing with any real site.
const SOURCE = `<!doctype html><html lang="en"><body>
<div id="headline-box"><small id="headline-caption" style="visibility:hidden">Title</small> <b id="headline">Harbor lights</b></div>
<div id="notice-box"><em id="notice">Waiting<i id="spinner"></i></em> <span id="badge" style="display:none">*</span> <span id="footnote"></span></div>
<div id="clock-box"><span id="hh">--</span>:<span id="mm">--</span> <span id="meridiem"></span> <span id="zone"></span> <span id="day"></span></div>
<script>
const $=id=>document.getElementById(id),wait=ms=>new Promise(r=>setTimeout(r,ms)),two=v=>String(v).padStart(2,'0');
async function type(el,text,ms){el.textContent='';for(const c of text){el.textContent+=c;await wait(ms)}}
let dotsTimer;
function pending(){$('notice').innerHTML='Waiting<i id="spinner"></i>';$('footnote').textContent='';$('badge').style.display='none';clearInterval(dotsTimer);let n=0;dotsTimer=setInterval(()=>{n=(n+1)%4;const s=$('spinner');if(s)s.textContent='.'.repeat(n)},200)}
async function notice(){clearInterval(dotsTimer);await type($('notice'),'Ready now',40);$('badge').style.display='inline';await type($('footnote'),'Online since 1999',40)}
async function headline(delay){$('headline-caption').style.visibility='hidden';$('headline').textContent='';await wait(delay);$('headline-caption').style.visibility='visible';await type($('headline'),'Harbor lights',40)}
function render(){const d=new Date(),h=d.getHours(),o=-d.getTimezoneOffset()/60;$('hh').textContent=two(h%12||12);$('mm').textContent=two(d.getMinutes());$('meridiem').textContent=h<12?'AM':'PM';$('zone').textContent='(GMT '+(o>=0?'+':'')+o+')'}
function date(){const p=new Intl.DateTimeFormat('en',{weekday:'long',month:'short',day:'numeric',year:'numeric'}).formatToParts(new Date()),g=t=>(p.find(x=>x.type===t)||{}).value||'';return(g('weekday')+', '+g('month')+' '+g('day')+', '+g('year')).toUpperCase()}
async function clock(){$('hh').textContent=$('mm').textContent='~~';$('meridiem').textContent='';$('zone').textContent='';$('day').textContent='';await wait(100);$('hh').textContent=$('mm').textContent='00';await wait(100);render();await wait(200);await type($('day'),date(),40)}
$('headline').textContent='';$('meridiem').textContent='';pending();setTimeout(clock,200);
(async()=>{await headline(300);await wait(150);await notice()})();
$('headline-box').addEventListener('click',()=>headline(80));
$('notice-box').addEventListener('click',async()=>{pending();await wait(400);await notice()});
$('clock-box').addEventListener('click',clock);
</script></body></html>`;

describe( 'learned editable motion', () => {
	let browser: Browser;
	let origin: string;
	let candidateHtml = '';
	const server = createServer( ( request, response ) => {
		response.setHeader( 'content-type', 'text/html; charset=utf-8' );
		response.end( request.url?.startsWith( '/copy' ) ? candidateHtml : request.url?.startsWith( '/runtime.js' ) ? MOTION_RUNTIME : SOURCE );
	} );
	let first: SourceBehavior;
	let learned: LearnedMotion;
	beforeAll( async () => {
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		browser = await chromium.launch();
		const a = await browser.newPage( { timezoneId: 'UTC' } );
		const b = await browser.newPage( { timezoneId: 'Europe/Berlin' } );
		first = await captureSourceBehavior( a, `${ origin }/`, { startupMs: 12000, quietMs: 1500, replayMs: 2500, fixedTime: '2031-02-03T04:17:00Z' } );
		const second = await captureSourceBehavior( b, `${ origin }/`, { startupMs: 12000, quietMs: 1500, maxClicks: 0, fixedTime: '2032-08-14T19:43:00Z' } );
		learned = learnMotion( first, second );
		// The capture's saved DOM: settled, script-free.
		const settled = ( await a.content() ).replace( /<script[\s\S]*?<\/script>/g, '' );
		await Promise.all( [ a.close(), b.close() ] );
		candidateHtml = settled.replace( '</body>', `<span hidden data-blocks-engine-motion-steps="${ JSON.stringify( learned.steps ).replace( /"/g, '&quot;' ) }"></span><span hidden data-blocks-engine-live-clock="${ JSON.stringify( learned.clock ).replace( /"/g, '&quot;' ) }"></span><script defer src="/runtime.js"></script></body>` );
	}, 90_000 );
	afterAll( async () => {
		await browser.close(); server.closeAllConnections();
		await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
	} );

	it( 'infers sequence, pending dots, reveals, click replays and clock frames without configuration', () => {
		expect( learned.unsupported ).toEqual( [] );
		expect( learned.steps.map( ( step ) => step.selector ) ).toEqual( [ '#headline', '#notice', '#footnote' ] );
		const [ headline, notice, footnote ] = learned.steps;
		expect( headline ).toMatchObject( { clickSelector: '#headline-box', revealSelectors: [ { selector: '#headline-caption', hideWith: 'visibility' } ] } );
		expect( headline.delayMs ).toBeGreaterThan( 200 );
		expect( headline.replayDelayMs ).toBeGreaterThan( 40 );
		expect( notice ).toMatchObject( { pendingText: 'Waiting', pendingDots: true, clickSelector: '#notice-box' } );
		expect( notice.pendingIntervalMs ).toBeGreaterThanOrEqual( 150 );
		expect( footnote ).toMatchObject( { clickSelector: '#notice-box', revealSelectors: [ { selector: '#badge', hideWith: 'display' } ] } );
		// 40ms source cadence; timer jitter on a loaded machine only lengthens it.
		for ( const step of learned.steps ) expect( step.intervalMs ).toBeGreaterThanOrEqual( 35 );
		expect( learned.clock ).toMatchObject( {
			hourSelector: '#hh', minuteSelector: '#mm', timezoneSelector: '#zone', ampmSelector: '#meridiem', dateSelector: '#day',
			triggerSelector: '#clock-box', hourCycle: '12', initialFrame: '--', stages: '~~,00',
		} );
		// No editorial copy is carried in the program; it is read from the page.
		expect( JSON.stringify( learned ) ).not.toMatch( /Harbor|Ready now|Online since/ );
	} );

	it( 'reproduces the learned behavior from the saved DOM against the live source', async () => {
		const evidence = await verifyCandidateMotion( browser, '/', 768, `${ origin }/`, `${ origin }/copy`, learnedMotionContract( learned ), [ 'timed-dom-update', 'click-input' ] );
		expect( evidence.failures ).toEqual( [] );
	}, 90_000 );

	it( 'replays edited copy rather than captured source text', async () => {
		const page = await browser.newPage();
		try {
			const saved = candidateHtml;
			candidateHtml = saved.replace( 'Harbor lights', 'Edited headline' );
			await page.goto( `${ origin }/copy` );
			await page.waitForFunction( () => document.querySelector( '#headline' )?.textContent === 'Edited headline' );
			candidateHtml = saved;
		} finally { await page.close(); }
	} );

	it( 'reports canvas drawing as untranslated', async () => {
		const page = await browser.newPage();
		try {
			await page.route( `${ origin }/canvas`, ( route ) => route.fulfill( { contentType: 'text/html', body: '<canvas id="surface" width="200" height="100"></canvas><script>addEventListener("mousemove",()=>{const c=document.getElementById("surface").getContext("2d");c.beginPath();c.arc(20,20,9,0,7);c.fill()})</script>' } ) );
			const observed = await captureSourceBehavior( page, `${ origin }/canvas`, { startupMs: 200, maxClicks: 0 } );
			expect( learnMotion( observed, observed ).unsupported ).toEqual( [ expect.objectContaining( { selector: '#surface', reason: expect.stringContaining( 'arc' ) } ) ] );
		} finally { await page.close(); }
	} );
} );
