import { stripNodeIds } from './test-helpers/strip-node-ids.js';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanupPolicy } from './source-cleanup.js';
import { capture as wixCapture } from '../adapters/wix/capture.js';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { exportWebsiteCapture } from './capture-export.js';
import { checkFidelity } from './fidelity/check.js';

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
<link rel="canonical" href="/"><meta name="description" content="Welcome to the home page"><meta property="og:title" content="${ title }"><meta property="og:description" content="Home page summary"><meta property="og:image" content="/home.jpg"><meta name="twitter:title" content="${ title }"><meta name="twitter:description" content="Home page summary"><meta name="twitter:image" content="/home.jpg"><style>body{margin:0;font:16px Arial}header,main,footer{padding:20px}h1{font-family:Georgia}</style></head>
<body><div id="SITE_CONTAINER"><header id="SITE_HEADER"><nav><a href="/">Home</a> <a href="/dues">Dues</a></nav>
<button type="button" aria-haspopup="dialog" id="sign-in">Sign In</button></header>
<main id="PAGES_CONTAINER">${ main }</main><footer id="SITE_FOOTER">© Owner HOA <a href="/dues">Pay online</a></footer></div>
<script>document.getElementById('sign-in').addEventListener('click',()=>{const layer=document.createElement('div');layer.innerHTML=${ JSON.stringify( membersDialog ) };document.body.append(layer.firstElementChild)});${ script }</script>
</body></html>`;

const pages: Record< string, string > = {
	// A public page whose runtime opens the members login, blocking layer
	// included, as soon as it loads: it keeps its content, so it is not gated.
	'/news': shell( 'News | Owner HOA', `<h1>News</h1><p>${ 'Real public news content. '.repeat( 20 ) }</p>`, `setTimeout(()=>{const l=document.createElement('div');l.setAttribute('data-testid','siteMembersDialogBlockingLayer');l.innerHTML=${ JSON.stringify( membersDialog ) };document.body.append(l);},50);` ),
	'/': shell( 'Home | Owner HOA', `<h1>Welcome neighbours</h1><p>${ 'Owner home content. '.repeat( 20 ) }</p>` ),
	// The server answers the members-only route with the site shell; the
	// runtime then swaps everything for the blocking members gate.
	'/dues': shell( 'Owner HOA', '<p>Loading</p>', `setTimeout(()=>{document.getElementById('SITE_CONTAINER').innerHTML='<div data-testid="siteMembersDialogBlockingLayer">'+${ JSON.stringify( membersDialog ) }+'</div>'},50);` ),
};

// The fixture's own runtime script spells the dialog out; assert on the document.
const markup = ( html: string ) => stripNodeIds( html ).replace( /<script[\s\S]*?<\/script>/gi, '' );

async function source( routes: Record< string, string > = pages ): Promise< string > {
	server = createServer( ( req, res ) => {
		const page = routes[ new URL( req.url ?? '/', 'http://x' ).pathname ];
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
	const news = new URL( '/news', home ).href;
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	directory = mkdtempSync( join( process.cwd(), '.tmp-test', 'access-gate-' ) );
	const result = await captureScreenshots( {
		urls: [ home, dues, news ], primaryUrl: home, outputDir: directory,
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
	// The page's own menu entry is current; the footer link does not name it.
	expect( gated ).toMatch( /<nav>.*<a href="\/dues"[^>]*aria-current="page"/s );
	// Share metadata names this page, and the root page's summary and image are not reused.
	expect( gated ).toContain( '<meta name="twitter:title" content="Dues | Owner HOA">' );
	expect( gated ).toContain( '<meta property="og:title" content="Dues | Owner HOA">' );
	for ( const leaked of [ 'Welcome to the home page', 'Home page summary', '/home.jpg' ] ) expect( gated ).not.toContain( leaked );

	// A public page with the login opened over it keeps its content and title.
	expect( manifest.entries[ news ].accessGate ).toBeUndefined();
	const newsHtml = markup( readFileSync( join( directory, manifest.entries[ news ].html ), 'utf8' ) );
	expect( newsHtml ).toContain( 'Real public news content.' );
	expect( newsHtml ).not.toContain( 'members-only on your Wix site' );
	expect( newsHtml ).toMatch( /<title>News \| Owner HOA<\/title>/ );
	expect( newsHtml ).not.toContain( 'emailAuth' );

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
	const receipt = JSON.parse( readFileSync( join( directory, 'capture-receipt.json' ), 'utf8' ) );
	expect( receipt.routes.find( ( route: { url: string } ) => route.url === dues ).accessGate ).toMatchObject( { provider: 'Wix' } );

	// Drift replays the live source, which only ever shows the login on the
	// gated route: the placeholder is set aside, not reported as drift.
	const log: string[] = [];
	const drift = await checkFidelity( { directory, widths: [ 1440 ], settleMs: 200, stage: 'drift', log: ( line ) => log.push( line ) } );
	expect( drift.routes ).not.toContain( '/dues' );
	expect( drift.routes ).toContain( '/' );
	expect( log.join( '\n' ) ).toContain( 'captured as placeholders and are not compared against the live source: /dues' );
	await expect( checkFidelity( { directory, widths: [ 1440 ], settleMs: 200, stage: 'drift', routes: [ '/dues' ] } ) ).rejects.toThrow( 'access-gate placeholder' );
}, 240_000 );

it( 'fails fast when the public shell stops answering while the placeholder is placed', async () => {
	// The shell loads, then its script never yields again.
	const home = await source( { ...pages, '/': shell( 'Home | Owner HOA', '<h1>Welcome neighbours</h1>', 'addEventListener(\'load\',()=>setTimeout(()=>{for(;;){}}));' ) } );
	const dues = new URL( '/dues', home ).href;
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	directory = mkdtempSync( join( process.cwd(), '.tmp-test', 'access-gate-' ) );
	const result = await captureScreenshots( {
		urls: [ dues ], primaryUrl: dues, outputDir: directory, viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		cleanupPolicy: cleanupPolicy( wixCapture.cleanupRules ), learnFluid: false, settleMs: 0, evaluateTimeoutMs: 1_000,
	} );
	expect( result.failed ).toBe( 1 );
	const failures = JSON.parse( readFileSync( join( directory, 'screenshots', 'failures.json' ), 'utf8' ) );
	expect( failures ).toMatchObject( [ { stage: 'evaluate', error: expect.stringMatching( /stopped responding while settling \(access-gate shell\)/ ) } ] );
}, 150_000 );

// Wix's other members-only shape: the route is served with an empty
// `#site-root` (no header, navigation, main or footer at all) and the runtime
// mounts the blocking layer beside it well after `load`. That page is quiet,
// and generically "ready", before the gate exists.
const emptyGatedRoute = ( title: string, delayMs: number ) => `<!doctype html><html><head><meta charset="utf-8"><title>${ title }</title></head>
<body><div id="SITE_CONTAINER"><div id="main_MF" class="main_MF"><div id="site-root" class="site-root"></div></div></div>
<script>addEventListener('load',()=>setTimeout(()=>{const l=document.createElement('div');l.setAttribute('data-testid','siteMembersDialogBlockingLayer');l.innerHTML=${ JSON.stringify( membersDialog ) };document.getElementById('main_MF').append(l)},${ delayMs }));</script>
</body></html>`;

