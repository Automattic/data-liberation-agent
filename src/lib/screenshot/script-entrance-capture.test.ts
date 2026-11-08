import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// Framer-Motion-style entrances (#1466): a script writes the pose, through rAF
// frames or WAAPI it never commits, and transform settles after opacity. Like a
// component tree that remounts at a breakpoint, every resize resets each entrance
// to its start pose; the capture's own width probes trigger that.
const fixture = `<!doctype html><html><head><style>
	body{margin:0}.enter{height:120px;margin:20px;background:#246}.spacer{height:2400px}
</style></head><body><main>
	<div class="enter raf" id="raf-top"></div><div class="enter waapi" id="waapi-top"></div>
	<div class="spacer"></div>
	<div class="enter raf" id="raf-bottom"></div><div class="enter waapi" id="waapi-bottom"></div>
</main><script>
	const ease = t => 1 - Math.pow(1 - Math.min(1, t), 3);
	const play = element => {
		if (element.classList.contains('waapi')) {
			element.animate({ opacity: [0, 1] }, { duration: 300, fill: 'both' });
			element.animate({ transform: ['translateY(40px)', 'none'] }, { duration: 1200, fill: 'both' });
			return;
		}
		const start = performance.now();
		const frame = now => {
			const opacity = ease((now - start) / 300), y = 40 * (1 - ease((now - start) / 1200));
			element.style.opacity = String(opacity);
			element.style.transform = y > 0 ? 'translateY(' + y + 'px)' : 'none';
			if (y > 0) requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	};
	let observer;
	const mount = () => {
		observer?.disconnect();
		observer = new IntersectionObserver(entries => {
			for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); play(entry.target); }
		});
		for (const element of document.querySelectorAll('.enter')) {
			element.getAnimations().forEach(animation => animation.cancel());
			element.setAttribute('style', 'opacity: 0; transform: translateY(40px);');
			observer.observe(element);
		}
	};
	mount();
	addEventListener('resize', mount);
</script></body></html>`;

// One real capture (~15s).
it.skipIf( skipBrowser )( 'serializes script entrances above and below the fold at their settled pose after width probes remount them', async () => {
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/script-entrance-' ) );
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
			viewports: [ { id: 'desktop', width: 1280, height: 720 } ] } );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		const $ = cheerio.load( readFileSync( join( outputDir, entry.html ), 'utf8' ) );
		const poses = Object.fromEntries( $( '.enter' ).toArray().map( element => {
			const style = $( element ).attr( 'style' ) ?? '';
			return [ $( element ).attr( 'id' ), {
				opacity: /(?:^|;)\s*opacity\s*:\s*([^;]+)/.exec( style )?.[ 1 ].trim(),
				// WAAPI's committed end pose interpolates \`none\` as a zero translation.
				transform: /(?:^|;)\s*transform\s*:\s*([^;]+)/.exec( style )?.[ 1 ].trim().replace( /^translateY\(0px\)$/, 'none' ),
			} ];
		} ) );
		const settled = { opacity: '1', transform: 'none' };
		expect( poses ).toEqual( { 'raf-top': settled, 'waapi-top': settled, 'raf-bottom': settled, 'waapi-bottom': settled } );
	} finally {
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
