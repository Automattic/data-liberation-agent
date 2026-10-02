import { describe, expect, it } from 'vitest';
import { detectFromDocument, detectFromResponse, detectFromUrl } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { bloggerAcquisition } from './acquisition.js';

describe('Blogger detection', () => {
	it.each([
		'https://journal.blogspot.com/',
		'https://journal.blogspot.co.uk/2026/08/one.html',
		'http://journal.blogspot.com.au/search/label/Notes',
		'https://journal.blogspot.com.br:443/p/about.html',
	])('detects blogspot domains: %s', (url) => {
		expect(detectFromUrl(url)).toBe('blogger');
		expect(detectFromDocument(url, new Headers(), '<html></html>')).toMatchObject({
			platform: 'blogger',
			confidence: 'high',
			signals: ['URL contains blogger domain'],
		});
	});

	it.each([
		'https://evilblogspot.com/',
		'https://example.com/blogspot.com',
		'https://example.com/?next=https://journal.blogspot.com/',
		'https://not.blogspot.evil.example/',
	])('does not treat a blogspot-like string as a domain: %s', (url) => {
		expect(detectFromUrl(url)).toBeNull();
	});

	it.each([
		'<meta content="blogger" name="generator">',
		"<meta name='generator' content='Blogger'>",
		'<meta name="generator" content=" blogger " data-template="custom">',
	])('detects a custom-domain generator meta: %s', (meta) => {
		expect(detectFromResponse(new Headers(), `<html><head>${meta}</head><body><p>Journal</p></body></html>`)).toMatchObject({
			platform: 'blogger',
			confidence: 'medium',
			signals: ['Blogger generator meta tag'],
		});
	});

	it.each([
		'<p>The generator is Blogger and blogspot.com is a host.</p>',
		'<meta name="generator" content="WordPress">',
		'<meta name="generator" content="blogger-theme">',
		'<script src="https://www.blogger.com/static/runtime.js"></script>',
		'<meta name="description" content="blogger">',
	])('does not infer Blogger from editorial or non-generator markup: %s', (html) => {
		expect(detectFromResponse(new Headers(), html).platform).toBe('unknown');
	});

	it('registers an opt-in acquisition profile without replacing generic discovery ownership', () => {
		const adapter = resolvePlatform('blogger');
		expect(adapter?.id).toBe('blogger');
		expect(adapter?.acquisition).toBe(bloggerAcquisition);
		expect(bloggerAcquisition.variants.map((variant) => variant.id)).toEqual(['desktop', 'mobile']);
		expect(bloggerAcquisition.variants[0]?.headers?.['User-Agent']).not.toBe(bloggerAcquisition.variants[1]?.headers?.['User-Agent']);
	});
});
