import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

const skip = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// A runtime waiting for a remote interaction acknowledgement can leave its
// probe's browser-side settle timer pending forever. Keep baseline timers real;
// stall only after the first user interaction. Both drivers must be bounded.
const fixture = ( kind: string ) => `<!doctype html><title>Pending interaction</title>
<main><a href="/linked">Linked document</a>
<input type="search" placeholder="Find entries"><div id="categories"><button class="active">Everything</button><button>First</button><button>Second</button></div><div id="items"></div>
</main><script>
const entries=[['Same heading','Evidence for apples',1],['Same heading','Evidence for oranges',2],['Other heading','Fresh berries',2]];let category=0;
function render(){const query=document.querySelector('input').value.toLowerCase();document.querySelectorAll('#categories button').forEach((b,i)=>b.className=i===category?'active':'');document.querySelector('#items').innerHTML=entries.filter(e=>(!category||e[2]===category)&&(e[0]+' '+e[1]).toLowerCase().includes(query)).map(e=>'<article><h2>'+e[0]+'</h2><p>'+e[1]+'</p></article>').join('')||'<p>No entries match.</p>';}
document.querySelector('input').addEventListener('input',()=>{render();if(document.querySelector('input').value)document.querySelector('input').disabled=true;});
document.querySelectorAll('#categories button').forEach((b,i)=>b.onclick=()=>{category=i;render();${ kind === 'selectable' ? 'window.setTimeout = () => 0;' : '' }});render();
</script>`;

it.skipIf( skip )( 'retains baseline and follows server links when selectable and typed-search probes never settle', async () => {
	const server = createServer( ( request, response ) => {
		response.setHeader( 'content-type', 'text/html' );
		response.end( request.url === '/linked' ? '<!doctype html><title>Linked</title><main>Linked document</main>' : fixture( request.url === '/search' ? 'search' : 'selectable' ) );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/phase-budget-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/search` ], primaryUrl: `${ origin }/`, outputDir,
			limit: 3, linkedPages: {}, routeDeadlineMs: 120_000, concurrency: 1,
			settleMs: 0, learnFluid: false, sharedChrome: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		} );
		expect( result ).toMatchObject( { captured: 3, failed: 0 } );
		expect( result.urls ).toContain( `${ origin }/linked` );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) );
		for ( const path of [ '/', '/search' ] ) {
			const entry = manifest.entries[ `${ origin }${ path }` ];
			expect( existsSync( join( outputDir, entry.html ) ) ).toBe( true );
			expect( entry.interactions.coverage ).toBe( 'partial' );
			if ( path === '/search' ) expect( entry.interactions.states.some( ( state: { kind: string; status: string } ) => state.kind === 'selectable-set' && state.status === 'captured' ) ).toBe( true );
			expect( entry.profiles.desktop.diagnostics ).toEqual( expect.arrayContaining( [ expect.objectContaining( { code: 'interaction_phase_budget_exceeded', reason: expect.stringContaining( path === '/' ? 'selectable exceeded' : 'typed-search exceeded' ) } ) ] ) );
		}
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
