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
import { documentRequestUrl } from '../url/route-key.js';

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

it('records the exact omitted addresses at a four-page frontier budget', () => {
	const frontier = new LinkedFrontier({maxPages: 4, maxDepth: 3, timeoutMs: 100}, 0);
	for (const [index, path] of ['/', '/second/', '/administration/', '/accounting/', '/apiary/', '/search/'].entries()) {
		frontier.admit(`https://source.test${path}`, index ? 1 : 0, 0);
	}
	expect(frontier.coverage()).toMatchObject({
		limits: {maxPages: 4},
		scheduled: 4,
		requiredUrls: ['https://source.test/', 'https://source.test/second/', 'https://source.test/administration/', 'https://source.test/accounting/', 'https://source.test/apiary/', 'https://source.test/search/'],
		diagnostics: [
			{url: 'https://source.test/apiary/', reason: 'maxPages=4 exhausted; 4 addresses scheduled'},
			{url: 'https://source.test/search/', reason: 'maxPages=4 exhausted; 4 addresses scheduled'},
		],
	});
});

it('continues owned inventory and observed aliases while retaining expansion and capture caps', () => {
	const frontier = new LinkedFrontier({maxPages: 1, maxDepth: 0, timeoutMs: 100, capturePageLimit: 4}, 0);
	expect(frontier.admit('https://source.test/', 0, 200, 'inventory')).toBe(true);
	expect(frontier.admit('https://source.test/known', 0, 200, 'inventory')).toBe(true);
	expect(frontier.admit('https://source.test/target', 1, 200)).toBe(false);
	expect(frontier.admit('https://source.test/target', 0, 200, 'alias')).toBe(true);
	expect(frontier.diagnostics).toEqual([]);
	expect(frontier.admit('https://source.test/target#duplicate', 0, 200, 'alias')).toBe(false);
	expect(frontier.admit('https://source.test/another', 0, 200, 'alias')).toBe(true);
	expect(frontier.admit('https://source.test/over-cap', 0, 200, 'alias')).toBe(false);
	expect(frontier.admit('https://source.test/over-cap', 0, 200, 'alias')).toBe(false);
	expect(frontier.coverage()).toMatchObject({scheduled: 4, diagnostics: [{url: 'https://source.test/over-cap', reason: 'capture limit=4 exhausted; 4 addresses scheduled'}]});
});

