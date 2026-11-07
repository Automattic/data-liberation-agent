import { createServer } from 'node:http';
import { it, expect } from 'vitest';
import { renderedEntryNavigation } from './entry-navigation.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';

// One Chromium pass (~1s): the entry response has no anchors at all.
it('reads navigation landmarks inserted by the entry runtime, not ordinary content links', async () => {
	const server = createServer((req, res) => {
		res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
		res.end(req.url === '/app.js'
			? `document.body.innerHTML = '<nav><a href="/sell/">Sell</a><a href="/contact-us/">Contact</a><a href="/consignment/">Consignment</a></nav><main><a href="/product/1/">Product</a></main>';`
			: '<html><body><div id="app"></div><script src="/app.js"></script></body></html>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		const links = await runWithTrustedOrigins([origin], () => renderedEntryNavigation(`${origin}/`, new SourceRequestGovernors()));
		expect(links).toEqual(['sell', 'contact-us', 'consignment'].map(path => `${origin}/${path}/`));
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}, 30_000);
