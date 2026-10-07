import * as cheerio from 'cheerio';
import type {
	HttpAcquisitionProfile,
	HttpDocumentContext,
	PreparedHttpDocument,
	RuntimeRegionRequirement,
} from '../../platform/acquisition.js';

/** Brooklyn route HTML remains authoritative; observation supplies declared runtime surfaces. */
export function prepareShopifyDocument(html: string, context: HttpDocumentContext): PreparedHttpDocument | undefined {
	const $ = cheerio.load(html);
	const runtime = $('script:not([src])')
		.map((_, element) => $(element).text())
		.get()
		.join('\n');
	if (!/\bShopify\.shop\s*=\s*["'][^"']+\.myshopify\.com["']/.test(runtime)) return undefined;
	const theme = /\bShopify\.theme\s*=\s*(\{[^;]*?\})\s*;/.exec(runtime)?.[1];
	try {
		if (!theme || JSON.parse(theme).schema_name !== 'Brooklyn') return undefined;
	} catch {
		return undefined;
	}
	const classes = ($('body').attr('class') ?? '').split(/\s+/);
	const kind = ['page', 'index', 'collection', 'product'].find((kind) => classes.includes(`template-${kind}`));
	if (!kind) return undefined;
	if (kind === 'index' && !mainSection($, '[data-section-type="slideshow-section"]')) return undefined;
	if (kind === 'collection' && !mainSection($, '#CollectionSection')) return undefined;
	if (kind === 'product' && (!mainSection($, '.product-single__photos') || !mainSection($, '.product-single__meta')))
		return undefined;
	if (!$('[id^="shopify-section-"]').length || $('main').length !== 1) return undefined;
	const main = $('main');
	const content = main.clone().find('script,style,template,noscript').remove().end();
	if (!content.text().trim() || !content.find('h1,h2').length) return undefined;
	if (main.find('canvas,iframe,object,embed').length) return undefined;
	let unsupportedImage = false;
	$('main img[data-src]').each((_, element) => {
		const node = $(element),
			template = node.attr('data-src')!;
		let url: URL;
		try {
			url = new URL(template, context.finalUrl);
		} catch {
			unsupportedImage = true;
			return;
		}
		if (
			!(
				(url.origin === new URL(context.finalUrl).origin && url.pathname.startsWith('/cdn/shop/')) ||
				(url.hostname === 'cdn.shopify.com' && url.pathname.startsWith('/s/files/'))
			)
		) {
			unsupportedImage = true;
			return;
		}
		let declared: unknown;
		try {
			declared = JSON.parse(node.attr('data-widths') ?? 'null');
		} catch {
			unsupportedImage = true;
			return;
		}
		const widths = Array.isArray(declared)
			? (declared.filter(
					(width: unknown) => Number.isSafeInteger(width) && Number(width) > 0 && Number(width) <= 4096
				) as number[])
			: [];
		if (template.includes('{width}') && !widths.length) {
			unsupportedImage = true;
			return;
		}
		if (!node.attr('src')) node.attr('src', template.replace('{width}', String(Math.max(...widths))));
	});
	if (unsupportedImage) return undefined;
	const canonical = $('link[rel="canonical"]').first().attr('href');
	try {
		if (!canonical || new URL(canonical, context.finalUrl).href !== new URL(context.finalUrl).href) return undefined;
	} catch {
		return undefined;
	}

	$('script').each((_, element) => {
		const node = $(element);
		const type = (node.attr('type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
		if (!node.attr('src') && ['application/ld+json', 'application/json'].includes(type)) {
			try {
				const value: unknown = JSON.parse(node.text());
				if (value !== null && typeof value === 'object') {
					node.text(JSON.stringify(value).replace(/</g, '\\u003c'));
					return;
				}
			} catch {
				/* Invalid data scripts cannot supply inert evidence. */
			}
		}
		node.remove();
	});
	$('*').each((_, element) => {
		if ('attribs' in element)
			for (const name of Object.keys(element.attribs)) if (/^on/i.test(name)) $(element).removeAttr(name);
	});
	const regions: RuntimeRegionRequirement[] = [
		{ selector: 'html', projection: 'attributes', reason: 'Brooklyn JS/no-JS document presentation state.' },
		{ selector: 'body', projection: 'attributes', reason: 'Brooklyn route and drawer baseline state.' },
	];
	const add = (selector: string, reason: string) => {
		if ($(selector).length) regions.push({ selector, reason, projection: 'subtree' });
	};
	add(
		'#shopify-section-header',
		'Brooklyn header initial presentation, mobile drawer, search and cart baseline; backend interactions remain unverified.'
	);
	if (kind === 'index')
		$('main .shopify-section').each((_, element) => {
			const node = $(element),
				id = node.attr('id');
			if (id && /^[A-Za-z0-9_-]+$/.test(id) && node.find('.lazyload,[data-section-type="slideshow-section"]').length)
				add(`#${id}`, 'Brooklyn source-owned lazy/slideshow section and initial slide state.');
		});
	if (kind === 'collection') {
		add('.grid-product__wrapper', 'Brooklyn product card image, labels and initial price presentation.');
		add('#sort-by', 'Actual initial collection sort selection; sort navigation is unverified.');
	}
	if (kind === 'product') {
		add('.product-single__photos', 'Brooklyn initial gallery structure and observed image renditions.');
		add('.product-single__meta', 'Brooklyn initial variant/price/app presentation; purchasing backend is unverified.');
		add('#judgeme_product_reviews', 'Route-owned Judge.me initial review display; review submission is unverified.');
		add(
			'#shopify-section-product-recommendations',
			'Route-owned asynchronous recommendations; no reuse across products.'
		);
	}
	if ($('form[action]').length)
		regions.push({
			selector: 'form[action]',
			reason: 'Shopify forms require a backend; submission and validation remain unverified.',
		});
	return {
		html: $.html(),
		browserRegions: regions,
		metadata: {
			document: 'shopify-brooklyn-server-rendered',
			kind,
			title: $('head > title').first().text().trim(),
			canonical,
			preparation: 'scripts-removed,inert-json-retained,event-handlers-removed',
			rendering: 'unverified',
			assets: 'not-localized',
			interactions: 'unverified',
			variant: context.variant,
		},
	};
}

export const shopifyAcquisition: HttpAcquisitionProfile = {
	id: 'shopify',
	exportVariants: { desktop: 'desktop', mobile: 'mobile' },
	prepareRuntimeRegions: prepareShopifyRuntime,
	variants: [
		{
			id: 'desktop',
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
			},
		},
		{
			id: 'mobile',
			headers: {
				'User-Agent':
					'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			},
		},
	],
	prepare: prepareShopifyDocument,
};

function mainSection($: cheerio.CheerioAPI, selector: string): boolean {
	return $('main').find(selector).length > 0;
}

/** Shopify's closed wallet shadow root sizes its slotted light-DOM wrapper.
 * Preserve that measured box in the declared product subtree; checkout remains
 * an unresolved backend surface, not a reconstructed payment control.
 */
export async function preserveShopifyWalletPresentation(page: import('playwright').Page): Promise<void> {
	await page.evaluate(() => {
		for (const host of document.querySelectorAll('shopify-paypal-button')) {
			const wrapper = host.querySelector(':scope > div');
			if (!(wrapper instanceof HTMLElement) || wrapper.tagName !== 'DIV') continue;
			const height = host.getBoundingClientRect().height;
			if (height > 0 && Math.abs(wrapper.getBoundingClientRect().height - height) < 0.5) {
				wrapper.style.height = `${height}px`;
				wrapper.style.boxSizing = 'border-box';
			}
		}
	});
}

async function prepareShopifyRuntime(page: import('playwright').Page): Promise<void> {
	const { triggerLazyLoad, waitForFonts, waitForDomQuiescence, dismissOverlays } = await import(
		'../../lib/screenshot/page-helpers.js'
	);
	await page.waitForFunction(() => document.documentElement.classList.contains('supports-js'), undefined, {
		timeout: 10000,
	});
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('.hero-slideshow')].every((node) => node.classList.contains('slick-initialized')) &&
			(innerWidth >= 591 ||
				!document.querySelector('.product-single__photos') ||
				document.querySelector('.product-single__photos.slick-initialized')),
		undefined,
		{ timeout: 10000 }
	);
	await page.evaluate(() => {
		const jq = (
			window as unknown as {
				jQuery?: (node: Element) => { slick: (...args: Array<string | number | boolean>) => void };
			}
		).jQuery;
		if (jq) for (const slider of document.querySelectorAll('.slick-initialized')) jq(slider).slick('slickPause');
	});
	await dismissOverlays(page);
	await triggerLazyLoad(page);
	await page.waitForFunction(
		() =>
			(!document.querySelector('#judgeme_product_reviews') ||
				!!document.querySelector('#judgeme_product_reviews .jdgm-rev-widg')) &&
			(!document.querySelector('[data-section-type="product-recommendations"]') ||
				!!document.querySelector('[data-section-type="product-recommendations"] a[href*="/products/"]')),
		undefined,
		{ timeout: 10000 }
	);
	await page.waitForFunction(
		() =>
			[...document.images].every((image) => {
				const box = image.getBoundingClientRect(),
					style = getComputedStyle(image);
				return (
					box.width <= 0 || box.height <= 0 || style.visibility === 'hidden' || style.opacity === '0' || image.complete
				);
			}),
		undefined,
		{ timeout: 10000 }
	);
	await waitForFonts(page);
	await waitForDomQuiescence(page, 500, 3000);
	// Wallet markup can mount after the product's editorial/images baseline.
	// A missing backend stays unresolved without discarding the valid parent.
	await page.waitForFunction(() => [...document.querySelectorAll('shopify-paypal-button')].every(host => {
		const wrapper = host.querySelector(':scope > div');
		return wrapper instanceof HTMLElement && host.getBoundingClientRect().height > 0 &&
			Math.abs(wrapper.getBoundingClientRect().height - host.getBoundingClientRect().height) < 0.5;
	}), undefined, { timeout: 5000 }).catch(() => undefined);
	await preserveShopifyWalletPresentation(page);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.evaluate(() => {
		const jq = (
			window as unknown as {
				jQuery?: (node: Element) => { slick: (...args: Array<string | number | boolean>) => void };
			}
		).jQuery;
		if (jq) for (const slider of document.querySelectorAll('.slick-initialized')) jq(slider).slick('slickPause');
	});
}
