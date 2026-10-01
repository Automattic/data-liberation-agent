import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureSelectableSetStates } from './selectable-set-capture.js';
import { captureTypedSearchStates } from './typed-search-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';

let browser: Browser;
beforeAll( async () => { browser = await chromium.launch({ headless: true }); } );
afterAll( async () => { await browser?.close(); } );
const fixture = `<!doctype html><html><head><style>[hidden]{display:none}.active{color:red}</style></head><body>
<main><input type="search" placeholder="Find entries"><div id="categories"><button class="active">Everything</button><button>First</button><button>Second</button></div><div id="items"></div></main>
<script>const entries=[['Same heading','Evidence for apples',1],['Same heading','Evidence for oranges',2],['Other heading','Fresh berries',2]];let category=0;
function render(){const query=document.querySelector('input').value.toLowerCase();document.querySelectorAll('#categories button').forEach((b,i)=>b.className=i===category?'active':'');document.querySelector('#items').innerHTML=entries.filter(e=>(!category||e[2]===category)&&(e[0]+' '+e[1]).toLowerCase().includes(query)).map(e=>'<article><h2>'+e[0]+'</h2><p>'+e[1]+'</p></article>').join('')||'<p>No entries match.</p>';}
document.querySelector('input').addEventListener('input',render);document.querySelectorAll('#categories button').forEach((b,i)=>b.onclick=()=>{category=i;render()});render();</script></body></html>`;

describe( 'source-backed typed collection filtering', () => {
	it( 'confirms answer-only text, case and category composition, restores source, and replays one editable tree offline', async () => {
		const page = await browser.newPage(); await page.setContent( fixture );
		const baseline = await page.locator('main').innerText();
		const categories = await captureSelectableSetStates( page, { settleMs: 10 } );
		const states = await captureTypedSearchStates( page, categories, { settleMs: 10 } );
		expect( states ).toHaveLength(1);
		expect( states[0] ).toMatchObject({ status: 'captured', collectionFilter: { replay: 'verified', restoration: 'verified' } });
		expect( await page.locator('main').innerText() ).toBe( baseline );
		const html = wireCapturedDialogs( (await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''), [...categories,...states] );
		await page.setContent( html );
		expect( await page.locator('article').count() ).toBe(3);
		await page.locator('input').fill('ORANGES');
		expect( await page.locator('article:visible').count() ).toBe(1);
		await page.getByRole('button',{name:'First',exact:true}).click();
		expect( await page.locator('article:visible').count() ).toBe(0);
		expect( await page.getByText('No entries match.',{exact:true}).isVisible() ).toBe(true);
		await page.getByRole('button',{name:'Second',exact:true}).click();
		expect( await page.locator('article:visible').count() ).toBe(1);
		await page.locator('article p').nth(1).evaluate(e=>e.textContent='Edited plum answer');
		await page.locator('input').fill('plum');
		expect( await page.locator('article:visible').count() ).toBe(1);
		await page.locator('input').fill('');await page.getByRole('button',{name:'Everything',exact:true}).click();
		expect( await page.locator('article:visible').count() ).toBe(3);
		await page.close();
	}, 30_000 );
	it( 'does not replay a source predicate that only matches headings', async () => {
		const page = await browser.newPage();await page.setContent(fixture.replace("(e[0]+' '+e[1]).toLowerCase()", "e[0].toLowerCase()"));
		const categories=await captureSelectableSetStates(page,{settleMs:10});
		const states=await captureTypedSearchStates(page,categories,{settleMs:10});
		expect(states[0]?.collectionFilter?.replay).toBe('unsupported');
		expect(states[0]?.collectionFilter?.restoration).toBe('verified');
		await page.close();
	},30_000);
	it( 'captures an empty-state mounted outside the collection without inventing copy', async () => {
		const page=await browser.newPage();
		await page.setContent(fixture.replace("||'<p>No entries match.</p>';", ";document.querySelector('#empty')?.remove();if(!document.querySelector('#items').children.length)document.querySelector('#items').insertAdjacentHTML('afterend','<aside id=\"empty\">No entries match.</aside>');"));
		const categories=await captureSelectableSetStates(page,{settleMs:10});
		const states=await captureTypedSearchStates(page,categories,{settleMs:10});
		expect(states[0]).toMatchObject({status:'captured',collectionFilter:{emptyPlacement:'after',restoration:'verified'}});
		const html=wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''),states);
		await page.setContent(html);await page.locator('input').fill('missing');
		expect(await page.getByText('No entries match.',{exact:true}).isVisible()).toBe(true);
		await page.close();
	},30_000);
	it( 'keeps an empty collection explicitly unsupported', async () => {
		const page=await browser.newPage();await page.setContent('<input type="search"><section>No entries yet.</section>');
		expect(await captureTypedSearchStates(page,[],{settleMs:10})).toMatchObject([{kind:'typed-search',status:'no-dialog',error:expect.stringContaining('No complete')}]);
		await page.close();
	});
	it( 'binds captured membership by complete item identity when baseline order changes', async () => {
		const page=await browser.newPage();await page.setContent(fixture);
		const categories=await captureSelectableSetStates(page,{settleMs:10});const states=await captureTypedSearchStates(page,categories,{settleMs:10});
		await page.locator('#items').evaluate(element=>element.append(element.firstElementChild!));
		const html=wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''),states);
		await page.setContent(html);await page.getByRole('button',{name:'First',exact:true}).click();
		expect(await page.locator('article:visible').innerText()).toContain('Evidence for apples');
		await page.close();
	},30_000);
	it( 'rejects results that depend on fetching source data', async () => {
		const page=await browser.newPage();await page.route('https://fixture.invalid/**',route=>route.fulfill({body:'{}',contentType:'application/json'}));
		await page.setContent(fixture.replace("document.querySelector('input').addEventListener('input',render)","document.querySelector('input').addEventListener('input',()=>{fetch('https://fixture.invalid/data').then(render).catch(()=>{})})"));
		const categories=await captureSelectableSetStates(page,{settleMs:10});
		const states=await captureTypedSearchStates(page,categories,{settleMs:20});
		expect(states[0]).toMatchObject({status:'no-dialog',collectionFilter:{replay:'unsupported',restoration:'verified',network:{dataRequests:'blocked',blockedRequests:expect.any(Number)}}});
		await page.close();
	},30_000);
});
