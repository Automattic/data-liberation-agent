import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { captureWebsite } from '../../index.js';
import { checkFidelity } from './check.js';
import { createReferenceCollector, readFrozenObservation, type FidelityReference } from './reference.js';

// One public capture/compare plus two rejected references (~45s idle). No framework
// names or error-message allowlist: admission depends on the rendered document.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'proves settled after-load runtime faults but rejects unsettled documents and client error shells', async ({ serve, newPage }) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const root = mkdtempSync( join( process.cwd(), '.tmp-test/reference-runtime-' ) );
	const message = 'Neutral recoverable runtime fault';
	const html = `<!doctype html><html><head><title>Perpetual scripted pulse</title><style>.dot{width:12px;height:12px;border-radius:50%;background:#e85a1c}</style></head><body><main><h1>Stable content</h1><p>Static content.</p><div class="dot"><span>Logo</span></div></main><script>const d=document.querySelector('.dot');(function f(t){d.style.transform=\`scale(\${1+0.5*Math.abs(Math.sin(t/400))})\`;d.style.willChange=Math.floor(t/200)%2?'transform':'';requestAnimationFrame(f)})(0);addEventListener('load', () => { throw new Error('${ message }'); });</script></body></html>`;
	const { server } = await serve(( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.writeHead( 404 ).end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/shell' ? html.replace( '<script>', '<script>document.body.innerHTML = \'<main id="client-error-shell">Application failed</main>\';' )
			: request.url === '/unsettled' ? html.replace( "throw new Error(", 'const pendingLayout = setInterval(() => { document.querySelector("main").style.marginTop = (Date.now() % 100) + "px"; }, 50); throw new Error(' ).replace( '});</script>', 'clearInterval(pendingLayout); });</script>' ) : html );
	});

	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	try {
		const result = await captureWebsite( { url, outputDir: root, captureImages: false, trustedOrigins: [ url ], learnFluid: false }, {
			findAdapter: () => ( { id: 'neutral-runtime', detect: () => true, discover: async () => ( { urls: [ { url } ] } ), liberation: { clientErrorShellSelectors: [ '#client-error-shell' ] } } ),
		} );
		expect( result.summary.routesFailed ).toBe( 0 );
		const reference = JSON.parse( readFileSync( join( root, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		expect( reference.entries.length ).toBeGreaterThan( 0 );
		const report = await checkFidelity( { directory: root, settleMs: 0 } );
		for ( const entry of reference.entries ) {
			expect( entry.readiness.ready ).toBe( true );
			expect( entry.readiness.reasons ).toEqual( [] );
			expect( entry.readiness.diagnostics?.some( diagnostic => diagnostic.startsWith( 'source perpetual motion excluded: html:nth-child(1) > body:nth-child(2) > main:nth-child(1) > div:nth-child(3)' ) ) ).toBe( true );
			expect( entry.readiness.diagnostics ).toContain( `source runtime error: ${ message }` );
			expect( () => readFrozenObservation( root, entry ) ).not.toThrow();
		}
		expect( report.pending ).toEqual( [] );
		expect( report.pass ).toBe( true );

		// The same captured fault cannot excuse a reference that became an
		// error shell. Use the same selector matcher capture's adapter declares.

		{
			const page = await newPage();
			const target = `${ url }shell`;
			const collector = createReferenceCollector( root, target, [ target ], { clientErrorShellSelectors: [ '#client-error-shell' ] } );
			await collector.observe( page, target, 'desktop', [ `source runtime error: ${ message }` ], { isMobile: false, hasTouch: false }, { id: 'desktop', width: 1440, height: 900, referenceWidths: [ 1440 ] } );
			const receipt = join( root, 'shell-receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
			const shell = ( JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference ).entries[ 0 ];
			expect( shell.readiness.ready ).toBe( false );
			expect( shell.readiness.reasons ).toContain( 'source client error shell: #client-error-shell' );
			expect( () => readFrozenObservation( root, shell ) ).toThrow( 'Source evidence unready' );

			// The same after-load error on a continually changing document cannot
			// turn a failed settlement check into admitted evidence.
			const unsettledUrl = `${ url }unsettled`;
			const unsettledCollector = createReferenceCollector( root, unsettledUrl, [ unsettledUrl ] );
			await unsettledCollector.observe( page, unsettledUrl, 'desktop', [ `source runtime error: ${ message }` ], { isMobile: false, hasTouch: false }, { id: 'desktop', width: 1440, height: 900, referenceWidths: [ 1440 ] } );
			const unsettled = ( JSON.parse( readFileSync( unsettledCollector.finalize( receipt ), 'utf8' ) ) as FidelityReference ).entries[ 0 ];
			expect( unsettled.readiness.ready ).toBe( false );
			expect( unsettled.readiness.reasons ).toContain( 'source document did not settle' );
			expect( unsettled.readiness.diagnostics ).toContain( `source runtime error: ${ message }` );
			expect( () => readFrozenObservation( root, unsettled ) ).toThrow( 'Source evidence unready' );
		}
	} finally {

		rmSync( root, { recursive: true, force: true } );
	}
}, 240_000 );
