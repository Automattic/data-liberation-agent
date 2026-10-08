import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { LinkedFrontier } from './linked-frontier.js';
import { createReferenceCollector, readReferenceArtifact } from '../fidelity/reference.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { checkFidelity } from '../fidelity/check.js';

it('names concrete page, depth and time omissions without merging query or slash identities', () => {
	const frontier = new LinkedFrontier({maxPages: 2, maxDepth: 1, timeoutMs: 100}, 0);
	expect(frontier.admit('https://source.test/catalog/?tag=Research#one', 0, 0)).toBe(true);
	expect(frontier.admit('https://source.test/catalog/?tag=Research#two', 0, 0)).toBe(false);
	expect(frontier.admit('https://source.test/catalog?tag=Research', 1, 0)).toBe(true);
	expect(frontier.admit('https://source.test/catalog/?tag=research', 1, 0)).toBe(false);
	expect(frontier.admit('https://source.test/deep', 2, 0)).toBe(false);
	expect(frontier.admit('https://source.test/late', 1, 100)).toBe(false);
	expect(frontier.required.size).toBe(5);
	expect(frontier.diagnostics.map(row => row.reason)).toEqual([
		'maxPages=2 exhausted; 2 addresses scheduled', 'depth=2 exceeds maxDepth=1', 'timeoutMs=100 exhausted',
	]);
});

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('bounded rendered linked frontier', () => {
	it.each([20, 4])('classifies public documents by response instead of path names with maxPages=%s', async maxPages => {
		const requests: string[] = [];
		const docs: Record<string, string> = {
			'/': '<h1>Home</h1><a href="/second/">Second</a>',
			'/second/': '<h1>Second</h1><a href="/administration/">Administration</a><a href="/accounting/">Accounting</a><a href="/apiary/">Apiary</a><a href="/search/">Editorial search</a>',
			'/administration/': '<h1>Editorial administration</h1>',
			'/accounting/': '<h1>Editorial accounting</h1>',
			'/apiary/': '<h1>Editorial apiary</h1>',
			'/search/': '<h1>Editorial search</h1>',
		};
		const source = createServer((request, response) => {
			requests.push(request.url!);
			response.writeHead(docs[request.url!] ? 200 : 404, {'content-type': 'text/html'});
			response.end(`<meta name="viewport" content="width=device-width,initial-scale=1">${docs[request.url!] ?? '<h1>404</h1>'}`);
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port: number}).port}`;
		mkdirSync(join(process.cwd(), '.tmp-test'), {recursive: true});
		const directory = mkdtempSync(join(process.cwd(), '.tmp-test', 'editorial-frontier-'));
		let closed = false;
		try {
			const url = `${origin}/`;
			const collector = createReferenceCollector(directory, url, [url]);
			const capture = await captureScreenshots({urls: [url], primaryUrl: url, outputDir: directory, linkedPages: {maxPages, maxDepth: 3, timeoutMs: 120_000}, concurrency: 3, settleMs: 0, learnFluid: false, observeSource: collector.observe});
			expect(capture.captured).toBe(Math.min(maxPages, 6));
			expect(capture.linkedPageCoverage!.requiredUrls).toHaveLength(6);
			expect(capture.linkedPageCoverage!.diagnostics).toHaveLength(maxPages === 20 ? 0 : 2);
			if (maxPages === 20) expect(requests).toEqual(expect.arrayContaining(Object.keys(docs)));
			else {
				expect(requests).not.toContain('/apiary/'); expect(requests).not.toContain('/search/');
				expect(capture.linkedPageCoverage!.diagnostics.every(row => row.reason.includes('maxPages=4'))).toBe(true);
			}
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: url, platform: 'default', summary: {routesFailed: capture.failed}, failures: []});
			expect(JSON.parse(readFileSync(receiptPath, 'utf8')).summary.complete).toBe(maxPages === 20);
			const frozen = JSON.parse(readFileSync(collector.finalize(receiptPath), 'utf8'));
			expect(frozen.scope.sourceUrls).toHaveLength(6);
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); closed = true;
			const report = await checkFidelity({directory, widths: [390]});
			expect(report.pass, JSON.stringify(report)).toBe(maxPages === 20);
			expect(report.pending).toHaveLength(maxPages === 20 ? 0 : 2);
		} finally {
			if (!closed) {source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));}
			if (!process.env.KEEP_FRONTIER_EVIDENCE) rmSync(directory, {recursive: true, force: true});
		}
	}, 180_000);
	it('retains different slash documents through allocation, exact links and frozen verification', async () => {
		const docs: Record<string, string> = {
			'/': '<h1>Home</h1><a href="/article">Article address</a><a href="/article/">Directory address</a>',
			'/article': '<h1>Article without slash</h1><a href="/article/">Other document</a>',
			'/article/': '<h1>Article with slash</h1><a href="/article">Other document</a>',
		};
		const source = createServer((request, response) => {
			response.writeHead(docs[request.url!] ? 200 : 404, {'content-type': 'text/html'});
			response.end(`<meta name="viewport" content="width=device-width,initial-scale=1">${docs[request.url!] ?? '<h1>404</h1>'}`);
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port: number}).port}`;
		mkdirSync(join(process.cwd(), '.tmp-test'), {recursive: true});
		const directory = mkdtempSync(join(process.cwd(), '.tmp-test', 'slash-frontier-'));
		let closed = false;
		try {
			const url = `${origin}/`;
			const collector = createReferenceCollector(directory, url, [url]);
			const capture = await captureScreenshots({urls: [url], primaryUrl: url, outputDir: directory, linkedPages: {maxPages: 20, maxDepth: 3, timeoutMs: 120_000}, concurrency: 2, settleMs: 0, learnFluid: false, observeSource: collector.observe});
			expect(capture.captured).toBe(3);
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: url, platform: 'default', summary: {routesFailed: capture.failed}, failures: []});
			const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
			const without = receipt.routes.find((route: {url: string}) => route.url === `${origin}/article`);
			const withSlash = receipt.routes.find((route: {url: string}) => route.url === `${origin}/article/`);
			expect(without.path).not.toBe(withSlash.path);
			expect(readFileSync(join(directory, without.path), 'utf8')).toContain('<h1>Article without slash</h1>');
			expect(readFileSync(join(directory, withSlash.path), 'utf8')).toContain('<h1>Article with slash</h1>');
			const home = readFileSync(join(directory, 'website/index.html'), 'utf8');
			expect(home).toContain(`href="/${without.path.slice('website/'.length)}">Article address`);
			expect(home).toContain(`href="/${withSlash.path.slice('website/'.length)}">Directory address`);
			expect(readFileSync(join(directory, without.path), 'utf8')).toContain(`href="/${withSlash.path.slice('website/'.length)}"`);
			expect(readFileSync(join(directory, withSlash.path), 'utf8')).toContain(`href="/${without.path.slice('website/'.length)}"`);
			expect(receipt.duplicateRoutes).toEqual([]);
			collector.finalize(receiptPath);
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); closed = true;
			const report = await checkFidelity({directory});
			expect(report.pending).toEqual([]);
			expect(report.pass, JSON.stringify(report)).toBe(true);
		} finally {
			if (!closed) {source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));}
			if (!process.env.KEEP_FRONTIER_EVIDENCE) rmSync(directory, {recursive: true, force: true});
		}
	}, 180_000);
	it.each([2, 4])('keeps budget omissions and actual source errors in required frozen scope with maxPages=%s', async maxPages => {
		const requests: string[] = [];
		const source = createServer((request, response) => {
			requests.push(request.url!);
			if (request.url === '/absent') {response.writeHead(404, {'content-type': 'text/html'}); response.end('<h1>404</h1>'); return;}
			if (request.url === '/api/data.json') {response.writeHead(200, {'content-type': 'text/plain'}); response.end('not an HTML page'); return;}
			response.setHeader('content-type', 'text/html');
			response.end('<meta name="viewport" content="width=device-width,initial-scale=1">' + (request.url === '/' ? '<h1>Home</h1><a href="/local/">Local</a><a href="/absent">Absent</a><a href="/api/data.json">Non HTML</a>' : '<h1>Local</h1>'));
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(source.address() as {port: number}).port}/`;
		const root = join(process.cwd(), '.tmp-test'); mkdirSync(root, {recursive: true});
		const directory = mkdtempSync(join(root, 'frontier-omissions-'));
		let closed = false;
		try {
			const collector = createReferenceCollector(directory, url, [url]);
			const capture = await captureScreenshots({urls: [url], primaryUrl: url, outputDir: directory, linkedPages: {maxPages, maxDepth: 2, timeoutMs: 120_000}, settleMs: 0, concurrency: 2, observeSource: collector.observe});
			expect(capture.captured).toBe(2);
			expect(capture.linkedPageCoverage?.requiredUrls).toHaveLength(4);
			expect(capture.linkedPageCoverage?.diagnostics).toHaveLength(2);
			if (maxPages === 2) {
				expect(requests).not.toContain('/absent'); expect(requests).not.toContain('/api/data.json');
				expect(capture.linkedPageCoverage!.diagnostics.every(row => row.reason.includes('maxPages=2'))).toBe(true);
			} else {
				expect(requests).toEqual(expect.arrayContaining(['/absent', '/api/data.json']));
				expect(capture.linkedPageCoverage!.diagnostics.map(row => row.reason)).toEqual(expect.arrayContaining([expect.stringContaining('HTTP 404'), expect.stringContaining('Not an HTML document (text/plain)')]));
			}
			const failuresPath = join(directory, 'screenshots/failures.json');
			const failures = existsSync(failuresPath) ? JSON.parse(readFileSync(failuresPath, 'utf8')) : [];
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: url, platform: 'default', summary: {routesFailed: capture.failed}, failures});
			const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
			expect(receipt.summary.complete).toBe(false);
			expect(receipt.routes).toHaveLength(2);
			expect(receipt.linkedPageCoverage.requiredUrls).toHaveLength(4);
			const frozen = JSON.parse(readFileSync(collector.finalize(receiptPath), 'utf8'));
			expect(frozen.scope.sourceUrls).toHaveLength(4);
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); closed = true;
			const report = await checkFidelity({directory, widths: [390]});
			expect(report.pass).toBe(false);
			expect(report.pending).toHaveLength(2);
			expect(report.pending!.map(row => row.route)).toEqual(expect.arrayContaining([`${url}absent`, `${url}api/data.json`]));
		} finally {
			if (!closed) {source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));}
			if (!process.env.KEEP_FRONTIER_EVIDENCE) rmSync(directory, {recursive: true, force: true});
		}
	}, 180_000);
	it('captures second hops, rendered footers and exact renditions, then verifies frozen scope after source shutdown', async () => {
		let externalRequests = 0;
		const external = createServer((_request, response) => {externalRequests++; response.end('outside');});
		await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
		const externalUrl = `http://127.0.0.1:${(external.address() as {port: number}).port}/outside?secret=private`;
		const requests: string[] = [];
		const docs: Record<string, string> = {
			'/': '<h1>Home</h1><a href="/second/">Second</a><script>document.body.insertAdjacentHTML("beforeend",\'<footer><a href="/footer/">Rendered footer</a></footer>\'); if (innerWidth < 500) document.body.insertAdjacentHTML("beforeend",\'<a href="/phone/">Phone destination</a>\')</script>',
			'/second/': '<h1>Second</h1><a href="/third/">Third</a><a href="/catalog/?tag=Research">Research</a><a href="/catalog/?tag=research">Other filter</a><a href="/catalog?tag=Research">Slashless boundary</a><a href="/alias/">Alias</a>',
			'/third/': '<h1>Third</h1><a href="/">Home</a>',
			'/footer/': '<h1>Footer destination</h1>',
			'/phone/': '<h1>Phone-only destination</h1>',
			'/catalog/?tag=Research': '<h1>Uppercase research rendition</h1>',
			'/catalog/?tag=research': '<h1>Lowercase research rendition</h1>',
		};
		const source = createServer((request, response) => {
			requests.push(request.url!);
			if (request.url === '/catalog?tag=Research') {response.writeHead(302, {location: externalUrl}); response.end(); return;}
			if (request.url === '/alias/') {response.writeHead(301, {location: '/third/'}); response.end(); return;}
			response.writeHead(docs[request.url!] ? 200 : 404, {'content-type': 'text/html'});
			response.end(`<meta name="viewport" content="width=device-width,initial-scale=1">${docs[request.url!] ?? '<h1>Absent</h1>'}`);
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port: number}).port}`;
		const root = join(process.cwd(), '.tmp-test'); mkdirSync(root, {recursive: true});
		const directory = mkdtempSync(join(root, 'linked-frontier-'));
		let closed = false;
		try {
			const urls = [`${origin}/`];
			const collector = createReferenceCollector(directory, urls[0]!, urls);
			const captureFn: typeof captureScreenshots = process.env.DLA_BASELINE_SCREENSHOTTER ? (await import(process.env.DLA_BASELINE_SCREENSHOTTER)).captureScreenshots : captureScreenshots;
			const capture = await captureFn({urls, primaryUrl: urls[0], outputDir: directory, linkedPages: {maxPages: 12, maxDepth: 3, timeoutMs: 180_000}, concurrency: 2, settleMs: 0, learnFluid: false, observeSource: collector.observe});
			expect(capture.failed).toBe(0);
			expect(capture.captured).toBe(7);
			expect(capture.skipped).toBe(2);
			expect(capture.linkedPageCoverage?.requiredUrls).toHaveLength(9);
			expect(capture.linkedPageCoverage?.diagnostics).toEqual([]);
			expect(requests).toEqual(expect.arrayContaining(['/second/', '/third/', '/footer/', '/phone/', '/catalog/?tag=Research', '/catalog/?tag=research', '/catalog?tag=Research']));
			expect(externalRequests).toBe(0);
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: urls[0]!, platform: 'default', summary: {routesFailed: capture.failed}, failures: [], discoveryDiagnostics: capture.linkedPageCoverage?.diagnostics});
			expect(JSON.parse(readFileSync(receiptPath, 'utf8')).summary.complete).toBe(true);
			collector.requireUrls(capture.linkedPageCoverage!.requiredUrls);
			const frozen = JSON.parse(readFileSync(collector.finalize(receiptPath), 'utf8'));
			expect(frozen.scope.sourceUrls).toHaveLength(9);
			for (const url of capture.linkedPageCoverage!.requiredUrls.filter(url => !url.endsWith('/alias/'))) {
				const cells = frozen.entries.filter((entry: {sourceUrl: string}) => entry.sourceUrl === url);
				expect(cells).toHaveLength(3);
				for (const entry of cells) {
					expect(entry.readiness.ready).toBe(true);
					if (entry.document) readReferenceArtifact(directory, entry.document);
					else expect(entry.outcome).toBeTruthy();
				}
			}
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); closed = true;
			const report = await checkFidelity({directory});
			expect(report.pending).toEqual([]);
			expect(report.pass, JSON.stringify(report)).toBe(true);
			// A newly linked document remains required after capture: corrupting its
			// frozen evidence must invalidate acceptance even with the origin gone.
			const linkedCell = frozen.entries.find((entry: {sourceUrl: string; viewport: number}) => entry.sourceUrl === `${origin}/third/` && entry.viewport === 390);
			writeFileSync(join(directory, linkedCell.document.path), '<h1>Corrupted evidence</h1>');
			const corrupted = await checkFidelity({directory, widths: [390]});
			expect(corrupted.pass).toBe(false);
			expect(corrupted.pending).toEqual(expect.arrayContaining([
				expect.objectContaining({route: '/third/', reason: expect.stringContaining('Reference digest mismatch')}),
			]));
		} finally {
			if (!closed) {source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));}
			external.closeAllConnections(); await new Promise<void>(resolve => external.close(() => resolve()));
			if (!process.env.KEEP_FRONTIER_EVIDENCE) rmSync(directory, {recursive: true, force: true});
		}
	}, 240_000);
});
