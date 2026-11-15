import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../../index.js';

// One browser capture (~20s): the image follows a definite CSS container whose
// mobile rule is affine, while its desktop rule is proportional (#1215).
it.skipIf( process.env.SKIP_BROWSER_TESTS )( 'exports runtime image sizes across container breakpoints without the runtime', async () => {
	const html = `<!doctype html><html><head><title>Responsive image</title><style>
		body{margin:0}.owner{width:100%;height:35.9vw}img{display:block;object-fit:cover}
		@media(max-width:999px){.owner{height:calc(67.2vw + 57px)}}
		</style></head><body><div class="owner"><img alt="Hero" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E"></div>
		<script>const resize=()=>{const i=document.querySelector('img'),r=i.parentElement.getBoundingClientRect();
		i.style.width=r.width+'px';i.style.height=r.height+'px';};addEventListener('resize',resize);resize();</script></body></html>`;
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( html );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'fluid-image-' ) );
	const browser = await chromium.launch();
	const source = await browser.newPage();
	const copy = await browser.newPage( { javaScriptEnabled: false } );
	try {
		await captureWebsite( { url, outputDir, trustedOrigins: [ url ], routeLimit: 1, deviceMode: 'reflow-only', learnFluid: true } );
		await source.goto( url );
		await copy.setContent( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) );
		for ( const width of [ 390, 414, 768, 800, 1440 ] ) {
			await source.setViewportSize( { width, height: 900 } );
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => source.locator( 'img' ).evaluate( node => node.getBoundingClientRect().width ) ).toBe( width );
			const expected = await source.locator( 'img' ).evaluate( node => node.getBoundingClientRect().height );
			expect( await copy.locator( 'img' ).evaluate( node => node.getBoundingClientRect().height ), `${ width }px` ).toBeCloseTo( expected, 0 );
		}
	} finally {
		await browser.close();
		await new Promise( resolve => server.close( resolve ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 120_000 );
