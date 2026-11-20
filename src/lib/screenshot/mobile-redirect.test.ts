import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { navigateSourceDocument } from '../source-navigation.js';
import { holdMobileRedirects } from '../mobile-redirect.js';
import { captureWebsite } from '../capture.js';

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('mobile redirect fixture', () => {
	it('holds a conditional same-site redirect with source evidence, but rejects cross-origin and unconditional navigation', {timeout: 120_000}, async ({serve, newPage}) => {
		const {server} = await serve((request, response) => {
			if (request.url?.startsWith('/encoded')) {
				response.setHeader('content-type', 'text/html; charset=windows-1252');
				const script = request.url === '/encoded-held' ? '<script>if (screen.width <= 699) document.location = "/mhome.html";</script>' : '';
				response.end(Buffer.from(`${script}<h1>Caf\xe9</h1>`, 'latin1'));
				return;
			}
			response.setHeader('content-type', 'text/html');
			const target = request.url === '/external' ? 'https://outside.example/mobile' : '/mhome.html';
			const assignment = `document.location = ${JSON.stringify(target)};`;
			response.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><script>${request.url === '/unconditional' ? assignment : `if (screen.width <= 699) { ${assignment} }`}</script><h1>Source mobile content</h1>`);
		});
		const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
		const url = `${origin}/`;
		const page = await newPage();
		await page.setViewportSize({width:390, height:844});
		const navigation = await navigateSourceDocument(page, url);
		expect(navigation.mobileRedirects).toEqual([expect.objectContaining({source:url, target:`${origin}/mhome.html`, viewport:{width:390,height:844}, held:true, trigger:expect.objectContaining({kind:'inline-script',condition:'screen.width <= 699'})})]);
		expect(await page.locator('h1').innerText()).toBe('Source mobile content');
		for (const path of ['/encoded', '/encoded-held']) {
			const encoded = await navigateSourceDocument(page, `${origin}${path}`);
			expect(await page.locator('h1').innerText()).toBe('Café');
			expect(encoded.mobileRedirects?.length ?? 0).toBe(path === '/encoded-held' ? 1 : 0);
		}
		await expect(navigateSourceDocument(page, `${origin}/external`)).rejects.toThrow(/another site/);
		await expect(navigateSourceDocument(page, `${origin}/unconditional`)).rejects.toThrow('Unexplained source main-frame navigation');
		const canonical = holdMobileRedirects('<script>if (screen.width <= 699) document.location = "http://example.org/mhome.html";</script>', 'https://www.example.org/', {width:390,height:844});
		expect(canonical.redirects[0]?.target).toBe('https://www.example.org/mhome.html');
		mkdirSync('.tmp-test', {recursive:true});
		const directory = mkdtempSync(join(process.cwd(), '.tmp-test/mobile-redirect-'));
		try {
			await captureWebsite({url,outputDir:directory,trustedOrigins:[origin],routeLimit:1,deviceMode:'dual',learnFluid:false,captureImages:false});
			const manifest = readFileSync(join(directory,'screenshots/manifest.json'),'utf8');
			expect(manifest).toContain('source_mobile_redirect');
			expect(manifest).toContain('inline-script');
			expect(manifest).toContain('mhome.html');
			const entry = JSON.parse(manifest).entries[url];
			expect(readFileSync(join(directory,entry.mobileHtml),'utf8')).toContain('Source mobile content');
			const sidecar = entry.mobileHtml.replace(/^html-mobile\//, 'box-tree/').replace(/\.html$/, '.mobile.json');
			expect(existsSync(join(directory,sidecar))).toBe(true);
			const profile = JSON.parse(readFileSync(join(directory,'source-profile.json'),'utf8'));
			expect(profile.mobileRedirects).toContainEqual(expect.objectContaining({source:url,target:`${origin}/mhome.html`,held:true}));
			expect(readFileSync(join(directory,'diagnostics.json'),'utf8')).toContain('source_mobile_redirect');
		} finally { rmSync(directory,{recursive:true,force:true}); }
	});
});
