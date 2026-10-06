import { describe, expect, it } from 'vitest';
import { detectFromDocument, detectFromResponse } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { discoverDefault } from '../default/discover.js';

describe('Next.js infrastructure detection', () => {
	it('detects a real response header with high confidence', () => {
		expect(detectFromResponse(new Headers({ 'X-Powered-By': 'Next.js' }), '')).toMatchObject({
			platform: 'nextjs', confidence: 'high', signals: ['X-Powered-By: Next.js header'],
		});
	});

	it.each([
		'<script defer src="/_next/static/chunks/app/page-123.js"></script>',
		"<script src='https://cdn.example/site/_next/static/chunks/main.js'></script>",
		'<script type="application/json" id="__NEXT_DATA__">{"page":"/"}</script>',
		'<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
	])('detects bootstrap markup: %s', (html) => {
		expect(detectFromResponse(new Headers(), html)).toMatchObject({ platform: 'nextjs', confidence: 'medium' });
	});

	it.each([
		'<h1>Building with Next.js</h1><p>self.__next_f and __NEXT_DATA__ explained</p>',
		'<a href="/_next/static/chunks/main.js">Example asset</a>',
		'<pre>&lt;script id="__NEXT_DATA__"&gt;{}&lt;/script&gt;</pre>',
		'<div id="__NEXT_DATA__">An authored example</div>',
		'<script src="/examples/next.js"></script>',
	])('does not infer infrastructure from editorial references: %s', (html) => {
		expect(detectFromResponse(new Headers(), html).platform).toBe('unknown');
	});

	it('keeps more specific platform precedence for shared source and header evidence', () => {
		const next = '<script src="/_next/static/chunks/main.js"></script>';
		expect(detectFromResponse(new Headers(), `${next}<script src="https://static1.squarespace.com/site.js"></script>`).platform).toBe('squarespace');
		expect(detectFromResponse(new Headers({ 'x-powered-by': 'Next.js', 'x-shopid': '123' }), next).platform).toBe('shopify');
		expect(detectFromDocument('https://example.wixsite.com/', new Headers({ 'x-powered-by': 'Next.js' }), next).platform).toBe('wix');
	});

	it('resolves the registered adapter with generic discovery and inspectable removals', () => {
		const adapter = resolvePlatform('nextjs');
		if (!adapter) throw new Error('Missing registered Next.js adapter');
		expect(adapter.id).toBe('nextjs');
		expect(adapter.discover).toBe(discoverDefault);
		expect(adapter.liberation?.removeSelectors).toEqual(['next-route-announcer', '#__next-route-announcer__']);
	});
});
