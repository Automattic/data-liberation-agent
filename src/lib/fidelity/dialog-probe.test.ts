import { describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { probeDialogs } from './dialog-probe.js';

describe( 'probeDialogs', () => {
	let browser: Browser;

	// The export marks its static disclosure summaries with the captured
	// trigger label, because an icon-only summary has no text and only gains
	// an aria-label after its first toggle. A probe that cannot read that mark
	// reports the exported menu under a generic label that never matches the
	// source's own trigger label, and a working control scores as dead.
	it( 'opens an exported disclosure and reports it under its captured label', async () => {
		browser = await chromium.launch();
		const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
		await page.setContent( `
			<style>
				details.dla-disclosure:not([open]) > .dla-dialog { display: none; }
				details.dla-disclosure[open] > .dla-dialog {
					display: block; position: fixed; inset: 0; background: #fff;
				}
			</style>
			<details class="dla-disclosure">
				<summary data-dla-disclosure-label="Open Menu Close Menu">
					<span class="burger" aria-hidden="true"></span>
				</summary>
				<div class="dla-dialog" role="dialog" aria-modal="true">
					<nav><a href="#home">Home</a></nav>
				</div>
			</details>
		` );

		const probes = await probeDialogs( page );

		expect( probes ).toHaveLength( 1 );
		expect( probes[ 0 ] ).toMatchObject( { label: 'Open Menu Close Menu', opened: true } );
		await page.close();
		await browser.close();
	}, 20_000 );

	it( 'uses a real pointer when a visible summary rejects a synthetic click', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await page.setContent( `<details><summary data-dla-disclosure-label="Menu">Menu</summary><div role="dialog">Links</div></details>
				<script>document.querySelector('summary').addEventListener('click', (event) => {
					if (!event.isTrusted) event.preventDefault();
				});</script>` );
			expect( await probeDialogs( page ) ).toEqual( [ { label: 'Menu', opened: true } ] );
			await page.close();
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'still reports a summary dead when a real pointer cannot open it', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await page.setContent( `<details><summary data-dla-disclosure-label="Menu">Menu</summary><div role="dialog">Links</div></details>
				<script>document.querySelector('summary').addEventListener('click', (event) => event.preventDefault());</script>` );
			expect( await probeDialogs( page ) ).toEqual( [ { label: 'Menu', opened: false } ] );
			await page.close();
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );
