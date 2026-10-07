import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanupPolicy } from './source-cleanup.js';
import { capture as wixCapture } from '../adapters/wix/capture.js';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { exportWebsiteCapture } from './capture-export.js';

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
	server?.closeAllConnections();
	if ( server ) await new Promise< void >( ( resolve ) => server!.close( () => resolve() ) );
	server = undefined;
	if ( directory ) rmSync( directory, { recursive: true, force: true } );
	directory = undefined;
} );

// Wix's members login, as its runtime renders it: the same dialog layout opens
// as a pop-up from the header "Sign In" control, and replaces the whole site
// container on a members-only page.
const membersDialog = `<div role="dialog" aria-modal="true" data-testid="siteMembersDialogLayout">
<h2>Log In</h2><form data-testid="emailAuth"><input type="email" placeholder="Email"><input type="password" placeholder="Password"><button data-testid="submit">Log In</button></form></div>`;

const shell = ( title: string, main: string, script = '' ) => `<!doctype html><html><head><meta charset="utf-8"><title>${ title }</title>
<link rel="canonical" href="/"><style>body{margin:0;font:16px Arial}header,main,footer{padding:20px}h1{font-family:Georgia}</style></head>
<body><div id="SITE_CONTAINER"><header id="SITE_HEADER"><nav><a href="/">Home</a> <a href="/dues">Dues</a></nav>
<button type="button" aria-haspopup="dialog" id="sign-in">Sign In</button></header>
<main id="PAGES_CONTAINER">${ main }</main><footer id="SITE_FOOTER">© Owner HOA</footer></div>
<script>document.getElementById('sign-in').addEventListener('click',()=>{const layer=document.createElement('div');layer.innerHTML=${ JSON.stringify( membersDialog ) };document.body.append(layer.firstElementChild)});${ script }</script>
</body></html>`;

const pages: Record< string, string > = {
	'/': shell( 'Home | Owner HOA', `<h1>Welcome neighbours</h1><p>${ 'Owner home content. '.repeat( 20 ) }</p>` ),
	// The server answers the members-only route with the site shell; the
	// runtime then swaps everything for the blocking members gate.
	'/dues': shell( 'Owner HOA', '<p>Loading</p>', `setTimeout(()=>{document.getElementById('SITE_CONTAINER').innerHTML='<div data-testid="siteMembersDialogBlockingLayer">'+${ JSON.stringify( membersDialog ) }+'</div>'},50);` ),
};

// The fixture's own runtime script spells the dialog out; assert on the document.
const markup = ( html: string ) => html.replace( /<script[\s\S]*?<\/script>/gi, '' );

async function source(): Promise< string > {
	server = createServer( ( req, res ) => {
		const page = pages[ new URL( req.url ?? '/', 'http://x' ).pathname ];
		res.statusCode = page ? 200 : 404;
		res.setHeader( 'content-type', 'text/html' );
		res.end( page ?? 'not found' );
	} );
	await new Promise< void >( ( resolve ) => server!.listen( 0, '127.0.0.1', resolve ) );
	return `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
}

it( 'captures a members-only route as an editable placeholder over the public site shell, and never the provider login', async () => {
	const home = await source();
	const dues = new URL( '/dues', home ).href;
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	directory = mkdtempSync( join( process.cwd(), '.tmp-test', 'access-gate-' ) );
	const result = await captureScreenshots( {
		urls: [ home, dues ], primaryUrl: home, outputDir: directory,
		cleanupPolicy: cleanupPolicy( wixCapture.cleanupRules ), captureImages: true, learnFluid: false, settleMs: 200,
	} );
	expect( result.failed ).toBe( 0 );
	const manifest = JSON.parse( readFileSync( join( directory, 'screenshots', 'manifest.json' ), 'utf8' ) );

	// The gated route is recorded as gated, not as an ordinary capture.
	expect( manifest.entries[ dues ].accessGate ).toMatchObject( { provider: 'Wix', rule: 'wix-members-gate' } );
	expect( manifest.entries[ home ].accessGate ).toBeUndefined();

	const gated = markup( readFileSync( join( directory, manifest.entries[ dues ].html ), 'utf8' ) );
	// Never a login form that cannot work off the provider.
	expect( gated ).not.toContain( 'emailAuth' );
	expect( gated ).not.toContain( 'siteMembersDialog' );
	// The site's own header, navigation and footer stay, so the page still
	// belongs to the site; the body says what happened and what to do next.
	expect( gated ).toContain( 'id="SITE_HEADER"' );
	expect( gated ).toContain( '© Owner HOA' );
	expect( gated ).toContain( 'This page was members-only on your Wix site, so its content couldn’t be copied. Add the content here, or protect this page with a password.' );
	expect( gated ).not.toContain( 'Owner home content.' );
	// Named by its menu label, not by the gate's site-wide title.
	expect( gated ).toMatch( /<title>Dues \| Owner HOA<\/title>/ );
	expect( gated ).toMatch( /<h1[^>]*>Dues<\/h1>/ );

	// The header pop-up is dropped on public pages too.
	const homeHtml = markup( readFileSync( join( directory, manifest.entries[ home ].html ), 'utf8' ) );
	expect( homeHtml ).toContain( 'Owner home content.' );
	expect( homeHtml ).not.toContain( 'emailAuth' );
	expect( JSON.stringify( manifest.entries[ home ].interactions ?? {} ) ).not.toContain( 'emailAuth' );

	exportWebsiteCapture( { outputDir: directory, sourceUrl: home, platform: 'wix', summary: {}, failures: [] } );
	const exported = join( directory, 'website', 'dues', 'index.html' );
	expect( existsSync( exported ) ).toBe( true );
	expect( readFileSync( exported, 'utf8' ) ).toContain( 'members-only on your Wix site' );
	expect( markup( readFileSync( exported, 'utf8' ) ) ).not.toContain( 'emailAuth' );
}, 120_000 );
