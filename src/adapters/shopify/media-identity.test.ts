import { expect, it } from 'vitest';
import { shopifyImageOriginal, shopifyStoreFileUrl } from './media-identity.js';
import { boundedResponsiveRenditions } from '../../lib/portable-media-limits.js';

it('gives every width/v rendition and host alias of a Shopify file one identity (#2142)', () => {
	const catalog = shopifyStoreFileUrl('https://cdn.shopify.com/s/files/1/0629/5971/4366/files/16.jpg?v=1', 'https://kafesia.com');
	expect(catalog).toBe('https://kafesia.com/cdn/shop/files/16.jpg?v=1');
	const original = 'https://kafesia.com/cdn/shop/files/16.jpg?width=2048';
	for (const url of [catalog, 'https://kafesia.com/cdn/shop/files/16.jpg?v=1&width=360', 'https://kafesia.com/cdn/shop/files/16.jpg']) expect(shopifyImageOriginal(url)).toBe(original);
	expect(shopifyImageOriginal(original)).toBeUndefined();
	// A crop is a different picture; theme assets and other hosts are not catalog files.
	expect(shopifyImageOriginal('https://kafesia.com/cdn/shop/files/16.jpg?v=1&width=360&crop=center&height=360')).toBeUndefined();
	expect(shopifyImageOriginal('https://kafesia.com/cdn/shop/t/4/assets/logo.png?v=1')).toBeUndefined();
	expect(shopifyStoreFileUrl('https://example.org/files/16.jpg', 'https://kafesia.com')).toBe('https://example.org/files/16.jpg');
});

it('keeps a bounded, width-spread set of captured responsive renditions', () => {
	const widths = Object.fromEntries([165, 360, 533, 720, 940, 1066, 1500, 3000].map(width => [`https://s/x?width=${width}`, width]));
	const urls = [...Object.keys(widths), 'https://s/crop.jpg'];
	expect(boundedResponsiveRenditions(urls, widths)).toEqual(['https://s/x?width=165', 'https://s/x?width=720', 'https://s/x?width=1500', 'https://s/crop.jpg']);
	expect(boundedResponsiveRenditions(urls.slice(0, 2), widths)).toEqual(urls.slice(0, 2));
});
