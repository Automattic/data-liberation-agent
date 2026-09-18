import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	captureSelectableSetStates,
	SELECTABLE_SET_KIND,
	SELECTABLE_SET_LIMITS,
} from './selectable-set-capture.js';

const skipBrowser = process.env.SKIP_BROWSER_TESTS;

const PICKER_PAGE = `<!doctype html><html><body>
	<div id="layout">
		<div id="picker">
			<div id="z1" style="cursor:pointer">Zone 1</div>
			<div id="z2" style="cursor:pointer">Zone 2</div>
			<div id="z3" style="cursor:pointer">Zone 3</div>
		</div>
		<div id="panel">Select a zone to view details.</div>
	</div>
	<script>
		const details = {
			z1: 'Zone 1 / Production / A climate-controlled room with a 18/6 light cycle.',
			z2: 'Zone 2 / Processing / Packaging line with humidity held at 45-55 percent RH.',
			z3: 'Zone 3 / Storage / Cold room held at 4C for finished goods.',
		};
		window.clicks = [];
		document.querySelectorAll('#picker > *').forEach((zone) => {
			zone.addEventListener('click', () => {
				window.clicks.push(zone.id);
				document.getElementById('panel').textContent = details[zone.id];
			});
		});
	</script>
</body></html>`;

describe( 'captureSelectableSetStates', () => {
	let browser: Browser;

	beforeAll( async () => {
		if ( skipBrowser ) return;
		browser = await chromium.launch( { headless: true } );
	} );

	afterAll( async () => {
		await browser?.close();
	} );

	it.skipIf( skipBrowser )(
		'captures distinct shared-region content for each member',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( PICKER_PAGE );
				const states = await captureSelectableSetStates( page );
				expect( states ).toHaveLength( 3 );
				expect( states.every( ( state ) => state.kind === SELECTABLE_SET_KIND ) ).toBe( true );
				expect( states.every( ( state ) => state.status === 'captured' ) ).toBe( true );
				expect( states.map( ( state ) => state.trigger.id ) ).toEqual( [ 'z1', 'z2', 'z3' ] );
				expect( states.map( ( state ) => state.set ) ).toEqual( [
					{ selector: '#picker', size: 3, index: 0 },
					{ selector: '#picker', size: 3, index: 1 },
					{ selector: '#picker', size: 3, index: 2 },
				] );
				expect( states[ 0 ].dialog?.id ).toBe( 'panel' );
				expect( states[ 0 ].dialog?.html ).toContain( 'Zone 1 / Production' );
				expect( states[ 1 ].dialog?.html ).toContain( 'Zone 2 / Processing' );
				expect( states[ 2 ].dialog?.html ).toContain( 'Zone 3 / Storage' );
				expect( await page.locator( '#panel' ).textContent() ).toBe(
					'Select a zone to view details.'
				);
				expect(
					await page.locator( '[data-lib-selectable-region],[data-lib-selectable-member]' ).count()
				).toBe( 0 );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'orders states deterministically across repeated captures',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( PICKER_PAGE );
				const first = await captureSelectableSetStates( page );
				const second = await captureSelectableSetStates( page );
				expect( first ).toEqual( second );
				expect( first.map( ( state ) => state.trigger.id ) ).toEqual( [ 'z1', 'z2', 'z3' ] );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'bounds the number of members driven',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<div id="layout">
						<div id="picker"></div>
						<div id="panel">idle</div>
					</div>
					<script>
						window.clicks = [];
						const picker = document.getElementById('picker');
						const panel = document.getElementById('panel');
						for (let index = 0; index < 10; index++) {
							const zone = document.createElement('div');
							zone.id = 'z' + index;
							zone.style.cursor = 'pointer';
							zone.textContent = 'Zone ' + index;
							zone.addEventListener('click', () => {
								window.clicks.push(zone.id);
								panel.textContent = 'Details for zone ' + index + ' with unique copy.';
							});
							picker.append(zone);
						}
					</script>
				</body></html>` );
				const states = await captureSelectableSetStates( page, { maxMembers: 3 } );
				const clicks = await page.evaluate(
					() => ( window as typeof window & { clicks: string[] } ).clicks
				);
				expect( states ).toHaveLength( 3 );
				expect( states.every( ( state ) => state.status === 'captured' ) ).toBe( true );
				expect( states.map( ( state ) => state.trigger.id ) ).toEqual( [ 'z0', 'z1', 'z2' ] );
				expect( states[ 0 ].set ).toEqual( { selector: '#picker', size: 10, index: 0 } );
				expect( new Set( clicks ).has( 'z9' ) ).toBe( false );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'does not drive a recognised set once the time budget is spent',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<div role="tablist">
						<button type="button" role="tab" id="t1">One</button>
						<button type="button" role="tab" id="t2">Two</button>
					</div>
					<div role="tabpanel" id="panel">Static panel</div>
					<script>
						window.clicks = 0;
						document.querySelectorAll('[role="tab"]').forEach((tab) => {
							tab.addEventListener('click', () => { window.clicks++; });
						});
					</script>
				</body></html>` );
				const states = await captureSelectableSetStates( page, { maxDriveMs: 0 } );
				expect( states ).toHaveLength( 1 );
				expect( states[ 0 ] ).toMatchObject( {
					status: 'no-dialog',
					kind: SELECTABLE_SET_KIND,
					trigger: { id: 't1' },
				} );
				expect( await page.evaluate( () => ( window as typeof window & { clicks: number } ).clicks ) ).toBe(
					0
				);
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'records click-failed when a recognised member cannot be driven',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<div id="layout">
						<div id="picker">
							<div id="z1" style="cursor:pointer">Zone 1</div>
							<div id="z2" style="cursor:pointer">Zone 2</div>
							<div id="z3" style="cursor:pointer">Zone 3</div>
						</div>
						<div id="panel">idle</div>
					</div>
					<script>
						const nativeClick = HTMLElement.prototype.click;
						HTMLElement.prototype.click = function () {
							if (this.id === 'z3') throw new Error('native click blocked');
							return nativeClick.call(this);
						};
						const details = { z1: 'First zone copy that is long enough.', z2: 'Second zone copy that is long enough.', z3: 'Third zone copy that is long enough.' };
						document.querySelectorAll('#picker > *').forEach((zone) => {
							zone.addEventListener('click', () => {
								document.getElementById('panel').textContent = details[zone.id];
							});
						});
					</script>
				</body></html>` );
				const states = await captureSelectableSetStates( page );
				expect( states.map( ( state ) => [ state.trigger.id, state.status ] ) ).toEqual( [
					[ 'z1', 'captured' ],
					[ 'z2', 'captured' ],
					[ 'z3', 'click-failed' ],
				] );
				expect( states[ 2 ].error ).toMatch( /native click blocked/ );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'records no-dialog when a recognised set does not mutate a shared region',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<div role="tablist">
						<button type="button" role="tab" id="t1">One</button>
						<button type="button" role="tab" id="t2">Two</button>
						<button type="button" role="tab" id="t3">Three</button>
					</div>
					<div role="tabpanel" id="panel">Static panel that never changes.</div>
				</body></html>` );
				const states = await captureSelectableSetStates( page );
				expect( states ).toHaveLength( 1 );
				expect( states[ 0 ] ).toMatchObject( {
					status: 'no-dialog',
					kind: SELECTABLE_SET_KIND,
					trigger: { id: 't1', role: 'tab' },
					set: { size: 3, index: 0 },
				} );
				expect( states[ 0 ].dialog ).toBeUndefined();
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'does not treat a list of navigation links as a selectable set',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<main>
						<div id="links">
							<a href="/one">One</a>
							<a href="/two">Two</a>
							<a href="/three">Three</a>
						</div>
						<div id="panel">Nearby copy that should not be attributed to the links.</div>
					</main>
				</body></html>` );
				expect( await captureSelectableSetStates( page ) ).toEqual( [] );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it.skipIf( skipBrowser )(
		'records no-dialog for a member that does not change the confirmed region',
		async () => {
			const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
			try {
				await page.setContent( `<!doctype html><html><body>
					<div id="layout">
						<div id="picker">
							<div id="z1" style="cursor:pointer">Zone 1</div>
							<div id="z2" style="cursor:pointer">Zone 2</div>
							<div id="z3" style="cursor:pointer">Zone 3</div>
						</div>
						<div id="panel">idle</div>
					</div>
					<script>
						document.getElementById('z1').addEventListener('click', () => {
							document.getElementById('panel').textContent = 'First zone copy that is long enough.';
						});
						document.getElementById('z2').addEventListener('click', () => {
							document.getElementById('panel').textContent = 'Second zone copy that is long enough.';
						});
					</script>
				</body></html>` );
				const states = await captureSelectableSetStates( page );
				expect( states.map( ( state ) => [ state.trigger.id, state.status ] ) ).toEqual( [
					[ 'z1', 'captured' ],
					[ 'z2', 'captured' ],
					[ 'z3', 'no-dialog' ],
				] );
			} finally {
				await page.close();
			}
		},
		30_000
	);

	it( 'exposes explicit drive caps', () => {
		expect( SELECTABLE_SET_LIMITS ).toEqual( {
			maxSets: 3,
			maxMembers: 24,
			maxDriveMs: 8_000,
			maxHtmlBytes: 512 * 1024,
			settleMs: 250,
		} );
	} );
} );