async function captureGated( routes: Record< string, string >, path: string ) {
	const home = await source( routes );
	const gatedUrl = new URL( path, home ).href;
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	directory = mkdtempSync( join( process.cwd(), '.tmp-test', 'access-gate-' ) );
	const result = await captureScreenshots( {
		urls: [ gatedUrl ], primaryUrl: gatedUrl, outputDir: directory,
		cleanupPolicy: cleanupPolicy( wixCapture.cleanupRules ), learnFluid: false, settleMs: 200,
	} );
	const manifest = JSON.parse( readFileSync( join( directory, 'screenshots', 'manifest.json' ), 'utf8' ) );
	const entry = manifest.entries[ gatedUrl ];
	return { result, entry, html: entry?.html ? markup( readFileSync( join( directory, entry.html ), 'utf8' ) ) : '' };
}

it( 'waits for a gate mounted after the empty route settles, and places the note inside the site chrome', async () => {
	const { result, entry, html } = await captureGated( { ...pages, '/portfolio': emptyGatedRoute( 'Owner HOA', 1_500 ) }, '/portfolio' );
	expect( result.failed ).toBe( 0 );
	expect( entry.accessGate ).toMatchObject( { provider: 'Wix', rule: 'wix-members-gate', label: 'Portfolio' } );
	expect( html ).toContain( 'members-only on your Wix site' );
	expect( html ).toContain( 'id="SITE_HEADER"' );
	expect( html ).toContain( '© Owner HOA' );
	expect( html ).not.toContain( 'siteMembersDialog' );
	expect( html ).not.toContain( 'emailAuth' );
}, 240_000 );

