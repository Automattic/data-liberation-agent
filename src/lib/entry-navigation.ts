import { connectBrowser, sourceContextOptions } from './browser-kit/browser-kit.js';
import { createSourceContext } from './browser-kit/source-identity.js';
import { assertPublicHttpUrl } from './media-fetch/safe-fetch.js';
import { extractNavigationLandmarkLinks } from './html-extract/index.js';
import { settleDocument } from './screenshot/page-helpers.js';
import { isIntegrityError } from './failure-class.js';
import type { SourceRequestGovernors } from './source-request-governor.js';

/** Read client-rendered chrome before a count budget can omit its destinations. */
export async function renderedEntryNavigation(url: string, governors: SourceRequestGovernors): Promise<string[]> {
	let browser: Awaited<ReturnType<typeof connectBrowser>> | undefined;
	try {
		browser = await connectBrowser({});
		const context = await createSourceContext(browser, await sourceContextOptions(browser, url, { publicUrlsOnly: true }), { governors, sourceUrl: url });
		const page = await context.newPage();
		await page.route('**/*', async route => {
			try { assertPublicHttpUrl(route.request().url()); }
			catch { await route.abort(); return; }
			await route.fallback();
		});
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
		await settleDocument(page, 'entry-navigation', { quietMs: 300, timeoutMs: 5_000 });
		if (new URL(page.url()).origin !== new URL(url).origin) return [];
		return extractNavigationLandmarkLinks(await page.content(), url).map(link => link.href);
	} catch (error) {
		if (isIntegrityError(error)) throw error; // failure-class: integrity
		process.stderr.write(`[capture] entry navigation unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
		return [];
	} finally {
		await browser?.close();
	}
}
