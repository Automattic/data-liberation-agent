import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { documentRedirect, isNavigationTimeout, navigateSourceDocument, inspectSourceDocument, SOURCE_NAVIGATION_LIMITS, SourceNavigationError, storeExternalBoundary, validateExternalBoundary } from './source-navigation.js';
import { join } from 'node:path';
import { SOURCE_DOCUMENT_MAX_BYTES } from './source-document-policy.js';
import { isRouteDrift, navigationDocumentUrl } from './screenshot/document-integrity.js';

describe('source response declarations', () => {
	it('uses the canonical same-site protocol/www boundary without admitting other hosts or ports', async () => {
		const requested = 'http://www.source.test/article';
		const landed = 'https://source.test/article/';
		const requests: string[] = [];
		const inspected = await inspectSourceDocument(requested, async (url): Promise<{url:string;status:number;headers:Record<string,string>;body:string}> => {
			requests.push(url);
			return url === requested ? {url,status:301,headers:{location:landed},body:''} : {url,status:200,headers:{'content-type':'text/html'},body:'<h1>Same site</h1>'};
		});
		expect(requests).toEqual([requested,landed]); expect(inspected.boundary).toBeUndefined();
		expect(navigationDocumentUrl(requested, inspected.finalUrl!, true)).toBe(landed);
		for (const target of ['https://other.test/article/', 'https://source.test:8443/article/']) {
			let calls = 0;
			const external = await inspectSourceDocument(requested, async url => { calls++; return {url,status:302,headers:{location:target},body:''}; });
			expect(external.boundary?.declaration.target).toBe(target); expect(calls).toBe(1);
		}
	});
	it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@foreign.test/'])('rejects unsafe destination %s before acquisition', async target => {
		let requests = 0;
		await expect(inspectSourceDocument('https://source.test/', async url => { requests++; return {url, status: 302, headers: {location: target}, body: ''}; })).rejects.toThrow(/unsafe/);
		expect(requests).toBe(1);
	});
	it.each([
		['<meta http-equiv="refresh" content="0;url=/next"><meta http-equiv="refresh" content="0;url=/other">', 'ambiguous'],
		['<meta http-equiv="refresh" content="99;url=/next">', 'delay budget'],
		['<meta http-equiv="refresh" content="tomorrow">', 'unsupported'],
	])('refuses unsupported declarations: %s', (body, reason) => {
		expect(() => documentRedirect({url:'https://source.test/', status:200, headers:{'content-type':'text/html'}, body})).toThrow(reason);
	});
	it('preserves authored base/query/fragment meaning for a relative declaration', () => {
		expect(documentRedirect({url:'https://source.test/dir/page', status:200, headers:{'content-type':'text/html'}, body:`<base href="/effective/"><meta HTTP-EQUIV="Refresh" content=".5; URL='next?variant=a&amp;x=b#section'">`})).toEqual({mechanism:'meta-refresh', delayMs:500, target:'https://source.test/effective/next?variant=a&x=b#section'});
	});
	it('bounds response size and acquisition time and ignores inactive template declarations', async () => {
		expect(documentRedirect({url:'https://source.test/', status:200, headers:{'content-type':'text/html'}, body:'<template><meta http-equiv="refresh" content="0;url=https://foreign.test/"></template>'})).toBeUndefined();
		await expect(inspectSourceDocument('https://source.test/', async url => ({url,status:200,headers:{'content-type':'text/html'},body:'x'.repeat(SOURCE_DOCUMENT_MAX_BYTES + 1)}))).rejects.toThrow(/byte budget/);
		await expect(inspectSourceDocument('https://source.test/', async url => { await new Promise(resolve => setTimeout(resolve, 30)); return {url,status:200,headers:{'content-type':'text/html'},body:'<h1>Late</h1>'}; }, false, 5)).rejects.toThrow(/time budget/);
	});
	it('inspects complete admitted documents for late active declarations while ignoring lookalikes', async () => {
		const body = `<body><script>${'x'.repeat(2 * 1024 * 1024)}; '<meta http-equiv="refresh" content="0;url=https://foreign.test/">'</script><template><meta http-equiv="refresh" content="0;url=https://foreign.test/"></template>`;
		const requested = 'https://source.test/';
		const acquire = (html: string) => async (url: string) => ({url,status:200,headers:{'content-type':'text/html'},body:html});
		expect((await inspectSourceDocument(requested, acquire(body))).boundary).toBeUndefined();
		await expect(inspectSourceDocument(requested, acquire(`${body}<meta http-equiv="refresh" content="0;url=http://127.0.0.1/private">`), true)).rejects.toThrow(/internal\/loopback/);
		const requests: string[] = [];
		const same = await inspectSourceDocument(requested, async url => {
			requests.push(url);
			return {url,status:200,headers:{'content-type':'text/html'},body:url === requested ? `${body}<meta http-equiv="refresh" content="0;url=/next">` : body};
		});
		expect(requests).toEqual([requested, 'https://source.test/next']);
		expect(same.finalUrl).toBe('https://source.test/next');
	});
});

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('bounded main-document navigation', () => {
	it('admits full large decoded HTML and revalidates late external declarations without fetching them', async () => {
		const padding = 'x'.repeat(2 * 1024 * 1024 + 128);
		const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"%3E%3Crect width="8" height="8" fill="red"/%3E%3C/svg%3E';
		const html = `<!doctype html><title>Large neutral document</title><body><script type="application/json">"${padding}"</script><h1 id="tail">Complete terminal text</h1><img src='${image}'></body>`;
		let outbound = 0;
		const foreign = createServer((_request, response) => { outbound++; response.end('foreign'); });
		await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
		const target = `http://127.0.0.1:${(foreign.address() as {port:number}).port}/external`;
		let reloads = 0;
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'text/html');
			response.setHeader('content-encoding', 'gzip');
			if (request.url === '/declared-oversize') { response.removeHeader('content-encoding'); response.setHeader('content-length', SOURCE_DOCUMENT_MAX_BYTES + 1); response.end('x'.repeat(SOURCE_DOCUMENT_MAX_BYTES + 1)); return; }
			const body = request.url === '/boundary' ? `${html}<meta http-equiv="refresh" content="0;url=${target}">`
				: request.url === '/decoded-oversize' ? 'x'.repeat(SOURCE_DOCUMENT_MAX_BYTES + 1)
				: request.url === '/reload' && reloads++ === 0 ? `${html}<meta http-equiv="refresh" content="0">` : html;
			response.end(gzipSync(body));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
		const browser = await chromium.launch();
		const directory = mkdtempSync(join(process.cwd(), '.navigation-evidence-'));
		try {
			const page = await browser.newPage();
			const result = await navigateSourceDocument(page, `${origin}/large`);
			expect(result.boundary).toBeUndefined();
			expect(result.navigationUrl).toBe(`${origin}/large`);
			expect(await page.evaluate(() => ({url: document.URL, text: document.querySelector('h1')?.textContent, image: document.querySelector('img')?.naturalWidth, padding: document.querySelector('script')?.textContent?.length}))).toEqual({url:`${origin}/large`, text:'Complete terminal text', image:8, padding:padding.length + 2});
			expect(await page.content()).toContain(padding);
			await navigateSourceDocument(page, `${origin}/reload`);
			expect(reloads).toBe(2);
			expect(await page.locator('#tail').textContent()).toBe('Complete terminal text');
			for (const path of ['declared-oversize', 'decoded-oversize']) await expect(navigateSourceDocument(page, `${origin}/${path}`)).rejects.toThrow(/document byte budget/);
			const boundary = (await navigateSourceDocument(page, `${origin}/boundary`)).boundary!;
			expect(boundary.declaration.target).toBe(target);
			const outcome = storeExternalBoundary(directory, boundary, 1440, {isMobile:false, hasTouch:false});
			expect(() => validateExternalBoundary(outcome, readFileSync(join(directory, outcome.evidence.path)))).not.toThrow();
			expect(() => validateExternalBoundary(outcome, Buffer.from(JSON.stringify({...boundary, responses: [{...boundary.responses[0], body:'x'.repeat(SOURCE_DOCUMENT_MAX_BYTES + 1)}]})))).toThrow(/Invalid source redirect response chain/);
			expect(outbound).toBe(0);
			const { captureScreenshots } = await import('./screenshot/screenshotter.js');
			const captureDirectory = join(directory, 'capture');
			const capture = await captureScreenshots({urls:[`${origin}/large`], primaryUrl:`${origin}/large`, outputDir:captureDirectory, concurrency:1, learnFluid:false, settleMs:0});
			expect(capture.failed).toBe(0); expect(capture.captured).toBe(1);
			const entry = JSON.parse(readFileSync(join(captureDirectory, 'screenshots/manifest.json'), 'utf8')).entries[`${origin}/large`];
			for (const [profile, path] of [['desktop', entry.html], ['mobile', entry.mobileHtml]]) {
				const capturedHtml = readFileSync(join(captureDirectory, path), 'utf8');
				expect(capturedHtml).toContain('Complete terminal text');
				expect(capturedHtml).toContain('data:image/svg+xml');
				expect(entry.documents[profile].url).toBe(`${origin}/large`);
			}
		} finally {
			await browser.close(); rmSync(directory, {recursive:true, force:true});
			server.closeAllConnections(); foreign.closeAllConnections();
			await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))]);
		}
	}, 60_000);
	it('uses real HTTP/meta/Refresh evidence without fetching foreign documents and retains same-origin browser identity', async () => {
		let outbound = 0;
		const foreign = createServer((_request, response) => { outbound++; response.end('foreign'); });
		await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
		const target = `http://127.0.0.1:${(foreign.address() as {port:number}).port}/secret?token=private#meaning`;
		const scriptReloads = new Map<string, number>();
		const server = createServer((request, response) => {
			const path = new URL(request.url!, 'http://fixture.test').pathname;
			response.setHeader('content-type','text/html');
			if (path === '/external-http') { response.writeHead(302, {location:target}); response.end(); }
			else if (path === '/same-to-external') { response.writeHead(302, {location:'/external-http'}); response.end(); }
			else if (path === '/external-refresh') { response.setHeader('refresh', `1; URL=${target}`); response.end('<p>Forward</p>'); }
			else if (path.startsWith('/external-meta')) response.end(`<meta http-equiv="Refresh" content="${path.endsWith('delayed') ? '1' : '0'}; URL=${target}"><a href="${target}">Forward</a>`);
			else if (path === '/same-http') { response.writeHead(301, {location:'/article?rendition=full#text', 'set-cookie':'source-session=kept; Path=/'}); response.end(); }
			else if (path === '/same-meta') response.end('<meta http-equiv="refresh" content="1;URL=/article?rendition=full#text">');
			else if (path === '/slash') { response.writeHead(302, {location:'/slash/'}); response.end(); }
			else if (path.startsWith('/loop')) { response.writeHead(302, {location:path === '/loop-a' ? '/loop-b' : '/loop-a'}); response.end(); }
			else if (path.startsWith('/hop/')) { response.writeHead(302, {location:`/hop/${Number(path.split('/').at(-1)) + 1}`}); response.end(); }
			else if (path === '/script') response.end('<script>location.href="/article"</script><p>Not a declarative alias</p>');
			else if (path.startsWith('/script-reload')) {
				// A page script reloads its own document before load (the slow image
				// holds load open), once or on every response.
				const count = (scriptReloads.get(path) ?? 0) + 1; scriptReloads.set(path, count);
				response.end(`${path === '/script-reload-loop' || count === 1 ? '<script>location.reload()</script><img src="/slow-image">' : ''}<h1>Reload observation ${count}</h1>`);
			}
			else if (path === '/slow-image') setTimeout(() => response.end(), 1_000);
			else if (path === '/error') { response.statusCode=404; response.end('<h1>Observed missing route</h1>'); }
			else if (path === '/binary') { response.setHeader('content-type','application/octet-stream'); response.end('Not HTML'); }
			// Under the byte budget as bytes, over it once decoded as UTF-8 (each 0xff becomes U+FFFD).
			else if (path === '/image') { response.setHeader('content-type','image/png'); response.end(Buffer.alloc(Math.floor(SOURCE_DOCUMENT_MAX_BYTES * 0.6), 0xff)); }
			else if (path === '/large-file') { response.setHeader('content-type','application/pdf'); response.end(Buffer.alloc(SOURCE_DOCUMENT_MAX_BYTES + 1)); }
			else if (path === '/large-html') response.end('x'.repeat(SOURCE_DOCUMENT_MAX_BYTES + 1));
			else if (path === '/slow') setTimeout(() => response.end('<p>Too late</p>'), 300);
			else response.end('<base href="./assets/"><h1 id="text">Article</h1><button onclick="location.href=\'/elsewhere\'">Navigate</button>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
		const browser = await chromium.launch();
		try {
			for (const javaScriptEnabled of [true, false]) {
				const context = await browser.newContext({javaScriptEnabled});
				const page = await context.newPage();
				for (const [path, mechanism, status] of [['external-http','http',302], ['external-refresh','refresh-header',200], ['external-meta','meta-refresh',200], ['external-meta-delayed','meta-refresh',200]] as const) {
					const result = await navigateSourceDocument(page, `${origin}/${path}`);
					expect(result.boundary?.responses[0]!.status).toBe(status);
					expect(result.boundary?.declaration).toMatchObject({mechanism, target});
					expect(page.url()).toBe(`${origin}/${path}`);
					expect(await page.content()).not.toContain('token=private');
				}
				expect((await navigateSourceDocument(page, `${origin}/same-to-external`)).boundary?.responses).toHaveLength(2);
				for (const path of ['same-http','same-meta']) {
					const result = await navigateSourceDocument(page, `${origin}/${path}`);
					expect(result.boundary).toBeUndefined();
					expect(result.redirectedTo).toBe(`${origin}/article?rendition=full#text`);
					await navigateSourceDocument(page, result.redirectedTo!);
					expect(page.url()).toBe(`${origin}/article?rendition=full#text`);
				}
				expect((await context.cookies()).some(cookie => cookie.name === 'source-session' && cookie.value === 'kept')).toBe(true);
				await navigateSourceDocument(page, `${origin}/slash`);
				expect(await page.evaluate(() => ({url:document.URL, base:document.baseURI}))).toEqual({url:`${origin}/slash/`, base:`${origin}/slash/assets/`});
				await context.close();
			}
			const page = await browser.newPage();
			for (const [path, error] of [['loop-a','loop'],['hop/0','hop budget'],['script','Unexplained']] as const) await expect(navigateSourceDocument(page, `${origin}/${path}`)).rejects.toThrow(error);
			// A same-document script reload is the document's own lifecycle, not
			// drift: it settles through the bounded reload acquisition, and a
			// script that reloads forever exhausts the reload budget.
			const reloaded = await navigateSourceDocument(page, `${origin}/script-reload`);
			expect(reloaded.boundary).toBeUndefined(); expect(reloaded.redirectedTo).toBeUndefined();
			expect(await page.evaluate(() => ({url: document.URL, text: document.querySelector('h1')?.textContent}))).toEqual({url: `${origin}/script-reload`, text: 'Reload observation 2'});
			await expect(navigateSourceDocument(page, `${origin}/script-reload-loop`)).rejects.toThrow(/reload.*budget/i);
			expect(scriptReloads.get('/script-reload-loop')).toBeLessThanOrEqual(SOURCE_NAVIGATION_LIMITS.hops + 1);
			await expect(navigateSourceDocument(page, `${origin}/slow`, {timeoutMs:100})).rejects.toThrow(/Timeout|timeout|budget/i);
			expect((await navigateSourceDocument(page, `${origin}/error`)).response?.status()).toBe(404);
			await expect(navigateSourceDocument(page, `${origin}/binary`)).rejects.toThrow(/Not an HTML document/i);
			// A non-HTML file is an absent page at any size; the byte budget bounds documents only.
			for (const path of ['image', 'large-file']) await expect(navigateSourceDocument(page, `${origin}/${path}`)).rejects.toThrow(/Not an HTML document/i);
			await expect(navigateSourceDocument(page, `${origin}/large-html`)).rejects.toThrow(/byte budget/);
			await navigateSourceDocument(page, `${origin}/article`);
			await page.locator('button').click(); await page.waitForURL(`${origin}/elsewhere`);
			expect(isRouteDrift(page.url(), `${origin}/article`)).toBe(true);
			expect(outbound).toBe(0);
			expect(SOURCE_NAVIGATION_LIMITS.hops).toBe(4);
		} finally {
			await browser.close(); server.closeAllConnections(); foreign.closeAllConnections();
			await Promise.all([new Promise<void>(resolve => server.close(() => resolve())),new Promise<void>(resolve => foreign.close(() => resolve()))]);
		}
	}, 60_000);
	it('completes on document arrival, reports a held subresource, and still times out a document that never arrives', async () => {
		// Held responses are released only when the server closes.
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'text/html');
			if (request.url === '/held-image' || request.url === '/never') return;
			if (request.url === '/held') { setTimeout(() => response.end('<h1 id="text">Delivered</h1><img src="/held-image">'), 300); return; }
			response.end('<h1 id="text">Complete</h1>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const started = Date.now();
			const held = await navigateSourceDocument(page, `${origin}/held`, {timeoutMs: 1_500});
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(held.loadIncomplete).toBe(true);
			expect(held.response?.status()).toBe(200);
			expect(await page.evaluate(() => ({url: document.URL, text: document.querySelector('h1')?.textContent}))).toEqual({url: `${origin}/held`, text: 'Delivered'});
			const complete = await navigateSourceDocument(page, `${origin}/complete`, {timeoutMs: 1_500});
			expect(complete.loadIncomplete).toBeUndefined();
			// A document that never arrives exhausts the navigation budget and
			// fails as a timeout (retryable: it is not a SourceNavigationError).
			const never = await navigateSourceDocument(page, `${origin}/never`, {timeoutMs: 8_000}).catch((error: unknown) => error);
			expect(never).toBeInstanceOf(Error);
			expect(never).not.toBeInstanceOf(SourceNavigationError);
			expect(String(never)).toMatch(/Timeout/);
		} finally {
			await browser.close(); server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}, 30_000);
	it('gives a slow document hop the remaining navigation budget and releases its guard when the budget runs out', async () => {
		// A slow but healthy origin: the document takes ~7 s, past any fixed
		// 5 s per-response cap, and well within the 30 s navigation budget.
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'text/html');
			if (request.url === '/never') return;
			if (request.url === '/slow-redirect') { setTimeout(() => { response.writeHead(302, {location: '/slow'}); response.end(); }, 1_000); return; }
			if (request.url === '/slow') { setTimeout(() => response.end('<h1 id="text">Slow document</h1>'), 7_000); return; }
			response.end('<h1 id="text">Complete</h1>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			let started = Date.now();
			const slow = await navigateSourceDocument(page, `${origin}/slow`);
			expect(Date.now() - started).toBeGreaterThanOrEqual(7_000);
			expect(slow.response?.status()).toBe(200);
			expect(await page.evaluate(() => ({url: document.URL, text: document.querySelector('h1')?.textContent}))).toEqual({url: `${origin}/slow`, text: 'Slow document'});
			// A later hop receives what remains of the chain budget, not a fixed cap.
			started = Date.now();
			const redirected = await navigateSourceDocument(page, `${origin}/slow-redirect`);
			expect(Date.now() - started).toBeGreaterThanOrEqual(8_000);
			expect(redirected.redirectedTo).toBe(`${origin}/slow`);
			expect(redirected.boundary).toBeUndefined();
			// The budget still bounds the chain: a document that never arrives
			// fails within it, and a document that arrives only after `goto` has
			// given up does not leave the guard installed or `unroute` hanging.
			for (const [path, budget] of [['never', 6_000], ['slow', 3_000]] as const) {
				started = Date.now();
				const failed = await navigateSourceDocument(page, `${origin}/${path}`, {timeoutMs: budget}).catch((error: unknown) => error);
				expect(Date.now() - started).toBeLessThan(budget + 2_000);
				expect(failed).toBeInstanceOf(Error);
				expect(failed).not.toBeInstanceOf(SourceNavigationError);
				expect(String(failed)).toMatch(/Timeout/);
				const after = await navigateSourceDocument(page, `${origin}/complete`, {timeoutMs: 3_000});
				expect(after.response?.status()).toBe(200);
				expect(await page.locator('#text').textContent()).toBe('Complete');
			}
		} finally {
			await browser.close(); server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}, 60_000);
});

describe('navigation timeout classification', () => {
	it('counts transport timeouts and an exhausted chain budget, and nothing else', () => {
		expect(isNavigationTimeout(Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), {name: 'TimeoutError'}))).toBe(true);
		expect(isNavigationTimeout(new Error('route.fetch: Timeout 5000ms exceeded.\nCall log: ...'))).toBe(true);
		expect(isNavigationTimeout(new SourceNavigationError('Source navigation time budget exhausted'))).toBe(true);
		expect(isNavigationTimeout(new SourceNavigationError('Source redirect loop'))).toBe(false);
		expect(isNavigationTimeout(new Error('net::ERR_CONNECTION_RESET'))).toBe(false);
		expect(isNavigationTimeout('Timeout 5000ms exceeded')).toBe(false);
	});
});
