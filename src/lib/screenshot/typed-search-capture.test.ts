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
	it( 'admits a neutral text field from observed filtering and captures content outside a labeled tablist', async () => {
		const source = `<!doctype html><body><main><form><input type="text" name="name" aria-label="Your name"><input type="text" name="email" aria-label="Email address"><input type="text" name="phone" aria-label="Phone number"></form><input type="text" aria-label="Browse entries"><div role="tablist" aria-label="Topics"><button role="tab" aria-selected="true">All</button><button role="tab" aria-selected="false">One</button><button role="tab" aria-selected="false">Two</button></div><section id="results"></section></main><script>
		const rows=[['Question alpha','A detailed answer about apricot fruit',1],['Question beta','A detailed answer about blueberry fruit',2],['Question gamma','A detailed answer about citrus fruit',2]];let selected=0;function render(){document.querySelectorAll('[role=tab]').forEach((tab,i)=>tab.setAttribute('aria-selected',String(i===selected)));const q=document.querySelector('[aria-label="Browse entries"]').value.toLowerCase();document.querySelector('#results').innerHTML=rows.filter(row=>(!selected||row[2]===selected)&&row.join(' ').toLowerCase().includes(q)).map(row=>'<article><h2>'+row[0]+'</h2><p>'+row[1]+'</p></article>').join('')||'<p>No results found.</p>';}document.querySelector('[aria-label="Browse entries"]').addEventListener('input',render);document.querySelectorAll('[role=tab]').forEach((tab,i)=>tab.onclick=()=>{selected=i;render()});render();</script></body>`;
		const page = await browser.newPage(); await page.setContent(source);
		const categories = await captureSelectableSetStates(page, { settleMs: 10 });
		expect(categories.some(state => state.kind === 'selectable-set' && state.dialog?.selector === '#results')).toBe(true);
		const states = await captureTypedSearchStates(page, categories, { settleMs: 10 });
		expect(states[0]).toMatchObject({ status: 'captured', kind: 'typed-search', collectionFilter: { replay: 'verified', restoration: 'verified', mode: 'category-and-query', network: { dataRequests: 'blocked', verification: 'all-requests-blocked' } } });
		expect(await page.locator(states[0]!.collectionFilter!.field.selector).getAttribute('aria-label')).toBe('Browse entries');
		expect(await page.locator('#results article').count()).toBe(3);
		await page.close();
	}, 30_000 );
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
	it( 'captures a finite query-independent bootstrap as an alternate category or global-search mode', async () => {
		const page = await browser.newPage();
		await installFinite( page, 'finite' );
		const categories = await captureSelectableSetStates( page, { settleMs: 150 } );
		expect( categories.some( state => state.kind === 'selectable-set' && state.dialog?.selector === '#results' ) ).toBe( true );
		const states = await captureTypedSearchStates( page, categories, { settleMs: 80 } );
		expect( states[ 0 ] ).toMatchObject( {
			status: 'captured',
			collectionFilter: {
				replay: 'verified', restoration: 'verified', mode: 'category-or-global-search',
				network: { dataRequests: 'observed-response-replay', verification: 'intercepted-observed-responses' },
				finiteBootstrap: {
					schema: 'data-liberation/finite-bootstrap/v1', mode: 'category-or-global-search', queryIndependent: true,
					completeness: 'declared-finite', declaredCount: 4, observedItemCount: 4, coverage: 'complete',
					verification: 'intercepted-observed-responses', unmatchedProbeBlocked: true, categoryControlsDuringSearch: 'hidden',
					emptyQueryRestoresCategory: true, answers: 'observed', answerOnly: 'verified',
				},
			},
		} );
		expect( Object.keys( states[ 0 ]!.collectionFilter!.finiteBootstrap! ).sort() ).toEqual( [ 'answerOnly', 'answers', 'blockedFollowUps', 'categoryControlsDuringSearch', 'completeness', 'coverage', 'declaredCount', 'emptyQueryRestoresCategory', 'mode', 'observedItemCount', 'probes', 'queryIndependent', 'replayedResponses', 'schema', 'sourceFollowUpsBlocked', 'unmatchedProbeBlocked', 'verification' ] );
		expect( await page.locator( states[ 0 ]!.collectionFilter!.field.selector ).getAttribute( 'aria-label' ) ).toBe( 'Browse entries' );
		expect( states[ 0 ]!.collectionFilter!.items ).toHaveLength( 4 );
		expect( states[ 0 ]!.collectionFilter!.items!.some( item => ! item.categories.includes( states[ 0 ]!.collectionFilter!.initialCategory ) ) ).toBe( true );
		const html = wireCapturedDialogs( ( await page.content() ).replace( /<script>[\s\S]*?<\/script>/g, '' ), states );
		await page.setContent( html );
		expect( await page.locator( 'article' ).count() ).toBe( 4 );
		await page.locator( 'input[aria-label="Browse entries"]' ).fill( 'APRICOT' );
		expect( await page.locator( 'article:visible' ).count() ).toBe( 1 );
		expect( await page.locator( '[role="tab"]:visible' ).count() ).toBe( 0 );
		await page.locator( 'input[aria-label="Browse entries"]' ).fill( 'recommendations' );
		expect( await page.locator( 'article:visible' ).innerText() ).toContain( 'Question delta' );
		await page.locator( 'input[aria-label="Browse entries"]' ).fill( 'dla-no-match-7f39b2' );
		expect( await page.getByText( 'No results found.', { exact: true } ).isVisible() ).toBe( true );
		await page.locator( 'input[aria-label="Browse entries"]' ).fill( '' );
		expect( await page.locator( 'article:visible' ).count() ).toBe( 2 );
		expect( await page.locator( '[role="tab"]:visible' ).count() ).toBe( 3 );
		await page.getByRole( 'tab', { name: 'Two', exact: true } ).click();
		expect( await page.locator( 'article:visible' ).innerText() ).toContain( 'blueberry' );
		await page.locator( 'article:visible p' ).evaluate( element => { element.textContent = 'Edited plum answer'; } );
		await page.locator( 'input[aria-label="Browse entries"]' ).fill( 'plum' );
		expect( await page.locator( 'article:visible' ).count() ).toBe( 1 );
		await page.close();
	}, 60_000 );
	it( 'rejects query-dependent, paginated, undeclared, incomplete, and unrestored collection drives', async () => {
		const expected = {
			'query-dependent': /Query-dependent/,
			paginated: /Paginated/,
			undeclared: /Undeclared completeness/,
			coverage: /coverage mismatch/,
			restoration: /Unverified restoration/,
		} as const;
		for ( const variant of [ 'query-dependent', 'paginated', 'undeclared', 'coverage', 'restoration' ] as const ) {
			const page = await browser.newPage();
			await installFinite( page, variant );
			const categories = await captureSelectableSetStates( page, { settleMs: 150 } );
			const states = await captureTypedSearchStates( page, categories, { settleMs: 80 } );
			expect( states[ 0 ]?.status, variant ).not.toBe( 'captured' );
			expect( states[ 0 ]?.collectionFilter?.replay, variant ).toBe( 'unsupported' );
			expect( states[ 0 ]?.collectionFilter?.network.dataRequests, variant ).not.toBe( 'blocked' );
			expect( states[ 0 ]?.collectionFilter?.finiteBootstrap, variant ).toBeUndefined();
			expect( states[ 0 ]?.collectionFilter?.reason ?? states[ 0 ]?.error, variant ).toMatch( expected[ variant ] );
			await page.close();
		}
	}, 120_000 );
});

