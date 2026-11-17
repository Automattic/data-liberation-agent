import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { githubPagesRouteScope } from './github-pages.js';
import { safeFetch } from '../lib/media-fetch/safe-fetch.js';
import { captureWebsite } from '../index.js';

vi.mock('../lib/media-fetch/safe-fetch.js', async importOriginal => ({
	...await importOriginal<typeof import('../lib/media-fetch/safe-fetch.js')>(),
	safeFetch: vi.fn(),
}));

const origin = 'https://author.github.io';
const endpoint = 'https://api.github.com/users/author/repos?per_page=100';
const dirs: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
	{ entry: `${origin}/`, failure: false, expected: { origin, pathPrefixes: ['/'], excludedPathPrefixes: ['/demo', '/docs'] }, requests: 2 },
	{ entry: `${origin}/project/guide/`, failure: false, expected: { origin, pathPrefixes: ['/project'] }, requests: 0 },
	{ entry: `${origin}/`, failure: 'http', expected: { origin, pathPrefixes: ['/'] }, requests: 1 },
	{ entry: `${origin}/`, failure: 'json', expected: { origin, pathPrefixes: ['/'] }, requests: 1 },
	{ entry: `${origin}/`, failure: 'network', expected: { origin, pathPrefixes: ['/'] }, requests: 1 },
	{ entry: `${origin}/`, failure: 'page-two', expected: { origin, pathPrefixes: ['/'] }, requests: 2 },
	{ entry: 'https://example.test/', failure: false, expected: undefined, requests: 0 },
	{ entry: 'https://author.github.io.evil.test/', failure: false, expected: undefined, requests: 0 },
])('resolves Pages scope for $entry (failure=$failure)', async ({ entry, failure, expected, requests }) => {
	vi.mocked(safeFetch).mockImplementation(async url => {
		if (failure === 'network') throw new TypeError('fetch failed');
		return {
		finalUrl: url, status: failure === 'http' || (failure === 'page-two' && url !== endpoint) ? 403 : 200,
		headers: new Headers(url === endpoint ? { link: `<${endpoint}&page=2>; rel="next", <${endpoint}&page=2>; rel="last"` } : {}),
		body: Buffer.from(failure === 'json' ? 'not JSON' : JSON.stringify(url === endpoint ? [
			{ name: 'author.github.io', has_pages: true },
			{ name: 'private-not-pages', has_pages: false },
			{ name: 'demo', has_pages: true },
		] : [{ name: 'docs', has_pages: true }])),
		};
	});
	const diagnostics: Array<{ code: string; url: string; reason: string }> = [];
	expect(await githubPagesRouteScope(entry, diagnostics)).toEqual(expected);
	expect(safeFetch).toHaveBeenCalledTimes(requests);
	expect(diagnostics.map(row => row.code)).toEqual(failure ? ['github_pages_scope_unavailable'] : []);
});

it.each([false, true])('admits user-site routes through public capture (lookup failure=%s)', async failure => {
	const html = '<!doctype html><html><head><title>Portfolio</title></head><body><main><h1>Portfolio</h1><a href="/demo/">Demo</a></main></body></html>';
	vi.mocked(safeFetch).mockImplementation(async url => ({
		finalUrl: url, status: failure && url === endpoint ? 403 : 200, headers: new Headers({ 'content-type': url === endpoint ? 'application/json' : 'text/html' }),
		body: Buffer.from(url === endpoint ? JSON.stringify([{ name: 'demo', has_pages: true }]) : html),
	}));
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/pages-scope-'));
	dirs.push(outputDir);
	const result = await captureWebsite({ url: `${origin}/`, outputDir, acquisition: 'http' }, {
		findAdapter: () => ({
			id: 'fixture',
			discover: async () => ({ urls: [{ url: `${origin}/` }, { url: `${origin}/demo/` }] }),
			acquisition: { id: 'fixture-http', variants: [{ id: 'authored' }], prepare: html => ({ html }) },
		}),
	});
	const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
	expect(receipt.routes.map((route: { url: string }) => route.url)).toEqual(failure ? [`${origin}/`, `${origin}/demo/`] : [`${origin}/`]);
	expect(readFileSync(join(outputDir, 'website/index.html'), 'utf8')).toContain(`href="${failure ? '/demo/index.html' : `${origin}/demo/`}"`);
	expect(result.discoveryDiagnostics?.some(row => row.code === 'github_pages_scope_unavailable')).toBe(failure);
});
