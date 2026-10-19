import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateDisclosureContent } from './dynamic-content.js';
import { captureSelectableSetStates } from './selectable-set-capture.js';
import { choiceGroupInteractionLosses, wireCapturedDialogs } from '../static-dialogs.js';
import type { CapturedDialogInteraction } from './interaction-capture.js';

const skipBrowser = process.env.SKIP_BROWSER_TESTS;

// Neutral fixture from #901: each item toggles its own hidden answer, with no
// ARIA. The real source styled items with a pointer cursor.
const FAQ = `<!doctype html><html><head><style>.hidden{display:none}.item{cursor:pointer}</style></head><body><main>
<div class="faq">
  <div class="item" onclick="this.querySelector('.a').classList.toggle('hidden')"><div><h3>Question one?</h3><span>+</span></div><div class="a hidden"><p>Answer one with some words.</p></div></div>
  <div class="item" onclick="this.querySelector('.a').classList.toggle('hidden')"><div><h3>Question two?</h3><span>+</span></div><div class="a hidden"><p>Answer two with other words.</p></div></div>
  <div class="item" onclick="this.querySelector('.a').classList.toggle('hidden')"><div><h3>Question three?</h3><span>+</span></div><div class="a hidden"><p>Answer three.</p></div></div>
</div>
</main></body></html>`;

// The reported source's handler also flips its icon's glyph and colour class,
// and re-adding `hidden` moves it after the answer's other class tokens.
const iconItem = ( question: string, answer: string ) =>
	`<div class="faq-item" onclick="toggleFaq(this)"><div><h3>${ question }</h3><span class="faq-icon">+</span></div><div class="faq-answer hidden answer-body"><p>${ answer }</p></div></div>`;
const FAQ_ICON = `<!doctype html><html><head><style>.hidden{display:none}.faq-item{cursor:pointer}.accent{color:green}</style></head><body><main>
<section class="faqs">${ iconItem( 'Shipping?', 'Orders ship within two days.' ) }${ iconItem( 'Returns?', 'Returns are accepted for thirty days.' ) }</section>
<script>function toggleFaq(item){var answer=item.querySelector('.faq-answer'),icon=item.querySelector('.faq-icon');var hidden=answer.classList.contains('hidden');answer.classList.toggle('hidden',!hidden);icon.textContent=hidden?'\u00d7':'+';icon.classList.toggle('accent',hidden);}</script>
</main></body></html>`;

// What export does to captured source: no scripts, no inline handlers.
const portable = ( html: string ) =>
	html.replace( /<script\b[\s\S]*?<\/script>/gi, '' ).replace( /\son[a-z]+="[^"]*"/gi, '' );

