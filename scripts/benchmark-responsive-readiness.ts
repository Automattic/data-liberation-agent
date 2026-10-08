// Run with: node --import tsx scripts/benchmark-responsive-readiness.ts
// Diagnostic of the source primitive, not a frozen-fidelity comparison.
import { chromium } from 'playwright';
import { learnAndApplyFluidGeometry } from '../src/lib/screenshot/fluid-capture.js';
import { dismissOverlays, triggerLazyLoad } from '../src/lib/screenshot/page-helpers.js';

const url = 'https://altrum-template.webflow.io/project/forma-digital';
const browser = await chromium.launch( { headless: true } );
try {
	for ( const width of process.argv[ 2 ] ? [ Number( process.argv[ 2 ] ) ] : [ 390, 768, 1440 ] ) {
		const page = await browser.newPage( { viewport: { width, height: 900 } } );
		const started = performance.now();
		await page.goto( url, { waitUntil: 'networkidle' } );
		await dismissOverlays( page );
		await triggerLazyLoad( page );
		const prepared = performance.now();
		const result = await learnAndApplyFluidGeometry( page, {
			settleMs: 1000,
			onProgress: ( sample, elements ) => {
				console.info( JSON.stringify( { width, sample, elements, elapsedMs: Math.round( performance.now() - prepared ) } ) );
				if ( process.env.DLA_READINESS_DIAGNOSTIC ) void page.evaluate( () => [ ...document.images ].filter( image => ! image.complete ).map( image => ( { src: image.src, rect: image.getBoundingClientRect().toJSON(), loading: image.loading } ) ) )
					.then( pending => console.info( JSON.stringify( { width, sample, pending } ) ) );
			},
		} );
		console.info( JSON.stringify( { url, width, preparationMs: Math.round( prepared - started ), learningMs: Math.round( performance.now() - prepared ), result,
			observed: await page.evaluate( () => ( {
				scrollY,
				text: document.body.innerText,
				images: [ ...document.images ].map( image => ( { src: image.currentSrc, complete: image.complete, width: image.naturalWidth } ) ),
				landmarks: [ ...document.querySelectorAll( 'h1, h2, main, header, footer' ) ].map( element => ( { tag: element.tagName, text: element.textContent, rect: element.getBoundingClientRect().toJSON() } ) ),
			} ) ),
		} ) );
		await page.close();
	}
} finally { await browser.close(); }