async function installFinite( page: import('playwright').Page, variant: 'finite' | 'query-dependent' | 'paginated' | 'undeclared' | 'coverage' | 'restoration' ) {
	const rows = [
		{ q: 'Question alpha', a: 'A detailed answer about apricot fruit', c: 0 },
		{ q: 'Question delta', a: 'A detailed answer about recommendations nearby', c: 0 },
		{ q: 'Question beta', a: 'A detailed answer about blueberry fruit', c: 1 },
		{ q: 'Question gamma', a: 'A detailed answer about citrus fruit', c: 2 },
	];
	await page.route( 'https://fixture.invalid/**', async route => {
		const request = JSON.parse( route.request().postData() || '{}' ) as { query?: string; filter?: { category?: number } };
		if ( variant === 'paginated' ) {
			await route.fulfill( { json: { records: rows.slice( 0, 2 ), paging: { hasNext: true, count: 2 } } } );
			return;
		}
		if ( variant === 'undeclared' ) {
			await route.fulfill( { json: { records: rows } } );
			return;
		}
		const local = variant === 'coverage' && request.filter?.category === undefined ? [ ...rows, { q: 'Question epsilon', a: 'A detailed answer about unrendered mango fruit', c: 9 } ] : rows;
		const records = request.filter?.category === undefined ? local : local.filter( row => row.c === request.filter?.category );
		await route.fulfill( { json: { records, paging: { hasNext: false, count: records.length } } } );
	} );
	await page.setContent( `<!doctype html><body><main>
		<form><input type="text" aria-label="Your name"><input type="text" aria-label="Email address"><input type="text" aria-label="Phone number"></form>
		<input type="text" aria-label="Browse entries"><div role="tablist" aria-label="Topics"><button role="tab" aria-selected="true">One</button><button role="tab">Two</button><button role="tab">Three</button></div><section id="results"></section>
		</main><script>
		const variant=${ JSON.stringify( variant ) };
		const local=${ JSON.stringify( rows ) };
		let selected=0, universe=null, fromClick=false;
		const input=document.querySelector('[aria-label="Browse entries"]');
		async function post(body){const response=await fetch('https://fixture.invalid/collection',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('network');return response.json();}
		function paint(list){document.querySelector('#results').innerHTML=list.map(row=>'<article><h2>'+row.q+'</h2><p>'+row.a+'</p></article>').join('')||'<p>No results found.</p>';document.querySelectorAll('[role=tab]').forEach((tab,index)=>tab.setAttribute('aria-selected',String(index===selected)));}
		async function render(){const query=input.value;document.querySelector('[role=tablist]').hidden=Boolean(query);if(query){if(!universe)universe=await post(variant==='query-dependent'?{query,filter:{},paging:{limit:100}}:{filter:{},paging:{limit:100}});const source=(variant==='paginated'||variant==='undeclared')?local:(universe.records||[]);paint(source.filter(row=>(row.q+' '+row.a).toLowerCase().includes(query.toLowerCase())));return;}if(variant==='paginated'||variant==='undeclared'){await post({filter:{category:selected},paging:{limit:50}});paint(local.filter(row=>row.c===selected));return;}const category=await post({filter:{category:selected},paging:{limit:50}});paint(category.records||[]);}
		input.addEventListener('input',()=>{if(variant==='restoration'&&!input.value){document.querySelector('[role=tablist]').hidden=false;paint([{q:'Unrestored heading',a:'This answer was not the source category.',c:0}]);return;}render().catch(()=>{document.querySelector('#results').innerHTML='<p>network</p>';});});
		document.querySelectorAll('[role=tab]').forEach((tab,index)=>tab.onclick=()=>{selected=index;fromClick=true;render().finally(()=>{fromClick=false;});});
		render();
		</script></body>` );
	await page.locator( '#results article' ).first().waitFor();
}
