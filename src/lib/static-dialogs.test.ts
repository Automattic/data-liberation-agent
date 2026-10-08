import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { wireCapturedDialogs } from './static-dialogs.js';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';
import { captureTriggeredDialogs } from './screenshot/interaction-capture.js';

const captured: CapturedDialogInteraction = {
	status: 'captured',
	trigger: {
		selector: 'body > button',
		tag: 'button',
		ariaHaspopup: '',
		label: 'Open Menu',
		dataBindings: {},
	},
	dialog: {
		selector: '#menu',
		tag: 'div',
		ariaModal: true,
		ariaLabel: 'Menu',
		html: '<nav><a href="/about">About</a></nav>',
		htmlBytes: 32,
		htmlTruncated: false,
	},
};

describe( 'wireCapturedDialogs', () => {
	it( 'wires observed source controls rather than matching IDs copied into earlier popup snapshots', async () => {
		const controls = '<button id="first" aria-haspopup="dialog">First gallery</button><button id="second" aria-haspopup="dialog">Second gallery</button>';
		let nested = controls;
		for ( let depth = 0; depth < 16; ++depth ) nested = `<div>${ nested }</div>`;
		const source = `<!doctype html><html><head><style>body{margin:0}.panel{position:absolute;top:50px;left:0;width:260px;height:180px;background:white;z-index:100}button{min-height:30px}</style></head><body><main><h1>Unrelated heading</h1>${ nested }</main><footer>Unrelated footer</footer><script>
		for(const id of ['first','second'])document.getElementById(id).addEventListener('click',()=>{
			const old=document.getElementById('panel-'+id);if(old){old.remove();return;}
			const panel=document.createElement('div');panel.id='panel-'+id;panel.className='panel';panel.setAttribute('role','dialog');
			panel.innerHTML='<h2>'+id+' snapshot</h2>'+(id==='first'?'<div id="second" role="img" aria-label="Copied presentation"></div>':'')+'<button aria-label="Close">Close</button>';
			document.getElementById(id).parentElement.append(panel);panel.querySelector('button').onclick=()=>panel.remove();
		});</script></body></html>`;
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.setContent( source );
			const report = await captureTriggeredDialogs( page, 'https://fixture.test/gallery' );
			const states = report.states.filter( state => state.status === 'captured' );
			expect( states ).toHaveLength( 2 );
			expect( states[ 0 ]!.dialog!.html ).toContain( 'id="second"' );
			expect( states[ 1 ]!.dialog!.ancestorState ).toMatchObject( { status: 'unverified', reason: 'ancestor-limit' } );
			const baseline = ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' );
			const portable = wireCapturedDialogs( baseline, states );
			await page.setContent( portable );
			expect( await page.locator( '[data-dla-dialog-panel] [data-dla-dialog-trigger]' ).count() ).toBe( 0 );
			expect( await page.locator( 'main [data-dla-dialog-trigger]' ).count() ).toBe( 2 );
			expect( await page.locator( 'main button#second' ).getAttribute( 'data-dla-dialog-ancestor-unverified' ) ).toBe( 'ancestor-limit' );
			for ( const id of [ 'first', 'second' ] ) {
				const trigger = page.locator( `main button#${ id }` );
				await trigger.click();
				const key = await trigger.getAttribute( 'aria-controls' );
				const panel = page.locator( `[data-dla-dialog-panel="${ key }"]` );
				expect( await panel.evaluate( node => ( node as HTMLElement ).hidden ) ).toBe( false );
				expect( await panel.textContent() ).toContain( `${ id } snapshot` );
				await page.keyboard.press( 'Escape' );
				expect( await panel.evaluate( node => ( node as HTMLElement ).hidden ) ).toBe( true );
			}
			expect( await page.locator( 'main h1' ).textContent() ).toBe( 'Unrelated heading' );
			expect( await page.locator( 'footer' ).textContent() ).toBe( 'Unrelated footer' );
		} finally { await browser.close(); }
	}, 30_000 );

	it.each( [ 'button', 'div' ] )( 'preserves direct-child grid ownership for a %s trigger through resize', async ( tag ) => {
		const trigger = tag === 'button'
			? '<button id="toggle" class="menu" aria-label="Open Menu">Menu</button>'
			: '<div id="toggle" class="menu" role="button" tabindex="0" aria-label="Open Menu">Menu</div>';
		const source = `<html><head><style>
			*{box-sizing:border-box}body{margin:0}header{display:grid;grid-template-columns:1fr 36px;align-items:center;height:63px;padding:6px 12px}
			header>#toggle{grid-column:2;grid-row:1;margin:0;width:36px;height:37px;padding:0}
			.logo{grid-column:1}@media(min-width:700px){header{height:72px;grid-template-columns:1fr 36px}}
		</style></head><body><header><span class="logo">Logo</span>${trigger}</header><main style="height:2800px">Content</main></body></html>`;
		const state: CapturedDialogInteraction = {
			...captured,
			trigger: { ...captured.trigger, selector: 'header > #toggle', tag },
		};
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			const measure = async () => page.evaluate( () => {
				const rect = ( selector: string ) => {
					const r = document.querySelector( selector )!.getBoundingClientRect();
					return { x: r.x, y: r.y, width: r.width, height: r.height };
				};
				return { trigger: rect( '#toggle' ), header: rect( 'header' ), contentTop: rect( 'main' ).y, height: document.documentElement.scrollHeight };
			} );
			const originals = new Map<number, Awaited<ReturnType<typeof measure>>>();
			for ( const width of [ 390, 768, 1440 ] ) {
				await page.setViewportSize( { width, height: 900 } );
				await page.setContent( source );
				originals.set( width, await measure() );
			}
			await page.setContent( wireCapturedDialogs( source, [ state ] ) );
			for ( const width of [ 390, 768, 1440, 390, 1440, 768, 390 ] ) {
				await page.setViewportSize( { width, height: 900 } );
				expect( await measure() ).toEqual( originals.get( width ) );
				if ( width === 390 ) {
					const trigger = page.locator( '#toggle' );
					await trigger.focus();
					await page.keyboard.press( 'Enter' );
					expect( await trigger.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
					await page.keyboard.press( 'Escape' );
					expect( await trigger.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
					expect( await trigger.evaluate( el => document.activeElement === el ) ).toBe( true );
					await page.keyboard.press( ' ' );
					expect( await trigger.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
					await page.locator( '[data-dla-dialog-close]' ).click();
					expect( await trigger.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
					expect( await trigger.evaluate( el => document.activeElement === el ) ).toBe( true );
				}
			}
			expect( await page.locator( '#toggle' ).count() ).toBe( 1 );
			expect( await page.locator( '#toggle' ).evaluate( el => el.tagName.toLowerCase() ) ).toBe( tag );
			expect( await page.locator( 'summary#toggle, details' ).count() ).toBe( 0 );
		} finally { await browser.close(); }
	}, 30_000 );

	it.each( [ 'modal', 'dropdown' ] )( 'preserves responsive flex participation of a %s trigger across resizing', async ( presentation ) => {
		const source = '<html><head><style>body{margin:0}header{display:flex;align-items:center;justify-content:space-between;max-width:672px;margin:auto;padding:24px;box-sizing:border-box}.desktop{display:none}.menu{display:inline-flex;padding:8px;font:16px sans-serif;border:0;background:none;box-sizing:border-box;width:60px;height:36px}@media(min-width:640px){.desktop{display:flex;gap:20px}.menu{display:none}}</style></head><body><header><a href="/">Site title</a><nav class="desktop"><a href="/about">About</a><a href="/writing">Writing</a></nav><button class="menu" aria-label="Open menu">Menu</button></header></body></html>';
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const widths = [ 390, 768, 1440, 390, 1440, 390 ];
			const rectangles = new Map<number, { nav: { x: number; y: number; width: number; height: number } | null; trigger: { x: number; y: number; width: number; height: number } | null }>();
			for ( const width of [ 390, 768, 1440 ] ) {
				await page.setViewportSize( { width, height: 900 } );
				await page.setContent( source );
				rectangles.set( width, { nav: await page.locator( '.desktop' ).boundingBox(), trigger: await page.locator( '.menu' ).boundingBox() } );
			}
			const state: CapturedDialogInteraction = {
				...captured,
				trigger: { ...captured.trigger, selector: 'header > button' },
				dialog: { ...captured.dialog!, ...( presentation === 'dropdown' ? { presentation: 'dropdown' as const } : {} ) },
			};
			await page.setContent( wireCapturedDialogs( source, [ state ] ) );
			for ( const width of widths ) {
				await page.setViewportSize( { width, height: 900 } );
				const trigger = page.locator( 'header > button.menu' );
				expect( await trigger.evaluate( element => getComputedStyle( element ).display === 'none' ) ).toBe( width >= 640 );
				expect( await page.locator( '.desktop' ).boundingBox() ).toEqual( rectangles.get( width )!.nav );
				expect( await trigger.boundingBox() ).toEqual( rectangles.get( width )!.trigger );
				if ( width === 390 ) {
					await trigger.focus();
					await page.keyboard.press( 'Enter' );
					const panel = page.locator( '[data-dla-dialog-panel]' );
					expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( false );
					expect( await panel.evaluate( element => getComputedStyle( element ).position ) ).toBe( presentation === 'dropdown' ? 'absolute' : 'fixed' );
					await page.keyboard.press( 'Escape' );
					expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( true );
					expect( await trigger.evaluate( element => document.activeElement === element ) ).toBe( true );
				}
			}
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'preserves painted children, tag-qualified placement, and dropdown positioning', async () => {
		const fixtures = [
			{
				name: 'class-owned-paint',
				css: '.bar{display:grid;grid-template-columns:1fr 52px;height:63px}.bar>.toggle{grid-column:2;grid-row:1}.toggle{width:36px;height:37px;padding:8px;border:0;margin:6px 0 20px;transform:translateX(3px);background:red;box-sizing:content-box}.glyph{display:inline-block;width:12px;height:14px;background:blue}',
				at390: {
					trigger: { x: 341, y: 6, width: 52, height: 53 },
					glyph: { x: 361, y: 25.5, width: 12, height: 14 },
				},
			},
			{
				name: 'tag-owned-layout',
				css: '.bar{display:grid;grid-template-columns:1fr 36px;min-height:63px}.bar>button.toggle{grid-column:2;grid-row:1;width:36px;height:37px;margin:6px 0 20px;padding:0;border:0}.glyph{display:inline-block;width:12px;height:14px;background:blue}',
				at390: {
					trigger: { x: 354, y: 6, width: 36, height: 37 },
					glyph: { x: 366, y: 17.5, width: 12, height: 14 },
				},
			},
			{
				name: 'dropdown-marker',
				css: '.bar{position:relative;height:63px}.toggle{padding:0;border:0}.glyph{display:inline-block;width:12px;height:14px;background:blue}',
				presentation: 'dropdown' as const,
			},
		];
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			for ( const fixture of fixtures ) {
				const source = `<html><head><style>body{margin:0}${ fixture.css }</style></head><body><header class="bar"><span>Logo</span><button id="toggle" class="toggle" aria-label="Open Menu"><span class="glyph">M</span></button></header><main style="height:400px">Content</main></body></html>`;
				const state: CapturedDialogInteraction = {
					...captured,
					trigger: { ...captured.trigger, selector: '#toggle', id: 'toggle' },
					dialog: { ...captured.dialog!, ...( fixture.presentation ? { presentation: fixture.presentation } : {} ) },
				};
				const measure = () => page.evaluate( () => {
					const box = ( selector: string ) => {
						const element = document.querySelector( selector );
						if ( ! element ) return null;
						const rect = element.getBoundingClientRect();
						return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					};
					return { trigger: box( '#toggle' ), glyph: box( '.glyph' ), header: box( 'header' ), height: document.documentElement.scrollHeight };
				} );
				const wired = wireCapturedDialogs( source, [ state ] );
				expect( wired ).toContain( '<button id="toggle" class="toggle"' );
				expect( wired ).not.toContain( '<details' );
				expect( wired ).not.toContain( '<summary' );
				if ( fixture.presentation === 'dropdown' ) {
					expect( wired ).toContain( 'class="dla-dialog dla-dropdown"' );
					expect( wired ).not.toContain( 'class="toggle dla-disclosure"' );
				}
				for ( const width of [ 390, 768, 1440, 390, 1440, 768 ] ) {
					await page.setViewportSize( { width, height: 900 } );
					await page.setContent( source );
					const before = await measure();
					await page.setContent( wired );
					expect( await measure() ).toEqual( before );
					if ( width === 390 && fixture.at390 ) {
						expect( before.trigger ).toEqual( fixture.at390.trigger );
						expect( before.glyph ).toEqual( fixture.at390.glyph );
					}
				}
				const closed = await measure();
				const trigger = page.locator( '#toggle' );
				await trigger.focus();
				await page.keyboard.press( 'Enter' );
				const panel = page.locator( '[data-dla-dialog-panel]' );
				expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( false );
				expect( await panel.evaluate( element => getComputedStyle( element ).position ) ).toBe(
					fixture.presentation === 'dropdown' ? 'absolute' : 'fixed'
				);
				expect( await measure() ).toMatchObject( { trigger: closed.trigger, glyph: closed.glyph } );
				if ( fixture.presentation === 'dropdown' ) await trigger.click();
				else await page.locator( '[data-dla-dialog-close]' ).click();
				expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( true );
				expect( await trigger.evaluate( element => document.activeElement === element ) ).toBe( true );
				await page.keyboard.press( ' ' );
				expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( false );
				await page.keyboard.press( 'Escape' );
				expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( true );
				expect( await trigger.evaluate( element => document.activeElement === element ) ).toBe( true );
			}
		} finally { await browser.close(); }
	}, 60_000 );

	it( 'emits zero-specificity base disclosure rules so author utilities win', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button class="burger">Open Menu</button></body></html>',
			[ captured ]
		);
		const base = html.match( /<style data-dla-disclosure-base="true">([\s\S]*?)<\/style>/ )?.[ 1 ] ?? '';
		expect( base ).toContain(
			':where(details.dla-disclosure>summary){list-style:none;cursor:pointer;display:inline-block}'
		);
		expect( base ).toContain(
			':where(details.dla-disclosure>summary)::-webkit-details-marker{display:none}'
		);
		// In its own cascade layer, declared before anything else in <head>.
		expect( base.startsWith( '@layer dla-disclosure-base{' ) ).toBe( true );
		expect( html ).toMatch( /<head><style data-dla-disclosure-base="true">/ );
		const css = html.match( /<style data-dla-disclosure="true">([\s\S]*?)<\/style>/ )?.[ 1 ] ?? '';
		expect( css ).not.toContain( ':where(details.dla-disclosure>summary)' );
		expect( css ).not.toMatch( /(^|;)details\.dla-disclosure>summary(::-webkit-details-marker)?\{/ );
	} );

	it( 'keeps layered responsive summary visibility while retaining native disclosure behavior', async () => {
		const source = '<html><head><style>@layer utilities{@media(min-width:40rem){.sm\\:hidden{display:none}}.sm\\:hidden{width:36px;height:43px}}body{margin:0}header{height:104px} @media(max-width:39.999rem){header{height:96px}}</style></head><body><header><details class="dla-disclosure"><summary class="sm:hidden">Menu</summary><nav>Links</nav></details></header><button id="helper">Helper</button></body></html>';
		const portable = wireCapturedDialogs( source, [ {
			...captured,
			trigger: { ...captured.trigger, selector: '#helper' },
		} ] );
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.setContent( portable );
			for ( const width of [ 1280, 390 ] ) {
				await page.setViewportSize( { width, height: 844 } );
				const summary = page.locator( 'header details.dla-disclosure > summary' );
				expect( await page.locator( 'header' ).evaluate( element => element.getBoundingClientRect().height ) ).toBe( width === 1280 ? 104 : 96 );
				expect( await summary.evaluate( element => getComputedStyle( element ).display === 'none' ) ).toBe( width === 1280 );
				if ( width === 390 ) {
					expect( await summary.boundingBox() ).toMatchObject( { width: 36, height: 43 } );
					await summary.click();
					expect( await page.locator( 'header details' ).evaluate( element => ( element as HTMLDetailsElement ).open ) ).toBe( true );
					await summary.click();
					expect( await page.locator( 'header details' ).evaluate( element => ( element as HTMLDetailsElement ).open ) ).toBe( false );
				}
			}
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'lets layered author CSS keep a trigger\'s display (Substack restack button)', async () => {
		// derekthompson.org: Substack ships its CSS in cascade layers. Replacing the
		// restack button lost `.post-ufi-button{display:flex}` and wrapped the icon
		// and count onto two lines. The authored button must remain the trigger.
		const html = wireCapturedDialogs(
			'<html><head><style>@layer legacy,pencraft;@layer legacy{.post-ufi .post-ufi-button{display:flex;align-items:center;height:40px}}</style></head>' +
			'<body><div class="post-ufi"><button class="post-ufi-button" aria-haspopup="menu"><svg width="20" height="20"></svg><div class="label">68</div></button></div></body></html>',
			[
				{
					status: 'captured',
					trigger: { selector: '.post-ufi > button', tag: 'button', ariaHaspopup: 'menu', label: '68', dataBindings: {} },
					dialog: { selector: '#menu', tag: 'div', ariaModal: false, ariaLabel: 'Restack', html: '<div>Copy link</div>', htmlBytes: 20, htmlTruncated: false },
				},
			]
		);
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1600, height: 900 } } );
			await page.setContent( html );
			const button = page.locator( '.post-ufi > button.post-ufi-button' );
			expect( await button.count() ).toBe( 1 );
			expect( await button.evaluate( ( el ) => getComputedStyle( el ).display ) ).toBe( 'flex' );
			expect( ( await button.boundingBox() )?.height ).toBe( 40 );
			await page.setContent( wireCapturedDialogs(
				'<html><head></head><body><button class="burger">Open Menu</button></body></html>',
				[ captured ]
			) );
			expect( await page.locator( 'button.burger' ).evaluate( ( el ) => getComputedStyle( el ).display ) ).toBe( 'inline-block' );
		} finally {
			await browser.close();
		}
	} );

	it( 'lets an author md:hidden utility hide the toggle at 1600px while it still opens and closes the dialog at 390px', async () => {
		const html = wireCapturedDialogs(
			'<html><head><style>.burger{display:inline-flex}@media(min-width:768px){.md\\:hidden{display:none}}</style></head><body><header><a href="/">Logo</a><button class="burger md:hidden" aria-label="Toggle menu">Menu</button></header></body></html>',
			[
				{
					status: 'captured',
					trigger: {
						selector: 'header > button',
						tag: 'button',
						ariaHaspopup: '',
						label: 'Toggle menu',
						dataBindings: {},
					},
					dialog: {
						selector: '#menu',
						tag: 'div',
						ariaModal: true,
						ariaLabel: 'Menu',
						html: '<nav><a href="/about">About</a></nav>',
						htmlBytes: 32,
						htmlTruncated: false,
					},
				},
			]
		);
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1600, height: 900 } } );
			await page.setContent( html );
			const trigger = page.locator( 'header > button.burger' );
			expect(
				await trigger.evaluate( ( element ) => getComputedStyle( element ).display )
			).toBe( 'none' );
			await page.setViewportSize( { width: 390, height: 844 } );
			expect(
				await trigger.evaluate( ( element ) => getComputedStyle( element ).display )
			).toBe( 'inline-flex' );
			await trigger.click();
			const panel = page.locator( '[data-dla-dialog-panel]' );
			expect( await panel.evaluate( ( element ) => ( element as HTMLElement ).hidden ) ).toBe( false );
			expect( await panel.locator( 'a' ).getAttribute( 'href' ) ).toBe( '/about' );
			await page.setViewportSize( { width: 1600, height: 900 } );
			await expect.poll( () => panel.evaluate( ( element ) => ( element as HTMLElement ).hidden ) ).toBe( true );
			await page.setViewportSize( { width: 390, height: 844 } );
			await expect.poll( () => panel.evaluate( ( element ) => ( element as HTMLElement ).hidden ) ).toBe( false );
			await page.locator( '[data-dla-dialog-close]' ).click();
			expect( await panel.evaluate( ( element ) => ( element as HTMLElement ).hidden ) ).toBe( true );
			expect( await trigger.evaluate( ( element ) => document.activeElement === element ) ).toBe( true );
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'closes an open panel when a parent media query removes the trigger from layout', async () => {
		const html = wireCapturedDialogs(
			'<html><head><style>@media(min-width:768px){header{display:none}}</style></head><body><header><button class="burger" aria-label="Open Menu">Menu</button></header></body></html>',
			[ { ...captured, trigger: { ...captured.trigger, selector: 'header > button' } } ]
		);
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await page.setContent( html );
			const trigger = page.locator( 'header > button.burger' );
			await trigger.click();
			const panel = page.locator( '[data-dla-dialog-panel]' );
			expect( await panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( false );
			await page.setViewportSize( { width: 1440, height: 900 } );
			await expect.poll( () => panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( true );
			await page.setViewportSize( { width: 390, height: 844 } );
			await expect.poll( () => panel.evaluate( element => ( element as HTMLElement ).hidden ) ).toBe( false );
			expect( await trigger.boundingBox() ).toMatchObject( { width: expect.any( Number ), height: expect.any( Number ) } );
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'keeps the authored menu button and attaches a hidden panel', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button class="burger">Open Menu</button></body></html>',
			[ captured ]
		);
		expect( html ).toContain( '<button class="burger" data-dla-disclosure-label="Open Menu" data-dla-dialog-trigger="dla-dialog-0" aria-controls="dla-dialog-0" aria-expanded="false" aria-haspopup="dialog">Open Menu</button>' );
		expect( html ).toContain( 'class="dla-dialog" role="dialog"' );
		expect( html ).toContain( 'data-dla-dialog-close="dla-dialog-0"' );
		expect( html ).toContain( 'href="/about"' );
		expect( html ).toContain( 'data-dla-disclosure-runtime' );
		expect( html ).not.toContain( '<details' );
		expect( html ).not.toContain( '<summary' );
	} );

	it( 'derives aria-modal from the observed presentation', () => {
		const page = '<html><head></head><body><button class="burger">Open Menu</button></body></html>';
		const modal = wireCapturedDialogs( page, [ { ...captured, dialog: { ...captured.dialog!, presentation: 'modal' } } ] );
		expect( modal ).toContain( '<div class="dla-dialog" role="dialog" aria-modal="true" hidden=""' );
		const unobserved = wireCapturedDialogs( page, [ captured ] );
		expect( unobserved ).toContain( 'aria-modal="true"' );
		const dropdown = wireCapturedDialogs( page, [ { ...captured, dialog: { ...captured.dialog!, presentation: 'dropdown' } } ] );
		expect( dropdown ).toContain( 'data-dla-dialog-panel="dla-dialog-0"' );
		expect( dropdown ).toMatch( /<div class="dla-dialog( dla-dropdown)?" role="dialog" hidden=""/ );
		expect( dropdown ).not.toContain( 'aria-modal' );
	} );

	it( 'wires every copy of the trigger, not just the first', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button>Open Menu</button><button>Open Menu</button></body></html>',
			[ captured ]
		);
		expect( html.match( /data-dla-dialog-trigger=/g ) ).toHaveLength( 2 );
		expect( html.match( /Open Menu<\/button>/g ) ).toHaveLength( 2 );
	} );

	it( 'replaces the captured portal without retaining its closed source copy', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button>Open Menu</button><div id="menu" data-visible="false"><nav><a href="/stale">Stale menu</a></nav></div><div id="other-dialog">Keep me</div></body></html>',
			[ captured ]
		);
		expect( html ).not.toContain( 'Stale menu' );
		expect( html ).not.toContain( 'id="menu"' );
		expect( html ).toContain( 'data-dla-dialog-panel="dla-dialog-0"' );
		expect( html ).toContain( 'href="/about"' );
		expect( html ).toContain( '<div id="other-dialog">Keep me</div>' );
	} );

	it( 'does not turn an unlabeled logo control into the menu trigger', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><a class="logo" role="button"><img alt="Homepage"></a><button>Open Menu</button></body></html>',
			[ captured ]
		);
		expect( html.match( /data-dla-dialog-trigger=/g ) ).toHaveLength( 1 );
		expect( html ).toContain( '<a class="logo" role="button"><img alt="Homepage"></a>' );
	} );

	it( 'keeps the authored trigger, including element-specific attributes, without nesting another control', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button class="menu" aria-label="Open Menu" data-menu="primary" type="submit" name="menu">Menu</button></body></html>',
			[ captured ]
		);
		expect( html ).toContain(
			'<button class="menu" aria-label="Open Menu" data-menu="primary" type="submit" name="menu" data-dla-disclosure-label="Open Menu" data-dla-dialog-trigger="dla-dialog-0" aria-controls="dla-dialog-0" aria-expanded="false" aria-haspopup="dialog">Menu</button>'
		);
		expect( html ).toContain( '<button type="button" hidden="" data-dla-dialog-close="dla-dialog-0" aria-label="Close Open Menu">Close</button>' );
		expect( html ).not.toContain( '<summary' );
	} );

	it( 'replays a captured button trigger onto that button, not a sibling nav link sharing its label', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><header><nav><a href="/#menu">Menu</a><a href="/#concept">Concept</a></nav><button aria-label="Menu"><svg></svg></button></header></body></html>',
			[
				{
					status: 'captured',
					trigger: {
						selector: 'body > header > button',
						tag: 'button',
						ariaHaspopup: '',
						label: 'Menu',
						dataBindings: {},
					},
					dialog: {
						selector: 'nav.md\\:hidden',
						tag: 'nav',
						ariaModal: false,
						html: '<nav class="md:hidden"><a href="/#concept">Concept</a><a href="/#menu">Menu</a></nav>',
						htmlBytes: 78,
						htmlTruncated: false,
					},
				},
			]
		);
		expect( html.match( /data-dla-dialog-trigger=/g ) ).toHaveLength( 1 );
		expect( html ).toContain( '<a href="/#menu">Menu</a>' );
		expect( html ).toMatch( /<nav><a href="\/#menu">Menu<\/a><a href="\/#concept">Concept<\/a><\/nav>/ );
		expect( html ).toContain( '<button aria-label="Menu" data-dla-disclosure-label="Menu" data-dla-dialog-trigger="dla-dialog-0"' );
		expect( html ).toContain( '<svg></svg></button>' );
	} );

	it( 'still converts the captured button when its selector no longer matches, without touching a navigating Menu link', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><nav><a href="/#menu">Menu</a></nav><div><button>Menu</button></div></body></html>',
			[
				{
					status: 'captured',
					trigger: {
						selector: 'body > header > button',
						tag: 'button',
						ariaHaspopup: '',
						label: 'Menu',
						dataBindings: {},
					},
					dialog: {
						selector: '#drawer',
						tag: 'nav',
						ariaModal: false,
						html: '<nav id="drawer"><a href="/about">About</a></nav>',
						htmlBytes: 48,
						htmlTruncated: false,
					},
				},
			]
		);
		expect( html.match( /data-dla-dialog-trigger=/g ) ).toHaveLength( 1 );
		expect( html ).toContain( '<a href="/#menu">Menu</a>' );
		expect( html ).toContain( '<button data-dla-disclosure-label="Menu" data-dla-dialog-trigger="dla-dialog-0"' );
		expect( html ).not.toContain( '<summary' );
	} );

	it( 'does not convert a navigating link that only shares the captured trigger label', () => {
		const input =
			'<html><head></head><body><nav><a href="/#menu">Menu</a></nav></body></html>';
		const html = wireCapturedDialogs( input, [
			{
				status: 'captured',
				trigger: {
					selector: 'body > header > button',
					tag: 'button',
					ariaHaspopup: '',
					label: 'Menu',
					dataBindings: {},
				},
				dialog: {
					selector: '#drawer',
					tag: 'nav',
					ariaModal: false,
					html: '<nav id="drawer"><a href="/about">About</a></nav>',
					htmlBytes: 48,
					htmlTruncated: false,
				},
			},
		] );
		expect( html ).toContain( '<a href="/#menu">Menu</a>' );
		expect( html ).not.toContain( 'dla-disclosure' );
	} );

	it( 'leaves the page alone when nothing was captured', () => {
		const input = '<html><body><button>Open Menu</button></body></html>';
		expect( wireCapturedDialogs( input, [] ) ).toBe( input );
	} );

	it( 'leaves a disclosure/accordion state alone — its content is already inline, not a popup to wire', () => {
		// hydrateDisclosureContent restores disclosure panels into the live DOM
		// BEFORE the page is serialized, so `html` here already contains the
		// answer. A `kind: 'disclosure'` state must not ALSO be wrapped into a
		// synthetic full-screen `<details>` dialog overlay — that would
		// duplicate the content and misrepresent an inline accordion as a modal.
		const input =
			'<html><head></head><body><button aria-expanded="false" id="t1">Question?</button><div id="p1" hidden role="region" aria-labelledby="t1"><p>Answer text.</p></div></body></html>';
		const html = wireCapturedDialogs( input, [
			{
				status: 'captured',
				kind: 'disclosure',
				trigger: {
					selector: '#t1',
					id: 't1',
					tag: 'button',
					ariaHaspopup: '',
					ariaControls: 'p1',
					label: 'Question?',
					dataBindings: {},
				},
				dialog: {
					selector: '#p1',
					tag: 'div',
					id: 'p1',
					role: 'region',
					ariaModal: false,
					html: '<div id="p1" hidden role="region" aria-labelledby="t1"><p>Answer text.</p></div>',
					htmlBytes: 60,
					htmlTruncated: false,
				},
			},
		] );
		expect( html ).toBe( input );
		expect( html ).not.toContain( 'dla-disclosure' );
	} );

	it( 'leaves a selectable-set state alone — it is shared-region evidence, not a popup to wire', () => {
		const input =
			'<html><head></head><body><div id="z1">Zone 1</div><div id="panel">Placeholder</div></body></html>';
		const html = wireCapturedDialogs( input, [
			{
				status: 'captured',
				kind: 'selectable-set',
				trigger: {
					selector: '#z1',
					id: 'z1',
					tag: 'div',
					ariaHaspopup: '',
					label: 'Zone 1',
					dataBindings: {},
				},
				dialog: {
					selector: '#panel',
					tag: 'div',
					id: 'panel',
					ariaModal: false,
					html: '<div id="panel">Zone 1 details</div>',
					htmlBytes: 36,
					htmlTruncated: false,
				},
				set: { selector: 'body > div:nth-of-type(1)', size: 1, index: 0 },
			},
		] );
		expect( html ).toBe( input );
		expect( html ).not.toContain( 'dla-disclosure' );
	} );

	it( 'replays observed choice-group transitions offline, including keyboard activation', async () => {
		const choice = ( index: number, selected: number ) =>
			`<div id="rating"><label id="rating-label">Rating</label><div class="choices">${ [ 0, 1, 2 ]
				.map( ( choiceIndex ) => `<button type="button" data-dla-choice-index="${ choiceIndex }"><svg class="${ choiceIndex <= selected ? 'filled' : 'empty' }"></svg></button>` )
				.join( '' ) }</div></div>`;
		const states: CapturedDialogInteraction[] = [ 0, 1, 2 ].map( ( index ) => ( {
			status: 'captured',
			kind: 'choice-group',
			trigger: {
				selector: `#rating button:nth-of-type(${ index + 1 })`,
				tag: 'button',
				ariaHaspopup: '',
				dataBindings: {},
			},
			set: { selector: '#choices', size: 3, index },
			choiceGroup: {
				group: {
					selector: '#rating',
					tag: 'div',
					id: 'rating',
					label: 'Rating',
					labelSelector: '#rating-label',
				},
				choices: [ 0, 1, 2 ].map( ( choiceIndex ) => ( {
					index: choiceIndex,
					selector: `#rating button:nth-of-type(${ choiceIndex + 1 })`,
					tag: 'button',
					value: null,
				} ) ),
				transition: {
					selectedIndex: index,
					selected: [ null, null, null ],
					html: choice( index, index ),
					htmlBytes: choice( index, index ).length,
					htmlTruncated: false,
				},
				replay: 'activation-determined',
				restoration: 'verified',
				coverage: 'complete',
			},
		} ) );
		const html = wireCapturedDialogs(
			'<html><head></head><body><div id="rating"><label id="rating-label">Rating</label><div class="choices"><button type="button"><svg class="filled"></svg></button><button type="button"><svg class="filled"></svg></button><button type="button"><svg class="filled"></svg></button></div></div></body></html>',
			states
		);
		expect( html ).toContain( 'data-dla-choice-runtime' );
		expect( html ).toContain( 'data-dla-choice-group="0"' );
		expect( html ).toContain( 'Rating' );

		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.setContent( html );
			const buttons = page.locator( '#rating button' );
			await buttons.nth( 0 ).click();
			expect( await page.locator( '#rating svg' ).evaluateAll( ( svgs ) => svgs.map( ( svg ) => svg.getAttribute( 'class' ) ) ) ).toEqual( [ 'filled', 'empty', 'empty' ] );
			await buttons.nth( 2 ).focus();
			await page.keyboard.press( 'Enter' );
			expect( await page.locator( '#rating svg' ).evaluateAll( ( svgs ) => svgs.map( ( svg ) => svg.getAttribute( 'class' ) ) ) ).toEqual( [ 'filled', 'filled', 'filled' ] );
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'does not wire a choice group whose repeated activation is history-dependent', () => {
		const input = '<html><head></head><body><div id="history"><button>A</button><button>B</button></div></body></html>';
		const state: CapturedDialogInteraction = {
			status: 'captured',
			kind: 'choice-group',
			trigger: { selector: '#history button', tag: 'button', ariaHaspopup: '', dataBindings: {} },
			choiceGroup: {
				group: { selector: '#history', tag: 'div', id: 'history' },
				choices: [ 0, 1 ].map( ( index ) => ( { index, selector: `#history button:nth-of-type(${ index + 1 })`, tag: 'button', value: null } ) ),
				transition: { selectedIndex: 0, selected: [ null, null ], html: '<div id="history"><button data-dla-choice-index="0">A</button><button data-dla-choice-index="1">B</button></div>', htmlBytes: 115, htmlTruncated: false },
				replay: 'unsupported',
				replayReason: 'repeated activation was history-dependent',
				restoration: 'verified',
				coverage: 'complete',
			},
		};
		expect( wireCapturedDialogs( input, [ state ] ) ).toBe( input );
	} );

	it( 'wires a listbox popup onto every matching country-code trigger', () => {
		const html = wireCapturedDialogs(
			'<html><head></head><body><button aria-label="Phone. Phone. Select a country code" aria-haspopup="listbox">CA</button><button aria-label="Phone. Phone. Select a country code">CA</button></body></html>',
			[
				{
					status: 'captured',
					trigger: {
						selector: 'body > button',
						tag: 'button',
						ariaHaspopup: 'listbox',
						label: 'Phone. Phone. Select a country code',
						dataBindings: {},
					},
					dialog: {
						selector: '[role="listbox"]',
						tag: 'div',
						role: 'listbox',
						ariaModal: false,
						html: '<div role="listbox"><div role="option">Canada +1</div></div>',
						htmlBytes: 64,
						htmlTruncated: false,
					},
				},
			]
		);
		expect( html.match( /data-dla-listbox-trigger=/g ) ).toHaveLength( 2 );
		expect( html ).toContain( 'role="option"' );
		expect( html ).toContain( 'Canada +1' );
		expect( html ).toContain( 'data-dla-listbox-runtime' );
	} );
} );
