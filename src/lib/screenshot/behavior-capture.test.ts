import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSourceBehavior } from './behavior-capture.js';
import { timeDependentTargets } from '../behavior-model.js';
import { learnClockBindings } from '../clock-behavior.js';

describe( 'automatic source behavior evidence', () => {
	let browser: Browser;
	let origin: string;
	const server = createServer( ( request, response ) => {
		const variant = request.url?.includes( 'second' );
		const field = variant ? 'renamed-message' : 'editorial';
		const button = variant ? 'different-trigger' : 'replay';
		const text = variant ? 'Other saved copy' : 'Readable text';
		response.setHeader( 'content-type', 'text/html; charset=utf-8' );
		response.end( `<!doctype html><html><body><div id="${ button }">Replay</div><span id="${ field }">${ text }</span><span id="dynamic-stamp"></span><canvas id="drawing" width="400" height="200"></canvas><script>
		document.getElementById('dynamic-stamp').textContent=new Date().toISOString();
		const value=document.getElementById('${ field }'), saved=value.textContent;
		function type(){value.textContent='';let index=0;const timer=setInterval(()=>{value.textContent+=saved[index++];if(index===saved.length)clearInterval(timer)},${ variant ? 12 : 9 });}
		document.getElementById('${ button }').addEventListener('click',type); type();
		window.addEventListener('mousemove',()=>{const c=document.getElementById('drawing').getContext('2d');c.beginPath();${ variant ? 'c.moveTo(10,10);c.lineTo(200,100);c.stroke();' : 'c.arc(30,30,20,0,Math.PI*2);c.fill();' }});
		</script></body></html>` );
	} );
	beforeAll( async () => {
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		browser = await chromium.launch();
	} );
	afterAll( async () => {
		await browser.close(); server.closeAllConnections();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
	} );
	for ( const variant of [ false, true ] ) {
		it( `discovers renamed text/click and a ${ variant ? 'line' : 'circle' } canvas without a recipe`, async () => {
			const page = await browser.newPage( { viewport: { width: 768, height: 900 } } );
			try {
				const result = await captureSourceBehavior( page, `${ origin }/${ variant ? 'second' : '' }`, { startupMs: 500, replayMs: 500 } );
				const field = variant ? '#renamed-message' : '#editorial';
				const trigger = variant ? '#different-trigger' : '#replay';
				expect( result.status ).toBe( 'observed_untranslated' );
				expect( result.startup.text[ field ].length ).toBeGreaterThan( 3 );
				expect( result.replays.find( row => row.selector === trigger )?.trace.text[ field ].length ).toBeGreaterThan( 3 );
				expect( result.pointer.after[ '#drawing' ] ).not.toBe( result.pointer.before[ '#drawing' ] );
				const operations = result.pointer.trace.canvas[ '#drawing' ].methods;
				expect( operations[ variant ? 'lineTo' : 'arc' ] ).toBeGreaterThan( 0 );
				expect( operations[ variant ? 'arc' : 'lineTo' ] ).toBeUndefined();
			} finally { await page.close(); }
		} );
	}
	it( 'proves time-dependent content under controlled Date without mistaking editorial text for a clock', async () => {
		const firstPage = await browser.newPage();
		const secondPage = await browser.newPage();
		try {
			const first = await captureSourceBehavior( firstPage, `${ origin }/`, { startupMs: 500, maxClicks: 0, fixedTime: '2031-02-03T04:17:00Z' } );
			const second = await captureSourceBehavior( secondPage, `${ origin }/`, { startupMs: 500, maxClicks: 0, fixedTime: '2032-08-14T19:43:00Z' } );
			expect( timeDependentTargets( first, second ) ).toEqual( [ '#dynamic-stamp' ] );
			const learned = learnClockBindings( first, second );
			expect( learned ).toEqual( { bindings: [ { selector: '#dynamic-stamp', role: 'iso', confidence: 'two_controlled_dates' } ], unsupported: [] } );
		} finally { await firstPage.close(); await secondPage.close(); }
	} );
} );
