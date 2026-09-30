import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureSourceBehavior } from './screenshot/behavior-capture.js';
import { compileTextBehavior } from './text-behavior-runtime.js';

it( 'compiles observed startup and discovered click reveal while replaying an edited DOM value', async () => {
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'content-type', 'text/html' );
		response.end( `<html><body><button id="neutral-trigger">Replay</button><p id="random-target">SOURCE COPY</p><script>
const node=document.getElementById('random-target'),value=node.textContent;
function reveal(){node.textContent='';let i=0;const timer=setInterval(()=>{node.textContent+=value[i++];if(i===value.length)clearInterval(timer)},15)}
document.getElementById('neutral-trigger').addEventListener('click',reveal);reveal();
</script></body></html>` );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const browser = await chromium.launch();
	try {
		const source = await browser.newPage();
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const observed = await captureSourceBehavior( source, url, { startupMs: 500, replayMs: 500 } );
		const { script, program } = compileTextBehavior( observed );
		expect( program.startup ).toHaveLength( 1 );
		expect( program.replays ).toHaveLength( 1 );
		expect( script ).not.toContain( 'SOURCE COPY' );
		const copy = await browser.newPage();
		await copy.setContent( '<button id="neutral-trigger">Replay</button><p id="random-target">EDITED VALUE</p>' );
		await copy.addScriptTag( { content: script } );
		await copy.waitForSelector( 'html[data-dla-text-ready=true]' );
		expect( await copy.locator( '#random-target' ).textContent() ).toBe( 'EDITED VALUE' );
		await copy.locator( '#neutral-trigger' ).click();
		await copy.waitForFunction( () => document.querySelector( '#random-target' )?.textContent === 'EDITED VALUE' );
		expect( await copy.locator( '#random-target' ).textContent() ).toBe( 'EDITED VALUE' );
	} finally {
		await browser.close(); server.closeAllConnections();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
	}
}, 30000 );
