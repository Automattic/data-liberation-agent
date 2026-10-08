import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector } from '../fidelity/reference.js';
import { checkFidelity } from '../fidelity/check.js';
import { sameOriginPageAnchors } from './unscheduled-anchors.js';

it('retains resolved request addresses while excluding document fragments from acquisition', () => {
	expect(sameOriginPageAnchors('<a href="../catalog/?tags=Research#items">Filter</a><a href="../catalog?tags=Research#other">Other resource</a><a href="../catalog/?tags=research">Different query</a>', 'https://www.source.test/section/page/')).toEqual([
		'https://www.source.test/section/catalog/?tags=Research', 'https://www.source.test/section/catalog?tags=Research', 'https://www.source.test/section/catalog/?tags=research',
	]);
	// #563 resolves against the rendered URL/base before this selector. An
	// already resolved reference must retain its scheme, directory and query.
	expect(sameOriginPageAnchors('<a href="http://source.test/rendered-base/catalog/?tags=Research#items">Filter</a>', 'http://source.test/rendered/page/')).toEqual(['http://source.test/rendered-base/catalog/?tags=Research']);
});

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('authored network request identity', () => {
	it.each([false, true])('keeps slash-bearing HTML distinct from a slashless external redirect with catalog scheduled=%s', async scheduledCatalog => {
		let foreignRequests = 0;
		const foreign = createServer((_request,response) => { foreignRequests++; response.end('Outside source scope'); });
		await new Promise<void>(resolve => foreign.listen(0,'127.0.0.1',resolve));
		const target = `http://127.0.0.1:${(foreign.address() as {port:number}).port}/landing?token=private`;
		const requests: string[] = [];
		const source = createServer((request,response) => {
			requests.push(request.url!); response.setHeader('content-type','text/html');
			if (request.url === '/catalog?tags=Research' || request.url === '/external/') { response.writeHead(301,{location:target}); response.end(); }
			else if (request.url === '/catalog/?tags=Research') response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Research collection</h1>');
			else if (request.url === '/alias/') { response.writeHead(302,{location:'/retained/'}); response.end(); }
			else if (request.url === '/retained/') response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Retained local page</h1>');
			else response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Home</h1><a href="catalog/?tags=Research#items">Research</a><a href="catalog?tags=Research#other">Slashless resource</a><a href="external/#join">External</a><a href="alias/">Known alias</a>');
		});
		await new Promise<void>(resolve => source.listen(0,'127.0.0.1',resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port:number}).port}`;
		const parent = join(process.cwd(),'.tmp-test'); mkdirSync(parent,{recursive:true});
		const directory = mkdtempSync(join(parent,'exact-request-'));
		const urls = [`${origin}/`,`${origin}/retained/`,`${origin}/alias/`,...(scheduledCatalog ? [`${origin}/catalog/?tags=Research`] : [])];
		try {
			const collector = createReferenceCollector(directory,urls[0]!,urls);
			const capture = await captureScreenshots({urls,primaryUrl:urls[0],outputDir:directory,concurrency:1,settleMs:0,learnFluid:false,observeSource:collector.observe});
			expect(capture.failed).toBe(0);
			expect(requests).toContain('/catalog/?tags=Research');
			expect(requests).toContain('/catalog?tags=Research');
			expect(requests).toContain('/external/');
			expect(foreignRequests).toBe(0);
			const entries = JSON.parse(readFileSync(join(directory,'screenshots/manifest.json'),'utf8')).entries;
			expect(entries[`${origin}/catalog/?tags=Research`]?.externalRedirect).not.toBe(true);
			expect(entries[`${origin}/catalog?tags=Research`].externalRedirect).toBe(true);
			expect(entries[`${origin}/external/`].externalRedirect).toBe(true);
			const receiptPath = exportWebsiteCapture({outputDir:directory,sourceUrl:urls[0]!,platform:'default',summary:{routesFailed:capture.failed},failures:[]});
			const receipt = JSON.parse(readFileSync(receiptPath,'utf8'));
			expect(receipt.summary.complete).toBe(scheduledCatalog);
			const diagnostics = JSON.parse(readFileSync(join(directory,'diagnostics.json'),'utf8'));
			expect(diagnostics.unresolvedAnchors).toEqual(scheduledCatalog ? [] : [{sourceUrl:`${origin}/`,url:`${origin}/catalog/?tags=Research`,reason:'target route was not captured'}]);
			const html = readFileSync(join(directory,'website/index.html'),'utf8');
			expect(html).toContain(`${origin}/catalog?tags=Research#other`);
			expect(html).toContain(`${origin}/external/#join`);
			expect(html).toContain('/retained/index.html');
			expect(readFileSync(receiptPath,'utf8')).not.toContain('token=private');
			const frozen = JSON.parse(readFileSync(collector.finalize(receiptPath),'utf8'));
			// Classification-only unscheduled probes still are not frozen observations.
			expect(frozen.entries.some((entry:{outcome?:unknown}) => entry.outcome)).toBe(false);
			if (scheduledCatalog) expect((await checkFidelity({directory,widths:[390]})).pending).toEqual([]);
		} finally { source.closeAllConnections(); foreign.closeAllConnections(); await Promise.all([new Promise<void>(resolve=>source.close(()=>resolve())),new Promise<void>(resolve=>foreign.close(()=>resolve()))]); rmSync(directory,{recursive:true,force:true}); }
	},180_000);
});
