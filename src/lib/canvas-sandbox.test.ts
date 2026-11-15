import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCanvasSandbox, drawsOnCanvas } from './canvas-sandbox.js';

// Neutral source code: overwrites copy, hides and restyles elements, rebuilds
// markup, and draws on pointer movement and clicks.
const SOURCE = `
const copy = document.getElementById('copy');
copy.textContent = 'SOURCE OVERWRITE';
copy.style.display = 'none';
copy.classList.add('hidden-by-source');
copy.setAttribute('data-source', 'yes');
document.querySelector('#panel').innerHTML = '<b id="injected">x</b>';
document.getElementById('injected').textContent = 'still inert';
document.body.appendChild(document.createElement('section'));
const surface = document.getElementById('surface');
surface.width = 300; surface.height = 120;
const context = surface.getContext('2d');
let strokes = 0;
window.addEventListener('mousemove', (event) => {
  context.strokeStyle = '#123456'; context.beginPath();
  context.moveTo(event.clientX % 300, 10); context.lineTo((event.clientX + 40) % 300, 100); context.stroke(); strokes++;
});
document.querySelectorAll('.tile').forEach((tile) => tile.addEventListener('click', (event) => {
  event.target.textContent = 'clicked';
  const box = event.currentTarget.getBoundingClientRect();
  context.fillStyle = '#654321'; context.fillRect(0, 0, Math.max(1, Math.round(box.width) % 50), 20);
}));
document.getElementById('panel').onclick = function () { this.textContent = 'handler wrote'; context.fillRect(200, 0, 10, 10); };
const extra = document.createElement('canvas'); extra.id = 'extra'; document.body.appendChild(extra);
window.__strokes = () => strokes;
`;

describe( 'source canvas sandbox', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	it( 'selects only drawing code', () => {
		expect( drawsOnCanvas( SOURCE ) ).toBe( true );
		expect( drawsOnCanvas( 'navigator.sendBeacon("/rum")' ) ).toBe( false );
	} );

	it( 'runs source drawing and listeners while every content write is discarded', async () => {
		const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
		const errors: string[] = [];
		page.on( 'pageerror', ( error ) => errors.push( error.message ) );
		page.on( 'console', ( message ) => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
		try {
			await page.setContent( `<main><p id="copy" class="keep">Edited copy</p><div id="panel"><span class="tile">A tile</span></div></main><canvas id="surface"></canvas>` );
			const before = await page.evaluate( () => document.body.innerHTML );
			await page.addScriptTag( { content: buildCanvasSandbox( [ { url: 'https://source.test/app.js', sha256: 'x', body: SOURCE } ] ) } );
			const pixels = () => page.evaluate( () => ( document.getElementById( 'surface' ) as HTMLCanvasElement ).toDataURL() );
			const blank = await pixels();
			await page.mouse.move( 100, 300 );
			await page.mouse.move( 220, 310 );
			expect( await page.evaluate( () => ( window as unknown as { __strokes: () => number } ).__strokes() ) ).toBeGreaterThan( 0 );
			const drawn = await pixels();
			expect( drawn ).not.toBe( blank );
			await page.click( '.tile' );
			await page.click( '#panel', { position: { x: 200, y: 5 } } );
			expect( await pixels() ).not.toBe( drawn );
			// Only the source-created canvas joined the page; all editable content is untouched.
			const after = await page.evaluate( () => {
				document.getElementById( 'extra' )?.remove();
				const surface = document.getElementById( 'surface' )!;
				surface.removeAttribute( 'width' ); surface.removeAttribute( 'height' );
				return document.body.innerHTML;
			} );
			expect( after ).toBe( before );
			expect( errors ).toEqual( [] );
		} finally { await page.close(); }
	} );
} );
