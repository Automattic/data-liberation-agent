import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { exportWebsiteCapture } from './capture-export.js';
import { checkFidelity as checkLiveFidelity } from './fidelity/check.js';
const checkFidelity = ( options: Parameters<typeof checkLiveFidelity>[0] ) => checkLiveFidelity( { ...options, stage: 'drift' } );
import { authorPortableMotion, PORTABLE_MOTION_SCHEMA, type PortableMotionRecipe } from './portable-motion.js';
import { startStaticServer } from './replicate/local-site/static-server.js';

const sourceScript = `const canvas=document.getElementById('draw'); const lamp=document.getElementById('lamp'); lamp.style.display='none'; document.getElementById('status').textContent='Waiting'; canvas.getContext('2d'); requestAnimationFrame(function frame(){requestAnimationFrame(frame)}); addEventListener('mousemove',()=>canvas.getContext('2d').fillRect(5,5,15,15)); document.getElementById('replay').addEventListener('click',()=>{lamp.style.display='none';document.getElementById('status').textContent='Pending';setTimeout(()=>{document.getElementById('status').textContent='Ready';lamp.style.display='block'},150)});setTimeout(()=>{document.getElementById('status').textContent='Ready';lamp.style.display='block';document.body.classList.remove('loading')},700);`;
const authoredScript = `(function(){var status=document.querySelector('[data-motion-target]');var settled=status.textContent;var surface=document.querySelector('canvas[data-motion-surface]');document.body.setAttribute('aria-busy','true');status.textContent='Waiting';function complete(){status.textContent=settled;document.body.classList.remove('loading');document.body.removeAttribute('aria-busy')}window.setTimeout(complete,700);window.addEventListener('pointermove',function(){surface.getContext('2d').fillRect(5,5,15,15)});document.querySelector('[data-motion-replay]').addEventListener('click',function(){document.body.setAttribute('aria-busy','true');status.textContent='Pending';window.setTimeout(complete,150)});})();`;
const hash = ( value: string ) => createHash( 'sha256' ).update( value ).digest( 'hex' );

describe( 'authored portable motion after capture', () => {
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'content-type', 'text/html' );
		response.end( `<!doctype html><html><head><meta charset="utf-8"><title>Animation</title></head><body class="loading"><button id="replay">Replay</button><p id="status">Ready</p><b id="lamp" style="display:block">●</b><canvas id="draw" width="390" height="200"></canvas><script>${ sourceScript }</script></body></html>` );
	} );
	let origin: string;
	const directories: string[] = [];
	beforeAll( async () => {
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	} );
	afterAll( async () => {
		server.closeAllConnections();
		await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		for ( const directory of directories ) rmSync( directory, { recursive: true, force: true } );
	} );
	function capture(): { directory: string; script: string; recipe: PortableMotionRecipe } {
		const directory = mkdtempSync( join( tmpdir(), 'dla-authored-portable-' ) );
		const external = mkdtempSync( join( tmpdir(), 'dla-independent-runtime-' ) );
		directories.push( directory, external );
		for ( const subdir of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, subdir ) );
		writeFileSync( join( directory, 'html/homepage.html' ), `<!doctype html><html><head><meta charset="utf-8"><title>Animation</title></head><body class="loading"><button id="replay">Replay</button><p id="status">Ready</p><b id="lamp" style="display:block">●</b><canvas id="draw" width="390" height="200"></canvas><script>${ sourceScript }</script></body></html>` );
		writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ origin ]: { html: 'html/homepage.html' } } } ) );
		exportWebsiteCapture( { outputDir: directory, sourceUrl: origin, platform: 'generic', summary: {}, failures: [] } );
		const script = join( external, 'motion.js' );
		writeFileSync( script, authoredScript );
		const recipe: PortableMotionRecipe = {
			schema: PORTABLE_MOTION_SCHEMA,
			contract: { widths: [ 390, 768, 1440 ], routes: { '/': { ready: { source: 'body:not(.loading)', candidate: 'body:not(.loading)' }, text: [ '#status' ], visibility: [ '#lamp' ], canvases: [ '#draw' ], clicks: [ { trigger: '#replay', target: '#status' } ] } } },
			routes: { '/': { elements: [ { selector: '#draw', attributes: { 'data-motion-surface': 'true' } }, { selector: '#status', attributes: { 'data-motion-target': 'true' } }, { selector: '#replay', attributes: { 'data-motion-replay': 'true' } } ], busyHidden: [ '#lamp' ], markers: [], scripts: [ { path: script, sha256: hash( authoredScript ) } ] } },
		};
		return { directory, script, recipe };
	}

	it( 'keeps the source executable stripped and rejects a verbatim source script without writing the site', async () => {
		const { directory, script, recipe } = capture();
		const html = join( directory, 'website/index.html' );
		const unchanged = readFileSync( html, 'utf8' );
		expect( unchanged ).not.toContain( sourceScript );
		writeFileSync( script, sourceScript );
		recipe.routes[ '/' ].scripts[ 0 ].sha256 = hash( sourceScript );
		await expect( authorPortableMotion( directory, recipe ) ).rejects.toThrow( /matches a captured source script/ );
		expect( readFileSync( html, 'utf8' ) ).toBe( unchanged );
		expect( existsSync( join( directory, 'portable-motion.json' ) ) ).toBe( false );
	} );

	it( 'proves independent behavior and rechecks a portable artifact without a candidate flag', async () => {
		const { directory, recipe } = capture();
		const unchanged = readFileSync( join( directory, 'website/index.html' ), 'utf8' );
		delete recipe.routes[ '/' ].busyHidden;
		await expect( authorPortableMotion( directory, recipe ) ).rejects.toThrow( /startup visibility differs: #lamp/ );
		expect( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) ).toBe( unchanged );
		recipe.routes[ '/' ].busyHidden = [ '#lamp' ];
		const authored = await authorPortableMotion( directory, recipe );
		expect( authored.pass ).toBe( true );
		const normal = await checkFidelity( { directory, widths: [ 390, 768, 1440 ], settleMs: 0 } );
		expect( normal.pass ).toBe( true );
		expect( normal.motionEvidence ).toHaveLength( 3 );
		const htmlPath = join( directory, 'website/index.html' );
		writeFileSync( htmlPath, readFileSync( htmlPath, 'utf8' ).replace( '<p id="status" data-motion-target="true">Ready</p>', '<p id="status" data-motion-target="true">Edited</p>' ) );
		const preview = await startStaticServer( join( directory, 'website' ) );
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto( preview.url, { waitUntil: 'domcontentloaded' } );
			await page.waitForSelector( 'body:not([aria-busy])' );
			expect( await page.locator( '#status' ).textContent() ).toBe( 'Edited' );
			await page.locator( '#replay' ).click();
			await page.waitForFunction( () => document.querySelector( '#status' )?.textContent === 'Edited' );
			expect( await page.locator( '#status' ).textContent() ).toBe( 'Edited' );
		} finally { await browser.close(); await preview.close(); }
		const runtime = JSON.parse( readFileSync( join( directory, 'portable-motion.json' ), 'utf8' ) );
		const script = join( directory, 'website', runtime.routes[ '/' ].scripts[ 0 ].path );
		writeFileSync( script, '/* tampered */' );
		await expect( checkFidelity( { directory } ) ).rejects.toThrow( /motion script missing or changed/ );
	}, 180_000 );
} );
