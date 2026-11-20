import { describe, expect, it, vi } from 'vitest';

vi.mock('cheerio', async importOriginal => {
	const original = await importOriginal<typeof import('cheerio')>();
	return { ...original, load: vi.fn(original.load) };
});
import { load } from 'cheerio';
import { holdMobileRedirects } from './mobile-redirect.js';

const viewport = { width: 390, height: 844 };
const source = 'https://www.example.org/';

describe('mobile redirect admission', () => {
	it('does not build another DOM for ordinary documents on the shared navigation path', () => {
		for (const html of [
			'<h1>Ordinary page</h1>',
			'<script>if (screen.width <= 699) initializeMenu();</script>',
			'<script>document.location = "/next";</script>',
		]) {
			vi.mocked(load).mockClear();
			expect(holdMobileRedirects(html, source, viewport)).toEqual({ html, redirects: [] });
			expect(load).not.toHaveBeenCalled();
		}
	});

	it('retains conditional classification and canonicalization after lexical admission', () => {
		const html = '<script>if (screen /* viewport */ . width <= 699) document.location = "http://example.org/mobile";</script><h1>Source</h1>';
		const result = holdMobileRedirects(html, source, viewport);
		expect(result.redirects).toContainEqual(expect.objectContaining({ source, target: `${source}mobile`, viewport, held: true }));
		expect(result.html).toContain('<h1>Source</h1>');
		expect(result.html).not.toContain('document.location =');
	});
});
