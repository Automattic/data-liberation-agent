import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureTriggeredDialogs } from './interaction-capture.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

const page = ( reveal: string, action: string ) => `<!doctype html><style>
	body{margin:0}#lead{height:1400px}
	.reveal{opacity:0;transform:translateX(-60px);transition:opacity .35s,transform .35s}
	.reveal.in{opacity:1;transform:none}
	#extra{display:none}#extra.open{display:block}
</style>
<main><div id="lead"></div>
<div id="reviews" class="reveal"><p>Customer review</p><div role="button" tabindex="0">Next</div><button type="button" aria-label="Previous">&lt;</button></div>
<div id="contact"><p>Write to us</p><button id="send" type="button">Send</button></div>
<div id="extra"><p>Thanks</p><a href="/more">More</a></div></main>
<script>
	${ reveal }
	send.onclick = () => { ${ action } };
</script>`;

const observer = `new IntersectionObserver( entries => entries.forEach( entry => {
	if ( entry.isIntersecting ) entry.target.classList.add( 'in' );
} ) ).observe( reviews );`;

it.skipIf( skipBrowser )( 'keeps a scroll-reveal section in the baseline of a plain action button probe', async () => {
	const browser = await chromium.launch( { headless: true } );
	try {
		const tab = await browser.newPage( { viewport: { width: 1280, height: 800 } } );
		await tab.setContent( page( observer, '' ) );
		const report = await captureTriggeredDialogs( tab, 'https://fixture.test/' );
		const send = report.states.find( state => state.trigger.label === 'Send' );
		expect( send?.status ).not.toBe( 'captured' );
		expect( send?.dialog?.html ?? '' ).not.toContain( 'Customer review' );
	} finally {
		await browser.close();
	}
}, 30000 );

it.skipIf( skipBrowser )( 'still captures the panel a plain action button reveals beside a scroll-reveal section', async () => {
	const browser = await chromium.launch( { headless: true } );
	try {
		const tab = await browser.newPage( { viewport: { width: 1280, height: 800 } } );
		await tab.setContent( page( observer, `extra.classList.add( 'open' );` ) );
		const report = await captureTriggeredDialogs( tab, 'https://fixture.test/' );
		const send = report.states.find( state => state.trigger.label === 'Send' );
		expect( send?.status ).toBe( 'captured' );
		expect( send?.dialog?.html ).toContain( 'Thanks' );
		expect( send?.dialog?.html ).not.toContain( 'Customer review' );
	} finally {
		await browser.close();
	}
}, 30000 );