it('keeps adapter namespace admission ahead of every discovery-budget ownership kind', () => {
	const frontier = new LinkedFrontier({maxPages: 1, timeoutMs: 1}, 0, {origin: 'https://source.test', pathPrefixes: ['/customer']});
	for (const ownership of ['inventory', 'alias', 'linked'] as const) {
		for (const url of ['https://source.test/', 'https://source.test/customer-other', 'https://other.test/customer']) {
			expect(frontier.admit(url, 0, 10, ownership)).toBe(false);
		}
	}
	expect(frontier.coverage()).toMatchObject({requiredUrls: [], scheduled: 0, diagnostics: []});
	expect(frontier.admit('https://source.test/customer', 0, 10, 'inventory')).toBe(true);
	expect(frontier.admit('https://source.test/customer/proved', 0, 10, 'alias')).toBe(true);
	expect(frontier.admit('https://source.test/customer/unknown', 1, 10)).toBe(false);
	expect(frontier.coverage()).toMatchObject({scheduled: 2, diagnostics: [{url: 'https://source.test/customer/unknown', reason: 'timeoutMs=1 exhausted'}]});
});

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('bounded rendered linked frontier', () => {
	it.each(['inventory', 'deadline', 'wave', 'cap'] as const)('completes admitted %s work after discovery expires with real navigation and browser restarts', async mode => {
		const requests: string[] = [];
		const docs: Record<string, string> = {
			'/': mode === 'wave' ? '<h1>Home</h1><a href="/slow">Slow</a><a href="/alias">Alias</a>' : '<h1>Home</h1><a href="/inventory">Inventory</a>',
			'/inventory': '<h1>Inventory</h1>',
			'/slow': '<h1>Slow</h1><a href="/late">Late unknown</a>',
			'/target': '<h1>Target</h1><a href="/late">Late unknown</a>',
		};
		const timeoutMs = mode === 'wave' ? 20_000 : 1_000;
		const source = createServer((request, response) => {
			requests.push(request.url!);
			if (request.url === '/alias') {response.writeHead(302, {location: '/target'}); response.end(); return;}
			const send = () => {response.writeHead(docs[request.url!] ? 200 : 404, {'content-type': 'text/html'}); response.end(`<meta name="viewport" content="width=device-width,initial-scale=1">${docs[request.url!] ?? '<h1>Absent</h1>'}`);};
			// Real HTTP time, not a mocked clock: expire discovery during an admitted
			// document's navigation, leaving further inventory/wave work queued.
			if (mode !== 'wave' && request.url === '/') setTimeout(send, timeoutMs + 100);
			else send();
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port: number}).port}`;
		mkdirSync(join(process.cwd(), '.tmp-test'), {recursive: true});
		const directory = mkdtempSync(join(process.cwd(), '.tmp-test', `deadline-${mode}-`));
		try {
			const urls = (mode === 'wave' ? ['/'] : ['/', '/inventory', '/alias', '/inventory#duplicate']).map(path => origin + path);
			const collector = createReferenceCollector(directory, urls[0]!, [...new Set(urls.map(documentRequestUrl))]);
			const progress: string[] = [];
			const captureFn: typeof captureScreenshots = process.env.DLA_BASELINE_SCREENSHOTTER ? (await import(process.env.DLA_BASELINE_SCREENSHOTTER)).captureScreenshots : captureScreenshots;
			const capture = await captureFn({urls, primaryUrl: urls[0], outputDir: directory,
				// Known inventory exceeds expansion's maxPages in the inventory case.
				linkedPages: {maxPages: mode === 'wave' || mode === 'deadline' ? 8 : 1, maxDepth: 2, timeoutMs},
				...(mode === 'cap' ? {limit: 3} : {}),
				concurrency: 1, browserRestartEvery: 1, settleMs: 0, learnFluid: false,
				viewports: [{id: 'desktop', width: 390, height: 844, referenceWidths: [390]}],
				// Let the first linked capture outlive admission's window without
				// exhausting the independent per-navigation response deadline.
				prepareCapture: async page => {if (mode === 'wave' && new URL(page.url()).pathname === '/slow') await page.waitForTimeout(timeoutMs + 100);},
				observeSource: collector.observe, onProgress: (_current, _total, url) => progress.push(url)});
			const expected = (mode === 'wave' ? ['/', '/slow', '/target'] : mode === 'cap' ? ['/', '/inventory'] : ['/', '/inventory', '/target']).map(path => origin + path);
			console.info(JSON.stringify({mode, directory, captured: capture.captured, skipped: capture.skipped, failed: capture.failed, restarts: capture.browserRestarts, progress, coverage: capture.linkedPageCoverage}));
			expect(capture.failed).toBe(0);
			expect(capture.captured).toBe(expected.length);
			expect(capture.skipped).toBe(1); // Observed alias, never a timeout skip.
			expect(capture.browserRestarts).toBe(expected.length);
			expect(new Set(progress).size).toBe(progress.length);
			expect(progress).toEqual(expect.arrayContaining([...expected, `${origin}/alias`]));
			expect(capture.linkedPageCoverage!.scheduled).toBe(expected.length + 1);
			expect(capture.linkedPageCoverage!.requiredUrls).toHaveLength(expected.length + 2);
			expect(requests).not.toContain('/late');
			expect(capture.linkedPageCoverage!.diagnostics).toEqual([expect.objectContaining({url: `${origin}/${mode === 'cap' ? 'target' : 'late'}`, reason: expect.stringContaining(mode === 'cap' ? 'capture limit=3' : `timeoutMs=${timeoutMs}`)})]);
			const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: urls[0]!, platform: 'default', summary: {routesFailed: capture.failed}, failures: []});
			const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
			expect(receipt.summary.complete).toBe(false);
			expect(receipt.routes.map((route: {url: string}) => route.url).sort()).toEqual(expected.sort());
			expect(receipt.duplicateRoutes).toEqual(mode === 'cap' ? [] : [{url: `${origin}/alias`, canonicalUrl: `${origin}/target`, path: receipt.routes.find((route: {url: string}) => route.url === `${origin}/target`).path}]);
			for (const route of receipt.routes) expect(readFileSync(join(directory, route.path), 'utf8')).toContain('<h1>');
			collector.requireUrls(capture.linkedPageCoverage!.requiredUrls);
			const frozen = JSON.parse(readFileSync(collector.finalize(receiptPath), 'utf8'));
			expect(frozen.scope.sourceUrls.sort()).toEqual([...capture.linkedPageCoverage!.requiredUrls].sort());
			for (const url of expected) {
				const cells = frozen.entries.filter((entry: {sourceUrl: string}) => entry.sourceUrl === url);
				expect(cells).toHaveLength(1);
				expect(cells[0].readiness.ready).toBe(true);
				readReferenceArtifact(directory, cells[0].document);
			}
		} finally {
			source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));
			if (!process.env.KEEP_FRONTIER_EVIDENCE) rmSync(directory, {recursive: true, force: true});
		}
	}, 120_000);
	it('classifies public documents by response instead of path names at the full frontier budget', async () => {
		const maxPages = 20;
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
			expect(capture.linkedPageCoverage!.diagnostics).toHaveLength(0);
			expect(requests).toEqual(expect.arrayContaining(Object.keys(docs)));
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
	it('keeps actual source errors in required frozen scope after the frontier budget admits them', async () => {
		const maxPages = 4;
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
			expect(requests).toEqual(expect.arrayContaining(['/absent', '/api/data.json']));
			expect(capture.linkedPageCoverage!.diagnostics.map(row => row.reason)).toEqual(expect.arrayContaining([expect.stringContaining('HTTP 404'), expect.stringContaining('Not an HTML document (text/plain)')]));
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
