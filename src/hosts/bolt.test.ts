import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { it } from '../../test/browser.js';
import { detectHosts } from '../platform/host.js';
import '../platform/builtins.js';
import { applySourceCleanup, cleanupPolicy, cleanupPolicyForResponse, readSourceCleanup } from '../lib/source-cleanup.js';
import { createReferenceCollector, readReferenceArtifact, type FidelityReference } from '../lib/fidelity/reference.js';
import { boltHost } from './bolt.js';

const origin = 'https://lumen-studio-portfol-lrr6.bolt.host';
// Served HTML of the live site, and the badge script's DOM construction.
const served = readFileSync(new URL('./fixtures/bolt-lumen.html', import.meta.url), 'utf8');
const badge = readFileSync(new URL('./fixtures/bolt-badge.js', import.meta.url), 'utf8');
// Response headers the live site sends (Bolt serves through Netlify).
const headers = { 'content-type': 'text/html; charset=UTF-8', 'x-powered-by': 'Bolt.new', 'x-nf-request-id': '01M7QZSKKCZXK9HYTDXK8C8QH5' };

// Authored app content, including surfaces shaped like the badge: a fixed
// `body > div`, and an authored shadow host whose dismiss button is not Bolt's.
const app = `
const root = document.getElementById('root');
root.innerHTML = '<header><nav><a href="/">LUMEN STUDIO</a></nav></header><main><h1>Hair, considered.</h1><p>Soho, New York</p></main>';
const book = document.createElement('div');
book.id = 'book-now';
book.style.cssText = 'position:fixed;bottom:1rem;left:1rem';
book.textContent = 'Book now';
document.body.appendChild(book);
const notice = document.createElement('div');
notice.id = 'owner-notice';
notice.attachShadow({ mode: 'open' }).innerHTML = '<p>Closed Mondays</p><button class="dismiss" aria-label="Hide the notice">x</button>';
document.body.appendChild(notice);
`;

it('detects Bolt from the served response and records host bolt', () => {
	expect(detectHosts(new Headers(headers), served).map((host) => host.id)).toEqual(['netlify', 'bolt']);
	expect(detectHosts(new Headers(), served).find((host) => host.id === 'bolt')?.evidence)
		.toEqual(['Bolt badge script served from bolt.new/badge.js']);
	expect(detectHosts(new Headers({ 'x-powered-by': 'Express' }), '<script src="https://example.test/bolt.new/badge.js"></script>')).toEqual([]);
});

it('removes the Made in Bolt badge and nothing authored', async ({ newPage }) => {
	const page = await newPage();
	await page.route('**/*', async (route) => {
		const url = route.request().url();
		if (url === `${origin}/`) return route.fulfill({ status: 200, headers, body: served });
		if (url.startsWith('https://bolt.new/badge.js')) return route.fulfill({ contentType: 'text/javascript', body: badge });
		if (url === `${origin}/assets/index-BReE3MFl.js`) return route.fulfill({ contentType: 'text/javascript', body: app });
		return route.fulfill({ status: 404, body: '' });
	});
	const response = await page.goto(`${origin}/`);
	await page.waitForFunction(() => [...document.body.children].some((node) => node.shadowRoot?.querySelector('.badge-container')));

	const policy = cleanupPolicyForResponse(cleanupPolicy(), response, served);
	expect(policy.rules.filter((rule) => rule.host === 'bolt')).toEqual([expect.objectContaining({ ...boltHost.residue[0], category: 'source-attribution' })]);
	await applySourceCleanup(page, policy);
	const report = await readSourceCleanup(page, policy);

	const remaining = await page.evaluate(() => ({
		badge: [...document.querySelectorAll('*')].some((node) => node.shadowRoot?.textContent?.includes('Made in Bolt')),
		authored: ['#root h1', '#book-now', '#owner-notice'].filter((selector) => document.querySelector(selector)),
	}));
	expect(remaining).toEqual({ badge: false, authored: ['#root h1', '#book-now', '#owner-notice'] });
	expect(report.failures).toEqual([]);
	expect(report.records.filter((record) => record.host === 'bolt')).toEqual([expect.objectContaining({
		category: 'source-attribution', action: 'remove', evidence: boltHost.residue[0].evidence,
	})]);
	expect(report.records.filter((record) => record.host !== 'bolt')).toEqual([]);
}, 30_000);

// The frozen reference is navigated separately from capture; it must apply the
// same host residue, or the reference screenshot keeps a badge the copy lacks.
it('keeps the Made in Bolt badge out of the frozen fidelity reference', async ({ serve, newPage }) => {
	const { origin: local } = await serve((request, response) => {
		if (request.url?.startsWith('/badge.js?')) { response.setHeader('content-type', 'text/javascript'); response.end(badge); return; }
		if (request.url === '/assets/index-BReE3MFl.js') { response.setHeader('content-type', 'text/javascript'); response.end(app); return; }
		if (request.url !== '/') { response.writeHead(404).end(); return; }
		response.writeHead(200, headers);
		// Served locally, so the response header alone identifies the host.
		response.end(served.replace(/https:\/\/bolt\.new\/badge\.js/, '/badge.js'));
	});
	mkdirSync('.tmp-test', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.tmp-test/bolt-reference-'));
	try {
		const page = await newPage({ viewport: { width: 390, height: 900 } });
		const target = `${local}/`;
		const collector = createReferenceCollector(root, target, [target]);
		await collector.observe(page, target, 'desktop');
		const receipt = join(root, 'receipt.json');
		writeFileSync(receipt, JSON.stringify({ routes: [] }));
		const [entry] = (JSON.parse(readFileSync(collector.finalize(receipt), 'utf8')) as FidelityReference).entries;
		expect(entry.readiness.cleanup?.records).toEqual([expect.objectContaining({ host: 'bolt', action: 'remove' })]);
		const document = readReferenceArtifact(root, entry.document!).toString('utf8');
		expect(document).toContain('Hair, considered.');
		expect(document).toContain('id="book-now"');
		expect(document).not.toContain('2147483647');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
