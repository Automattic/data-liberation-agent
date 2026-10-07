import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { readResolvedPage } from './site-includes.js';

const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0}.active{position:fixed;top:0;left:0;height:80px;background:white}.logo{margin:20px;width:100px;height:40px;background:teal}
.spacer{height:80px;position:relative}.spacer nav{position:absolute;top:0;left:0;width:100%;height:0;visibility:hidden}
main{padding:20px;box-sizing:border-box}h1{margin:0}.columns{display:flex}.copy{width:66%}.portrait{width:34%;height:120px;background:gray}
body:not(.phone) .logo{background:teal}
@media(min-width:768px){.spacer{overflow:hidden}.spacer nav{width:100%!important;left:0!important;top:0!important}}
@media(max-width:767px){.columns{display:block}.copy,.portrait{width:100%}}</style></head>
<body><header class="active" style="width:1px"><div class="logo"></div><nav id="menu">Active</nav></header>
<div class="spacer"><nav id="menu" style="left:0px;top:0px">Closed source-owned copy</nav></div>
<main style="width:1px"><h1>Cloned chrome</h1><div class="columns"><div class="copy">Responsive text</div><div class="portrait"></div></div></main>
<script>Array.prototype.entries=function(){return this.slice();};Array.from=function(value){return Array.isArray(value)?value.slice():[];};
if(/iPhone|Android/.test(navigator.userAgent))document.body.classList.add('phone');function update(){const width=document.documentElement.clientWidth;
document.querySelector('.active').style.width=width+'px';document.querySelector('main').style.width=width+'px';
const old=document.querySelector('.spacer'),next=old.cloneNode(true);old.replaceWith(next);
if(width>=768){delete Array.prototype.entries;next.querySelector('nav').style.width=width+'px';next.querySelector('nav').style.left='30px';next.querySelector('nav').style.top='60px';}}
addEventListener('resize',update);update();</script></body></html>`;

async function metrics( page: Page ) {
	return page.evaluate( () => {
		const visible = ( selector: string ) => [ ...document.querySelectorAll( selector ) ].find( element => element.getBoundingClientRect().width > 0 )!;
		const header = visible( '.active' ).getBoundingClientRect();
		const logo = visible( '.logo' ).getBoundingClientRect();
		const spacer = visible( '.spacer' ).getBoundingClientRect();
		const menu = visible( '.spacer nav' ).getBoundingClientRect();
		const heading = visible( 'h1' ).getBoundingClientRect();
		return { width: document.documentElement.scrollWidth, header: header.width, logo: logo.x,
			spacer: spacer.bottom, heading: heading.top, menuRight: menu.right, menuTop: menu.top,
			portrait: visible( '.portrait' ).getBoundingClientRect().width,
			hit: !!document.elementFromPoint( heading.x + 10, heading.y + 10 )?.closest( 'h1' ),
		};
	} );
}

it( 'SDK capture preserves replacement clone roles with patched main-world Array and screenshots disabled and enabled', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'issue-599-sdk-' ) );
	let copyRoot: string | undefined;
	const server = createServer( ( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.statusCode = 404; response.end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' && copyRoot
			? readResolvedPage( copyRoot, join( copyRoot, 'index.html' ) ) : source );
	} );
	await new Promise<void>( resolve => server.listen( 0, resolve ) );
	const port = ( server.address() as { port: number } ).port;
	const url = `http://localtest.me:${ port }/`;
	const browser = await chromium.launch( { args: [ '--host-resolver-rules=MAP localtest.me 127.0.0.1' ] } );
	const measurements: Array<Awaited<ReturnType<typeof metrics>>> = [];
	try {
		for ( const captureImages of [ false, true ] ) {
			const outputDir = join( root, captureImages ? 'images-on' : 'images-off' );
			const captured = await captureWebsite( { url, outputDir, captureImages }, {
				findAdapter: () => ( { id: 'neutral-clone', detect: () => true, discover: async () => ( { urls: [] } ) } ),
			} );
			expect( captured.summary.routesFailed ).toBe( 0 );
			copyRoot = join( outputDir, 'website' );
			const copy = await browser.newPage( { viewport: { width: 390, height: 900 } } );
			await copy.goto( `${ url }copy/`, { waitUntil: 'domcontentloaded' } );
			for ( const width of [ 390, 768, 1440, 390 ] ) {
				await copy.setViewportSize( { width, height: 900 } );
				const actual = await metrics( copy );
				expect( actual.width, `overflow at ${ width }, screenshots=${ captureImages }` ).toBe( width );
				expect( actual.header ).toBeCloseTo( width, 0 );
				expect( actual.logo ).toBe( 20 );
				expect( actual.spacer ).toBe( 80 );
				expect( actual.heading ).toBe( 100 );
				// The clipped closed control uses the learner's existing 2px fit
				// tolerance; visible viewport/header geometry stays exact above.
				expect( Math.abs( actual.menuRight - width ) ).toBeLessThanOrEqual( 2 );
				expect( actual.menuTop ).toBe( 0 );
				expect( actual.portrait ).toBeCloseTo( ( width - 40 ) * ( width < 768 ? 1 : 0.34 ), 0 );
				expect( actual.hit ).toBe( true );
				measurements.push( actual );
			}
			const html = await copy.content();
			expect( html ).not.toContain( 'data-dla-fluid-id' );
			await copy.close();
		}
		for ( let index = 0; index < 4; index++ ) {
			const { menuRight: offRight, ...off } = measurements[ index ]!;
			const { menuRight: onRight, ...on } = measurements[ index + 4 ]!;
			expect( off ).toEqual( on );
			expect( Math.abs( offRight - onRight ) ).toBeLessThanOrEqual( 2 );
		}
	} finally {
		await browser.close();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 240_000 );
