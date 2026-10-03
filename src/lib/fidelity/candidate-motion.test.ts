import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { validateMotionContract, verifyCandidateMotion, type MotionContract } from './candidate-motion.js';

const contract: MotionContract = {
	widths: [ 390, 768, 1440 ],
	routes: { '/': { ready: { source: 'body:not(.loading)', candidate: 'body:not(.loading)' },
		text: [ '#message' ], clicks: [ { trigger: '#control', target: '#message' } ], canvases: [ '#drawing' ] } },
};
const signals = [ 'canvas-2d', 'pointer-input', 'animation-frame', 'timed-dom-update', 'click-input' ];

describe( 'independent source/candidate interaction', () => {
	let browser: Browser;
	const server = createServer( ( request, response ) => {
		response.setHeader( 'content-type', 'text/html' );
		response.end( `<!doctype html><html><body class="loading"><button id="control">Replay</button><p id="message">Initializing</p><canvas id="drawing" width="390" height="200"></canvas>
		<script>
		const disabled = location.search.includes('static=1');
		const noPending = location.search.includes('no-pending=1');
		if (!disabled) {
		  if (noPending) document.querySelector('#message').textContent = '';
		  setTimeout(() => { document.querySelector('#message').textContent = 'READY'; document.body.classList.remove('loading'); }, 100);
		  document.querySelector('#control').addEventListener('click', () => { document.querySelector('#message').textContent = noPending ? '' : 'Initializing'; setTimeout(() => document.querySelector('#message').textContent = 'READY', 150); });
		  window.addEventListener('mousemove', () => document.querySelector('#drawing').getContext('2d').fillRect(5, 5, 30, 30));
		  if (location.search.includes('startup-ripple=1')) {
		    const canvas = document.querySelector('#drawing');
		    let tick = 0;
		    const paint = setInterval(() => { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas.getContext('2d').fillRect(40 + tick++, 5, 15, 15); }, 60);
		    setTimeout(() => clearInterval(paint), 3400);
		  }
		} else { document.querySelector('#message').textContent = 'READY'; document.body.classList.remove('loading'); }
		</script></body></html>` );
	} );
	let origin: string;
	beforeAll( async () => {
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		browser = await chromium.launch();
	} );
	afterAll( async () => {
		await browser?.close();
		server.closeAllConnections();
		await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
	} );

	it( 'requires explicit bounded source/candidate probes', () => {
		expect( () => validateMotionContract( contract ) ).not.toThrow();
		expect( () => validateMotionContract( { ...contract, widths: [] } ) ).toThrow( /widths/ );
	} );

	it( 'proves a neutral live candidate while recording that its portable capture is still static', async () => {
		const evidence = await verifyCandidateMotion( browser, '/', 390, origin, origin, contract.routes[ '/' ], signals );
		expect( evidence ).toMatchObject( { capture: 'unreproduced', pass: true, failures: [] } );
	} );

	it( 'rejects a static candidate with identical settled text and markup', async () => {
		const evidence = await verifyCandidateMotion( browser, '/', 390, origin, `${ origin }?static=1`, contract.routes[ '/' ], signals );
		expect( evidence.pass ).toBe( false );
		expect( evidence.failures ).toContain( 'startup text does not transition: #message' );
		expect( evidence.failures ).toContain( 'candidate pointer effect missing: #drawing' );
		expect( evidence.failures ).toContain( 'candidate click replay missing: #control' );
	}, 30_000 );

	it( 'rejects a live candidate that skips the source pending phase at startup and on click', async () => {
		const evidence = await verifyCandidateMotion( browser, '/', 390, origin, `${ origin }?no-pending=1`, contract.routes[ '/' ], signals );
		expect( evidence.failures ).toContain( 'startup text phase differs: #message' );
		expect( evidence.failures ).toContain( 'click replay text phase differs: #control' );
	}, 30_000 );

	it( 'waits for a finite startup canvas ripple before checking the pointer control', async () => {
		const url = `${ origin }?startup-ripple=1`;
		const evidence = await verifyCandidateMotion( browser, '/', 390, url, url, contract.routes[ '/' ], signals );
		expect( evidence ).toMatchObject( { pass: true, failures: [] } );
		expect( evidence.observations[ 'canvas #drawing' ] ).toMatchObject( { source: { idle: true, responds: true }, candidate: { idle: true, responds: true } } );
	}, 30_000 );
} );
