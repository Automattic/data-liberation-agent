import { describe, expect, it } from 'vitest';
import { detectFromDocument } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { discoverMedium } from './discover.js';

describe('Medium owner scope', () => {
	it('detects medium.com authors and publications and scopes capture to the owner', () => {
		for (const url of ['https://medium.com/@writer/', 'https://medium.com/some-publication']) {
			expect(detectFromDocument(url, new Headers(), '')).toMatchObject({ platform: 'medium', confidence: 'high' });
		}
		for (const url of ['https://medium.com/', 'https://medium.com.evil.test/@writer', 'https://elsewhere.test/medium.com/@writer']) {
			expect(detectFromDocument(url, new Headers(), '').platform).not.toBe('medium');
		}
		expect(resolvePlatform('medium')?.routeScope?.('https://medium.com/@writer/story-1a2b')).toEqual({
			origin: 'https://medium.com', pathPrefixes: ['/@writer'], ignoredQueryParams: ['source'],
		});
	});

	it('starts at the owner root without reading the shared origin sitemap', async () => {
		const fetchSpy = globalThis.fetch;
		globalThis.fetch = (() => { throw new Error('discovery must not fetch'); }) as typeof fetch;
		try {
			expect((await discoverMedium('https://medium.com/@writer/', {})).urls).toEqual([{ url: 'https://medium.com/@writer/', type: 'homepage' }]);
			expect((await discoverMedium('https://medium.com/@writer/story-1a2b', {})).urls).toEqual([{ url: 'https://medium.com/@writer', type: 'homepage' }]);
		} finally {
			globalThis.fetch = fetchSpy;
		}
	});
});