describe.skipIf( skipBrowser )( 'non-ARIA click disclosures (#901)', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser?.close(); } );

	it( 'captures items that toggle their own hidden answer as independent local disclosures', async () => {
		const page = await browser.newPage();
		await page.setContent( FAQ );
		const records = await hydrateDisclosureContent( page );
		expect( records.filter( ( record ) => record.status === 'captured' ) ).toHaveLength( 3 );
		// The source baseline is unchanged: every answer is still concealed.
		expect( await page.locator( '.a' ).evaluateAll( ( nodes ) => nodes.map( ( node ) => getComputedStyle( node ).display ) ) )
			.toEqual( [ 'none', 'none', 'none' ] );
		// Disclosure triggers are not re-probed as a choice group.
		const selectable = await captureSelectableSetStates( page );
		expect( selectable.filter( ( state ) => state.kind === 'choice-group' ) ).toHaveLength( 0 );

		const offline = wireCapturedDialogs( portable( await page.content() ), records );
		expect( offline ).toContain( 'data-blocks-engine-capture-local-disclosure-runtime' );
		expect( offline ).toContain( 'Answer two with other words.' );
		await page.setContent( offline );
		const items = page.locator( '.item' );
		const answers = page.locator( '.a' );
		for ( let index = 0; index < 3; index++ ) expect( await answers.nth( index ).isVisible() ).toBe( false );
		await items.nth( 0 ).locator( 'h3' ).click();
		expect( await answers.nth( 0 ).isVisible() ).toBe( true );
		expect( await answers.nth( 0 ).innerText() ).toBe( 'Answer one with some words.' );
		await items.nth( 1 ).locator( 'h3' ).click();
		// Independent: both open at once.
		expect( await answers.nth( 0 ).isVisible() ).toBe( true );
		expect( await answers.nth( 1 ).isVisible() ).toBe( true );
		expect( await items.nth( 1 ).getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		// A second activation closes.
		await items.nth( 0 ).locator( 'h3' ).click();
		expect( await answers.nth( 0 ).isVisible() ).toBe( false );
		expect( await answers.nth( 1 ).isVisible() ).toBe( true );
		expect( await answers.nth( 2 ).isVisible() ).toBe( false );
		await page.close();
	} );

	it( 'keeps an item whose icon flips its glyph as a local disclosure with the closed glyph', async () => {
		const page = await browser.newPage();
		await page.setContent( FAQ_ICON );
		const records = await hydrateDisclosureContent( page );
		expect( records.filter( ( record ) => record.status === 'captured' ) ).toHaveLength( 2 );
		await page.setContent( wireCapturedDialogs( portable( await page.content() ), records ) );
		const answers = page.locator( '.faq-answer' );
		expect( await answers.nth( 1 ).isVisible() ).toBe( false );
		await page.locator( '.faq-item' ).nth( 1 ).locator( 'h3' ).click();
		expect( await answers.nth( 1 ).innerText() ).toBe( 'Returns are accepted for thirty days.' );
		expect( await page.locator( '.faq-icon' ).nth( 1 ).getAttribute( 'class' ) ).toBe( 'faq-icon accent' );
		await page.locator( '.faq-item' ).nth( 1 ).locator( 'h3' ).click();
		expect( await answers.nth( 1 ).isVisible() ).toBe( false );
		expect( await page.locator( '.faq-icon' ).nth( 1 ).getAttribute( 'class' ) ).toBe( 'faq-icon' );
		await page.close();
	} );

	it( 'indexes choice-group members, not their same-tag descendants, and reports an unreplayable group', async () => {
		const page = await browser.newPage();
		await page.setContent( FAQ );
		// Without disclosure hydration the items are still probed as a choice group.
		const states = await captureSelectableSetStates( page );
		const choices = states.filter( ( state ) => state.kind === 'choice-group' && state.choiceGroup );
		expect( choices.length ).toBeGreaterThan( 0 );
		const html = choices[ 0 ]!.choiceGroup!.transition.html;
		const indexed = await page.evaluate( ( markup ) => {
			const holder = document.createElement( 'div' );
			holder.innerHTML = markup;
			return Array.from( holder.querySelectorAll( '[data-blocks-engine-capture-choice-index]' ), ( node ) => ( {
				index: node.getAttribute( 'data-blocks-engine-capture-choice-index' ),
				item: node.classList.contains( 'item' ),
			} ) );
		}, html );
		expect( indexed ).toEqual( [
			{ index: '0', item: true },
			{ index: '1', item: true },
			{ index: '2', item: true },
		] );
		expect( choices.every( ( state ) => state.choiceGroup!.replay === 'unsupported' ) ).toBe( true );
		const losses = choiceGroupInteractionLosses( states );
		expect( losses ).toHaveLength( 1 );
		expect( losses[ 0 ] ).toMatchObject( { code: 'interaction_unreplayable', severity: 'warning' } );
		expect( losses[ 0 ]!.reason ).toContain( '3 choices' );
		await page.close();
	} );
} );

describe( 'choiceGroupInteractionLosses', () => {
	const state = ( overrides: Partial< NonNullable< CapturedDialogInteraction[ 'choiceGroup' ] > > ): CapturedDialogInteraction => ( {
		status: 'captured',
		kind: 'choice-group',
		trigger: { selector: '#a', tag: 'div', ariaHaspopup: '', dataBindings: {} },
		choiceGroup: {
			group: { selector: '#group', tag: 'div' },
			choices: [ { index: 0, selector: '#a', tag: 'div', value: null }, { index: 1, selector: '#b', tag: 'div', value: null } ],
			transition: { selectedIndex: 0, selected: [ true, false ], html: '<div></div>', htmlBytes: 11, htmlTruncated: false },
			replay: 'activation-determined',
			restoration: 'verified',
			coverage: 'complete',
			...overrides,
		},
	} );

	it( 'records nothing for a group the export replays', () => {
		expect( choiceGroupInteractionLosses( [ state( {} ), state( {} ) ] ) ).toEqual( [] );
	} );

	it( 'records one loss per unreplayable group with the probe reason', () => {
		const losses = choiceGroupInteractionLosses( [
			state( { replay: 'unsupported', replayReason: 'source actions did not restore the initial choice state' } ),
			state( { replay: 'unsupported', replayReason: 'source actions did not restore the initial choice state' } ),
		] );
		expect( losses ).toEqual( [ {
			code: 'interaction_unreplayable',
			severity: 'warning',
			reason: 'choice group #group (2 choices) ships as static markup: source actions did not restore the initial choice state',
		} ] );
	} );
} );
