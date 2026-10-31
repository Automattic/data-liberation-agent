import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

// Issue #917: capture must never save a crashed client app's framework error
// shell as page content. Two neutral fixtures share one real-Chromium capture:
//
//  - /crashes-into-shell: the page's client script replaces the document with
//    an error shell after load (what Next.js does when the app crashes after
//    hydration). Detection refuses to persist it and the route fails by name.
//  - /overlay-owned-crash: the runtime OWNS its takeover overlay; deleting the
//    overlay from the live DOM (the old Tier-3 force-remove) makes its next
//    commit throw and crash into the same shell. Overlay dismissal now hides
//    in place, so the page survives capture.
//
//  - /crashes-once: the app crashes into the shell on its first load only,
//    the transient failure a live platform serves now and then. Capture
//    retries the route in a fresh context and keeps the real page.
//
// Without the fixes both routes save the shell document as their page HTML and
// both tests below fail on it.

const SHELL_SELECTOR = 'html#client-error-shell';
const SHELL_TEXT = 'Application error: a client-side exception has occurred';

const home = `<!doctype html><html><head><title>Home</title></head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <main><h1>Ordinary home page</h1><p>Nothing here ever crashes.</p></main>
</body></html>`;

const crashesIntoShell = `<!doctype html><html><head><title>Account sign in</title></head><body>
  <main><h1>Account sign in</h1><form><input type="email"><button>Sign in</button></form></main>
  <script>
    // A client runtime that crashes after hydration swaps the whole document
    // for its framework's error shell.
    setTimeout(function () {
      var shell = document.createElement('html');
      shell.id = 'client-error-shell';
      shell.innerHTML = '<head><title>Error</title></head><body><h2>${SHELL_TEXT}</h2></body>';
      document.removeChild(document.documentElement);
      document.appendChild(shell);
    }, 100);
  </script>
</body></html>`;

const overlayOwnedCrash = `<!doctype html><html><head><title>Account sign in</title></head><body>
  <main><h1>Account sign in</h1><form><input type="email"><button>Sign in</button></form></main>
  <div id="promo" role="dialog" aria-modal="true"
       style="position:fixed;inset:0;background:#fff;z-index:9999"><h2>Session expired</h2></div>
  <script>
    // The framework owns this overlay. If anything DELETES it from the live
    // DOM, the next framework commit that touches it throws ("Failed to
    // execute 'removeChild' on 'Node'") and the app crashes into its error
    // shell — exactly what a hard overlay removal used to cause during capture.
    (function () {
      var overlay = document.getElementById('promo');
      setInterval(function () {
        if (overlay.isConnected) return;
        var shell = document.createElement('html');
        shell.id = 'client-error-shell';
        shell.innerHTML = '<head><title>Error</title></head><body><h2>${SHELL_TEXT}</h2></body>';
        document.removeChild(document.documentElement);
        document.appendChild(shell);
      }, 50);
    })();
  </script>
</body></html>`;

describe.skipIf( !!process.env.SKIP_BROWSER_TESTS || !existsSync( chromium.executablePath() ) )( 'capture refuses a crashed client-error shell document (#917)', () => {
	let server: Server;
	let origin: string;
	let outputDir: string;
	let result: Awaited< ReturnType< typeof captureScreenshots > >;
	let manifest: { entries: Record< string, { html?: string; failures?: Array< { stage: string; error: string } > } > };

	const crashUrl = () => `${ origin }/crashes-into-shell`;
	const overlayUrl = () => `${ origin }/overlay-owned-crash`;
	const onceUrl = () => `${ origin }/crashes-once`;

	beforeAll( async () => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		outputDir = mkdtempSync( join( parent, 'issue-917-' ) );
		const pages: Record< string, string > = { '/': home, '/crashes-into-shell': crashesIntoShell, '/overlay-owned-crash': overlayOwnedCrash };
		let onceServed = false;
		server = createServer( ( request, response ) => {
			response.setHeader( 'Content-Type', 'text/html' );
			if ( request.url === '/crashes-once' ) {
				response.end( onceServed ? home.replace( 'Ordinary home page', 'Recovered page' ) : crashesIntoShell );
				onceServed = true;
				return;
			}
			response.end( pages[ request.url ?? '' ] ?? '' );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		// One browser pass covers both fixtures (and the ordinary home page as
		// the device-mode entrypoint). The shell selectors are what a platform
		// adapter declares; the neutral fixtures use a neutral one.
		result = await captureScreenshots( {
			urls: [ `${ origin }/`, crashUrl(), overlayUrl(), onceUrl() ],
			primaryUrl: `${ origin }/`,
			outputDir,
			concurrency: 1,
			settleMs: 0,
			learnFluid: false,
			clientErrorShellSelectors: [ SHELL_SELECTOR ],
		} );
		manifest = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) );
	}, 120_000 );

	afterAll( async () => {
		await new Promise( resolve => server.close( resolve ) );
		rmSync( outputDir, { recursive: true, force: true } );
	} );

	it( 'does not persist a document whose client app crashed into the error shell', () => {
		const entry = manifest.entries[ crashUrl() ];
		expect( entry?.html ).toBeUndefined();
		// The route fails, naming the page and the shell it hit.
		expect( result.failed ).toBe( 1 );
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'failures.json' ), 'utf8' ) ) as Array< { url: string; stage: string; error: string } >;
		const shellFailure = failures.find( ( failure ) => failure.url === crashUrl() && failure.stage === 'content' );
		expect( shellFailure?.error ).toMatch( /client error shell/ );
		expect( shellFailure?.error ).toContain( SHELL_SELECTOR );
	} );

	it( 'captures the page whose owned overlay capture hid instead of deleted', () => {
		const entry = manifest.entries[ overlayUrl() ];
		expect( entry?.html ).toBeDefined();
		const html = readFileSync( join( outputDir, entry!.html! ), 'utf8' );
		expect( html ).toContain( 'Account sign in' );
		// The document element is the page's, never the crash shell (the shell's
		// string literal inside the fixture's script text does not count).
		expect( html ).not.toContain( '<html id="client-error-shell"' );
	} );

	it( 'leaves an ordinary page untouched', () => {
		const entry = manifest.entries[ `${ origin }/` ];
		expect( entry?.html ).toBeDefined();
		const html = readFileSync( join( outputDir, entry!.html! ), 'utf8' );
		expect( html ).toContain( 'Ordinary home page' );
	} );
	it( 'retries a route whose app crashed into the shell once, and keeps the real page', () => {
		const entry = manifest.entries[ onceUrl() ];
		expect( entry?.html ).toBeDefined();
		expect( readFileSync( join( outputDir, entry!.html! ), 'utf8' ) ).toContain( 'Recovered page' );
	} );
} );
