import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml } from './screenshotter.js';

// Visual-iframe evidence only records https sources, so the bug (an empty src
// resolving to the document's own URL) only shows on an https document.
const PAGE_URL = 'https://srcdoc-frame.test/';

it('records no visual-iframe evidence for a frame with no src of its own', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.route( PAGE_URL, ( route ) => route.fulfill( {
			contentType: 'text/html',
			body: `<!doctype html><html><body><main><h1>Page</h1></main><script>
				const frame = document.createElement('iframe');
				frame.title = 'Widget';
				frame.srcdoc = '<p>x</p>';
				frame.width = 200;
				frame.height = 60;
				document.body.append(frame);
			</script></body></html>`,
		} ) );
		await page.goto( PAGE_URL );

		const html = await capturePageHtml( page );
		const frame = /<iframe\b[^>]*>/i.exec( html )?.[ 0 ] ?? '';
		expect( frame ).not.toBe( '' );
		expect( frame ).not.toContain( 'data-blocks-engine-capture-visual-iframe-src' );
		expect( html ).not.toContain( `data-blocks-engine-capture-visual-iframe-src="${ PAGE_URL }"` );
	} finally {
		await browser.close();
	}
} );
