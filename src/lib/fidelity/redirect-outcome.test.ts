import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector, type FidelityReference } from './reference.js';
import { checkFidelity } from './check.js';

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('frozen external route outcomes', () => {
	it('captures a declared external boundary before cleanup and verifies it after the source shuts down', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
		const directory = mkdtempSync(join(parent, 'redirect-outcome-'));
		let outbound = 0;
		const destination = createServer((_request, response) => { outbound++; response.end('Foreign document must not be captured'); });
		await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
		const target = `http://127.0.0.1:${(destination.address() as {port:number}).port}/private?token=secret#section`;
		const source = createServer((request, response) => {
			response.setHeader('content-type', 'text/html');
			if (request.url === '/outbound?link=authored') response.end(`<meta http-equiv="refresh" content="0;URL=${target}"><a href="${target}">Forward</a>`);
			else response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local editorial document</h1><a href="/outbound?link=authored#meaning">Strategic directions</a>');
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port:number}).port}`;
		const urls = [`${origin}/`, `${origin}/outbound?link=authored`];
		let stopped = false;
		try {
			const collector = createReferenceCollector(directory, urls[0]!, urls);
			const capture = await captureScreenshots({urls, primaryUrl: urls[0], outputDir: directory, concurrency: 1, settleMs: 0, learnFluid: false, observeSource: collector.observe});
			expect(capture.failed).toBe(0);
			expect(outbound).toBe(0);
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: urls[0]!, platform: 'default', summary: {routesDiscovered: 2, routesCaptured: capture.captured, routesSkipped: capture.skipped, routesFailed: capture.failed}, failures: []});
			const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
			expect(receipt.summary.complete).toBe(true);
			expect(receipt.routes).toHaveLength(1);
			expect(readFileSync(join(directory, 'website/index.html'), 'utf8')).toContain(`${urls[1]}#meaning`);
			expect(readFileSync(receiptPath, 'utf8')).not.toContain('token=secret');
			const manifestPath = collector.finalize(receiptPath);
			const manifestBytes = readFileSync(manifestPath, 'utf8');
			const manifest = JSON.parse(manifestBytes) as FidelityReference;
			expect(manifest.scope.sourceUrls).toContain(urls[1]);
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); stopped = true;
			for (const stage of ['capture', 'materialization'] as const) {
				// Materialization has its own local server; no live source is needed.
				const {startStaticServer} = await import('../replicate/local-site/static-server.js');
				const candidate = await startStaticServer(join(directory, 'website'));
				try {
					const report = await checkFidelity({directory, stage, ...(stage === 'materialization' ? {candidateUrl: candidate.url} : {})});
					expect(report.pending, JSON.stringify(report)).toEqual([]);
					expect(report.pass, JSON.stringify(report)).toBe(true);
					expect(report.coverage?.required).toBe(6);
					expect(report.scores).toHaveLength(3);
					expect(report.outcomes).toHaveLength(3);
					expect(report.coverage?.observedOutcomes).toBe(3);
				} finally { await candidate.close(); }
			}
			expect(outbound).toBe(0);
			const incomplete = JSON.parse(manifestBytes) as FidelityReference;
			incomplete.entries = incomplete.entries.filter(entry => entry.sourceUrl !== urls[1]);
			writeFileSync(manifestPath, JSON.stringify(incomplete));
			expect((await checkFidelity({directory})).pass).toBe(false);
			for (const mutate of [
				(value: FidelityReference) => { value.entries.push(structuredClone(value.entries.find(entry => entry.outcome && entry.viewport === 390)!)); },
				(value: FidelityReference) => { value.entries.find(entry => entry.outcome && entry.viewport === 390)!.outcome!.target.sha256 = 'forged'; },
				(value: FidelityReference) => { value.scope.sourceUrls.push(`${origin}/genuinely-uncaptured`); },
			]) {
				const value = JSON.parse(manifestBytes) as FidelityReference; mutate(value); writeFileSync(manifestPath, JSON.stringify(value));
				expect((await checkFidelity({directory, widths:[390]})).status).toBe('unproven');
			}
			writeFileSync(manifestPath, manifestBytes);
			const evidence = join(directory, manifest.entries.find(entry => entry.outcome && entry.viewport === 390)!.outcome!.evidence.path);
			const evidenceBytes = readFileSync(evidence); writeFileSync(evidence, '{}');
			expect((await checkFidelity({directory, widths:[390]})).status).toBe('unproven');
			writeFileSync(evidence, evidenceBytes);
			const altered = createServer((_request, response) => { response.setHeader('content-type','text/html'); response.end(readFileSync(join(directory,'website/index.html'),'utf8').replace(`${urls[1]}#meaning`, '/wrong-local-route')); });
			await new Promise<void>(resolve => altered.listen(0, '127.0.0.1', resolve));
			try {
				const report = await checkFidelity({directory, widths:[390], candidateUrl:`http://127.0.0.1:${(altered.address() as {port:number}).port}`});
				expect(report.pass).toBe(false);
				expect(report.scores[0]!.failures).toContain('Authored external-boundary source link meaning was lost');
			} finally { altered.closeAllConnections(); await new Promise<void>(resolve => altered.close(() => resolve())); }
		} finally {
			if (!stopped) { source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); }
			destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve()));
			rmSync(directory, {recursive:true, force:true});
		}
	}, 180_000);

	it('keeps device-disagreeing boundaries and unexplained script drift as route failures', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, {recursive:true});
		const directory = mkdtempSync(join(parent, 'disagreeing-outcomes-'));
		const source = createServer((request, response) => {
			response.setHeader('content-type','text/html');
			if (request.url === '/different') response.end('<h1>Other local page</h1>');
			else if (request.url === '/script') response.end('<script>location.href="/different"</script>');
			else if (request.url === '/late-script') response.end('<script>setTimeout(()=>location.href="https://foreign.fixture.invalid/",100)</script><h1>Original page</h1>');
			else response.end(`<meta http-equiv="refresh" content="0;URL=https://${/iPhone/.test(request.headers['user-agent'] ?? '') ? 'mobile' : 'desktop'}.fixture.invalid/">`);
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port:number}).port}`;
		try {
			const captured = await captureScreenshots({urls:[`${origin}/disagree`,`${origin}/script`,`${origin}/late-script`], primaryUrl:origin, outputDir:directory, concurrency:1, settleMs:0});
			expect(captured.failed).toBeGreaterThan(0);
			const manifest = JSON.parse(readFileSync(join(directory,'screenshots/manifest.json'),'utf8'));
			expect(manifest.entries[`${origin}/disagree`].externalRedirect).not.toBe(true);
			expect(manifest.entries[`${origin}/script`].redirectedTo).toBeUndefined();
			expect(manifest.entries[`${origin}/script`].html).toBeUndefined();
			expect(readFileSync(join(directory,'screenshots/failures.json'),'utf8')).toMatch(/disagree/);
			const failures = JSON.parse(readFileSync(join(directory,'screenshots/failures.json'),'utf8'));
			expect(failures.some((failure:{url:string; error:string}) => failure.url === `${origin}/late-script` && /route drift/.test(failure.error))).toBe(true);
		} finally { source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); rmSync(directory,{recursive:true,force:true}); }
	}, 120_000);

	it('queues HTTP and declarative same-origin aliases once and preserves explicit target query/fragment semantics', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, {recursive:true});
		const directory = mkdtempSync(join(parent, 'local-redirect-aliases-'));
		const source = createServer((request, response) => {
			response.setHeader('content-type','text/html');
			if (request.url === '/legacy?edition=retained') { response.writeHead(302, {location:'/article?view=full#section'}); response.end(); }
			else if (request.url === '/variant') { response.writeHead(302, {location:'/article?view=short#section'}); response.end(); }
			else if (request.url === '/meta') response.end('<meta http-equiv="refresh" content="1;URL=/article?view=full#section">');
			else if (request.url === '/article?view=full') response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="section">Full article</h1>');
			else if (request.url === '/article?view=short') response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="section">Short article</h1>');
			else response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local home</h1><a href="/legacy?edition=retained#old">Legacy article</a><a href="/meta">Declarative alias</a><a href="/variant">Short article</a>');
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port:number}).port}`;
		const urls = [`${origin}/`,`${origin}/legacy?edition=retained`,`${origin}/meta`,`${origin}/variant`];
		try {
			const collector = createReferenceCollector(directory,urls[0]!,urls);
			const capture = await captureScreenshots({urls, primaryUrl:urls[0], outputDir:directory, concurrency:1, settleMs:0, observeSource:collector.observe});
			expect(capture.failed).toBe(0);
			expect(capture.urls.filter(url => url === `${origin}/article?view=full#section`)).toHaveLength(1);
			expect(capture.urls.filter(url => url === `${origin}/article?view=short#section`)).toHaveLength(1);
			const receiptPath = exportWebsiteCapture({outputDir:directory, sourceUrl:urls[0]!, platform:'default', summary:{routesFailed:0}, failures:[]});
			const receipt = JSON.parse(readFileSync(receiptPath,'utf8'));
			expect(receipt.routes).toHaveLength(3); expect(receipt.duplicateRoutes).toHaveLength(3);
			const targetPath = receipt.routes.find((route:{url:string}) => route.url.includes('/article?view=full')).path.replace(/^website/, '');
			const html = readFileSync(join(directory,'website/index.html'),'utf8');
			expect(html.match(new RegExp(`href="${targetPath}#section"`, 'g'))).toHaveLength(2);
			expect(html).not.toContain('#old');
			collector.finalize(receiptPath);
			expect((await checkFidelity({directory,widths:[390]})).pending).toEqual([]);
		} finally { source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); rmSync(directory,{recursive:true,force:true}); }
	}, 120_000);
});
