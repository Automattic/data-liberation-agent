import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { shopifyAdapter } from './index.js';
import { acquireHttpDocuments } from '../../lib/http-acquisition.js';
import { materializeHttpDocuments } from '../../lib/http-materialization.js';
import { chromium } from 'playwright';
import { preserveShopifyWalletPresentation, pauseShopifySlides } from './acquisition.js';

const source = 'https://shop.example/';
const pageUrl = `${source}pages/story`;
const fixture = (
	bodyClass = 'template-page',
	content = '<h1>Our craft</h1><p>Handmade objects with a story.</p><img src="/cdn/shop/files/craft.png" alt="Craft"><a href="/pages/story">Story</a>'
) =>
	`<!doctype html><html><head><title>Our craft</title><link rel="canonical" href="${pageUrl}"><style>main{color:rgb(10,20,30)}</style><script>Shopify.shop = "neutral.myshopify.com"; Shopify.theme = {"schema_name":"Brooklyn","schema_version":"15.2.6"};</script><script src="/theme.js"></script><script type="application/ld+json">{"@type":"Organization","name":"Neutral craft"}</script></head><body class="${bodyClass}"><nav id="NavDrawer"><button>Menu</button></nav><section id="shopify-section-header">Store</section><main>${content}</main><form action="/contact"><input name="email"><button>Subscribe</button></form></body></html>`;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Shopify declarative page HTTP profile', () => {
	it('learns a nonzero observed slide phase without freezing slide width or relative offsets at intermediate viewports', async () => {
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage({ viewport: { width: 1440, height: 900 } }), copy = await browser.newPage();
			await source.setContent(`<style>body{margin:0}.hero-slideshow{overflow:hidden}.slick-track{height:100px}.slick-slide{float:left;position:relative;height:100px;opacity:0}.slick-active{opacity:1}.small-caption{display:none}@media(max-width:768px){.wide-caption{display:none}.small-caption{display:block}}</style><body class="template-index"><div class="hero-slideshow slick-initialized"><div class="slick-track">${[0,1,2].map(index => `<div class="slick-slide ${index === 2 ? 'slick-active' : ''}"><span class="wide-caption">Phase ${index} wide</span><span class="small-caption">Phase ${index} narrow</span></div>`).join('')}</div></div><script>
		const hero=document.querySelector('.hero-slideshow');hero.slick={currentSlide:2,paused:false};window.jQuery=()=>({slickPause:()=>{hero.slick.paused=true}});
		const size=()=>{document.querySelector('.slick-track').style.width=(innerWidth*3)+'px';document.querySelectorAll('.slick-slide').forEach((node,index)=>{node.style.width=innerWidth+'px';node.style.left=(-index*innerWidth)+'px'})};size();addEventListener('resize',size);
		</script></body>`);
			const learning = await shopifyAdapter.acquisition!.projectRuntimeRegions!(source, { url: pageUrl, finalUrl: pageUrl, variant: 'desktop' });
			expect(learning).toMatchObject({ primitive: 'fluid-capture' });
			const $ = cheerio.load(await source.content()); $('script').remove();
			await copy.setContent($.html());
			for (const width of [390, 601, 768, 1024, 1440]) {
				await source.setViewportSize({ width, height: 900 });
				await source.waitForTimeout(30);
				await copy.setViewportSize({ width, height: 900 });
				expect(await source.locator('.hero-slideshow').evaluate(node => (node as HTMLElement & { slick: { currentSlide: number } }).slick.currentSlide)).toBe(2);
				expect(await copy.locator('.slick-active').boundingBox(), `observed slide at ${width}px`).toEqual(await source.locator('.slick-active').boundingBox());
				expect(await copy.locator('.slick-active').innerText()).toBe(width <= 768 ? 'Phase 2 narrow' : 'Phase 2 wide');
			}
		} finally { await browser.close(); }
	});
	it('pauses Brooklyn slides through its native API without selecting a different caption phase', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent('<style>.phone-caption{display:none}@media(max-width:767px){.desktop-caption{display:none}.phone-caption{display:block}}</style><div class="hero-slideshow slick-initialized" data-slide-index="2"><p class="desktop-caption">Observed caption phase</p><p class="phone-caption">Observed phone caption phase</p></div>');
			await page.evaluate(() => {
				const slider = document.querySelector('.hero-slideshow')! as HTMLElement & { slick: { paused: boolean; currentSlide: number; timer: ReturnType<typeof setInterval> } };
				slider.slick = { paused: false, currentSlide: 2, timer: setInterval(() => { slider.slick.currentSlide++; slider.querySelector('p')!.textContent = 'Unpaused caption'; }, 50) };
				(window as unknown as { jQuery: unknown }).jQuery = () => ({
					slick: () => undefined,
					slickPause: () => { slider.slick.paused = true; clearInterval(slider.slick.timer); },
				});
			});
			await pauseShopifySlides(page);
			await page.waitForTimeout(120);
			expect(await page.locator('.hero-slideshow').evaluate(node => (node as HTMLElement & { slick: { paused: boolean; currentSlide: number } }).slick)).toMatchObject({ paused: true, currentSlide: 2 });
			const copy = await browser.newPage();
			await copy.setContent(await page.content());
			for (const width of [390, 768, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await copy.setViewportSize({ width, height: 900 });
				const expected = width < 768 ? 'Observed phone caption phase' : 'Observed caption phase';
				expect(await page.locator('.hero-slideshow').innerText()).toBe(expected);
				expect(await copy.locator('.hero-slideshow').innerText()).toBe(expected);
			}
		} finally { await browser.close(); }
	});
	it('preserves the source wallet box after its closed shadow slot is removed from a projected subtree', async () => {
		const browser = await chromium.launch();
		try {
			const source = await browser.newPage();
			const copy = await browser.newPage();
			for (const width of [390, 768, 1440]) {
				await source.setViewportSize({ width, height: 900 });
				await copy.setViewportSize({ width, height: 900 });
				await source.setContent(`<!doctype html><style>body{margin:0}shopify-paypal-button{display:block;height:44px}.button{display:inline-block;height:44px}</style><shopify-paypal-button><style>.button{color:black}</style><div><span class="button" aria-label="Wallet"></span></div></shopify-paypal-button>`);
				await source.evaluate(() => {
					const shadow = document.querySelector('shopify-paypal-button')!.attachShadow({ mode: 'closed' });
					shadow.innerHTML = '<style>::slotted(div){height:100%}</style><slot></slot>';
				});
				const height = () => source.locator('shopify-paypal-button > div').evaluate(node => node.getBoundingClientRect().height);
				expect(await height()).toBe(44);
				await copy.setContent(await source.content());
				expect(await copy.locator('shopify-paypal-button > div').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(44);
				await preserveShopifyWalletPresentation(source);
				expect(await height()).toBe(44);
				await copy.setContent(await source.content());
				expect(await copy.locator('shopify-paypal-button > div').evaluate(node => node.getBoundingClientRect().height)).toBe(44);
			}
		} finally { await browser.close(); }
	});
	it('prepares declared Shopify renditions and declares bounded gallery/app/header projection rather than rejecting an authored product', async () => {
		const url = `${source}products/neutral-blanket`;
		const raw = fixture(
			'template-product',
			'<div class="product-single__photos"><img class="lazyload" data-src="/cdn/shop/products/blanket_{width}x.jpg" data-widths="[180,360,720]"></div><div class="product-single__meta"><h1>Neutral blanket</h1><p>$19.00 USD</p></div><div id="judgeme_product_reviews" class="jdgm-review-widget"></div><div id="shopify-section-product-recommendations"><div data-section-type="product-recommendations"></div></div>'
		).replace(pageUrl, url);
		const prepared = await shopifyAdapter.acquisition!.prepare(raw, { url, finalUrl: url, variant: 'desktop' });
		expect(prepared).toBeDefined();
		const $ = cheerio.load(prepared!.html);
		expect($('img').attr('src')).toBe('/cdn/shop/products/blanket_720x.jpg');
		expect($('img').attr('data-src')).toBe('/cdn/shop/products/blanket_{width}x.jpg');
		expect(prepared!.browserRegions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ selector: 'html', projection: 'attributes' }),
				expect.objectContaining({ selector: '.product-single__photos', projection: 'subtree' }),
				expect.objectContaining({ selector: '#judgeme_product_reviews', projection: 'subtree' }),
				expect.objectContaining({ selector: '#shopify-section-product-recommendations', projection: 'subtree' }),
			])
		);
	});
	it('retains native informational text, decoded images and authored reflow in a real browser at all proof widths', async () => {
		const image =
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=';
		const raw = fixture()
			.replace('Shopify.shop', 'var Shopify = {}; Shopify.shop')
			.replace('/cdn/shop/files/craft.png', image)
			.replace(
				'</style>',
				'@media(max-width:600px){main{max-width:330px}}@media(min-width:601px){main{max-width:700px}}</style>'
			);
		const prepared = await shopifyAdapter.acquisition!.prepare(raw, {
			url: pageUrl,
			finalUrl: pageUrl,
			variant: 'desktop',
		});
		expect(prepared).toBeDefined();
		const browser = await chromium.launch({ headless: true });
		try {
			for (const width of [390, 768, 1440]) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				const observation = async (html: string) => {
					await page.setContent(html, { waitUntil: 'load' });
					return page
						.locator('main')
						.evaluate((main) => ({
							text: (main as HTMLElement).innerText,
							width: main.getBoundingClientRect().width,
							color: getComputedStyle(main).color,
							decoded: (main.querySelector('img') as HTMLImageElement).naturalWidth > 0,
						}));
				};
				const source = await observation(raw);
				expect(source.width).toBe(width === 390 ? 330 : 700);
				expect(source.decoded).toBe(true);
				expect(await observation(prepared!.html)).toEqual(source);
				await page.close();
			}
		} finally {
			await browser.close();
		}
	});

	it('acquires both real route variants, preserves authored content/CSS/images and exports an explicitly incomplete review', async () => {
		expect(shopifyAdapter.acquisition, 'registered Shopify acquisition profile').toBeDefined();
		mkdirSync('.tmp-test', { recursive: true });
		const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/shopify-acquisition-'));
		dirs.push(outputDir);
		const headers: string[] = [];
		const result = await acquireHttpDocuments(
			{
				url: pageUrl,
				urls: [pageUrl, `${source}products/item`],
				outputDir,
				profile: shopifyAdapter.acquisition!,
				collectAssets: true,
			},
			{
				fetch: async (url, options) => {
					const userAgent = (await options?.headersForOrigin?.(new URL(url).origin))?.['User-Agent'] ?? '';
					headers.push(userAgent);
					const product = url.includes('/products/');
					const mobile = userAgent.includes('iPhone');
					const html = fixture(
						product ? 'template-product' : 'template-page',
						product ? '<h1>Runtime product</h1><img data-src="/cdn/shop/files/item_{width}x.png">' : undefined
					).replace(
						'</main>',
						mobile ? '<aside>Phone authored note.</aside></main>' : '<p>Desktop authored note.</p></main>'
					);
					return {
						finalUrl: url,
						status: 200,
						headers: new Headers({ 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' }),
						body: Buffer.from(url.endsWith('.png') ? 'neutral image fixture' : html),
					};
				},
			}
		);
		expect(result.coverage).toEqual({ routes: 2, requiredDocuments: 4, acquired: 2, browserRequired: 2, failed: 0 });
		expect(new Set(headers.filter(Boolean)).size).toBe(2);
		for (const doc of result.documents.filter((doc) => doc.status === 'acquired')) {
			const raw = readFileSync(join(outputDir, doc.rawPath!), 'utf8');
			const prepared = readFileSync(join(outputDir, doc.documentPath!), 'utf8');
			expect(raw).toContain('Shopify.theme');
			const $ = cheerio.load(prepared);
			expect($('main').text()).toBe(
				`Our craftHandmade objects with a story.Story${doc.variant === 'mobile' ? 'Phone' : 'Desktop'} authored note.`
			);
			expect($('style').text()).toBe('main{color:rgb(10,20,30)}');
			expect($('img').attr('src')).toBe('/cdn/shop/files/craft.png');
			expect($('link[rel=canonical]').attr('href')).toBe(pageUrl);
			expect($('script')).toHaveLength(1);
			expect(JSON.parse($('script').text())).toEqual({ '@type': 'Organization', name: 'Neutral craft' });
			expect(doc.browserRegions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ selector: '#shopify-section-header' }),
					expect.objectContaining({ selector: 'form[action]' }),
				])
			);
			expect(doc.metadata).toMatchObject({
				rendering: 'unverified',
				interactions: 'unverified',
				canonical: pageUrl,
				variant: doc.variant,
			});
		}
		const receipt = JSON.parse(
			readFileSync(
				materializeHttpDocuments({
					outputDir,
					sourceUrl: pageUrl,
					platform: 'shopify',
					desktopVariant: 'desktop',
					mobileVariant: 'mobile',
				}),
				'utf8'
			)
		);
		const exported = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		expect(exported).toContain('Handmade objects with a story.');
		expect(exported).toContain('Phone authored note.');
		expect(exported).toContain('Desktop authored note.');
		expect(exported).toContain('main{color:rgb(10,20,30)}');
		const asset = receipt.assets.find(
			(asset: { sourceUrl: string }) => asset.sourceUrl === `${source}cdn/shop/files/craft.png`
		);
		expect(readFileSync(join(outputDir, asset.path), 'utf8')).toBe('neutral image fixture');
		expect(receipt.summary.complete).toBe(false);
		expect(receipt.discoveryDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'http_browser_required', url: `${source}products/item` }),
				expect.objectContaining({ code: 'http_browser_region_unobserved' }),
			])
		);
	});

	it.each([
		fixture('template-index'),
		fixture('template-collection'),
		fixture('template-product'),
		fixture('template-page', '<h1>Story</h1><img class="lazyload" data-src="photo_{width}x.jpg">'),
		fixture('template-page', '<h1>Story</h1><canvas></canvas>'),
		fixture('template-page', '<script>mountStory()</script>'),
		fixture().replace('Shopify.shop', 'Other.shop'),
		fixture().replace('Brooklyn', 'UnmeasuredTheme'),
		fixture().replace(pageUrl, 'https://other.example/pages/story'),
	])('keeps unsupported or runtime-content documents browser-required', async (html) => {
		expect(shopifyAdapter.acquisition).toBeDefined();
		expect(
			await shopifyAdapter.acquisition!.prepare(html, { url: pageUrl, finalUrl: pageUrl, variant: 'desktop' })
		).toBeUndefined();
	});
});