it( 'keeps the shell header and footer when its content root mounts after load', async () => {
	// The public shell renders its chrome at once and its content root later.
	const lateMain = shell( 'Home | Owner HOA', '' ).replace( /<main id="PAGES_CONTAINER"><\/main>/, '' )
		.replace( '</script>', `;addEventListener('load',()=>setTimeout(()=>{const m=document.createElement('main');m.innerHTML='<h1>Welcome</h1><p>Owner home content.</p>';document.getElementById('SITE_FOOTER').before(m)},1500));</script>` );
	const { result, entry, html } = await captureGated( { ...pages, '/': lateMain }, '/dues' );
	expect( result.failed ).toBe( 0 );
	expect( entry.accessGate ).toMatchObject( { provider: 'Wix', label: 'Dues' } );
	expect( html ).toContain( 'members-only on your Wix site' );
	expect( html ).toContain( 'id="SITE_HEADER"' );
	expect( html ).toContain( 'id="SITE_FOOTER"' );
	expect( html ).not.toContain( 'Owner home content.' );
}, 240_000 );

it( 'keeps the note when the shell runtime re-renders its content root after the placeholder is placed', async () => {
	// The public shell's runtime hydrates its sections again after load, as
	// Wix does, which would put the root page back under the gated route.
	const rehydrating = shell( 'Home | Owner HOA', '<h1>Welcome neighbours</h1><p>Owner home content.</p>',
		`addEventListener('load',()=>setTimeout(()=>{document.getElementById('PAGES_CONTAINER').innerHTML='<h1>Welcome neighbours</h1><p>Owner home content, rehydrated.</p>'},2500));` );
	const { result, entry, html } = await captureGated( { ...pages, '/': rehydrating }, '/dues' );
	expect( result.failed ).toBe( 0 );
	expect( entry.accessGate ).toMatchObject( { provider: 'Wix', label: 'Dues' } );
	expect( html ).toContain( 'members-only on your Wix site' );
	expect( html ).not.toContain( 'Owner home content' );
	expect( html ).toContain( 'id="SITE_HEADER"' );
	expect( html ).toContain( 'id="SITE_FOOTER"' );
	expect( html ).toMatch( /<title>Dues \| Owner HOA<\/title>/ );
}, 240_000 );

it( 'puts the shell’s own current menu item at rest on the placeholder route, including builder state markers', async () => {
	// The shell's menu marks its own route current three ways, as Wix does: a
	// state class and a data attribute on the item's wrapper (both painted by
	// its stylesheet) and aria-current on the link. Its runtime re-marks the
	// item when it re-renders the menu after load.
	const selectedHome = '<div class="item menu__item--selected" data-selected="true" data-part="menu-item-content"><a href="/" aria-current="page">Home</a></div>';
	const restingDues = '<div class="item" data-part="menu-item-content"><a href="/dues">Dues</a></div>';
	const markedShell = shell( 'Home | Owner HOA', `<h1>Welcome neighbours</h1><p>${ 'Owner home content. '.repeat( 20 ) }</p>`,
		`addEventListener('load',()=>setTimeout(()=>{const i=document.querySelector('nav .item');i.classList.add('menu__item--selected');i.setAttribute('data-selected','true');i.querySelector('a').setAttribute('aria-current','page')},2500));` )
		.replace( '<nav><a href="/">Home</a> <a href="/dues">Dues</a></nav>', `<nav class="menu">${ selectedHome }${ restingDues }</nav>` )
		.replace( '</style>', '.menu .item a{font-size:20px}.menu .menu__item--selected a{font-size:6px}.menu [data-selected] a{color:red}</style>' );
	const { result, entry, html } = await captureGated( { ...pages, '/': markedShell }, '/dues' );
	expect( result.failed ).toBe( 0 );
	expect( entry.accessGate ).toMatchObject( { provider: 'Wix', label: 'Dues' } );
	const home = html.match( /<div[^>]*>\s*<a href="\/"[^>]*>Home<\/a>/ )?.[ 0 ] ?? '';
	expect( home ).toContain( 'Home' );
	// The root page is not the one served: its item carries no current state.
	expect( home ).not.toContain( 'menu__item--selected' );
	expect( home ).not.toContain( 'data-selected' );
	expect( home ).not.toContain( 'aria-current' );
	// The page's own entry is the current one.
	expect( html ).toMatch( /<a href="\/dues"[^>]*aria-current="page"[^>]*>Dues<\/a>/ );
	// Unrelated wrappers keep their identity.
	expect( home ).toContain( 'class="item"' );
	expect( html ).toContain( '<nav class="menu"' );
}, 240_000 );
