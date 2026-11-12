// src/adapters/figma-make/entry.ts
//
// A Figma Make link opens Figma's editor, not the site. The editor renders the
// project in a frame on its own preview origin, which answers 401 until the
// editor passes it a short-lived token. Resolving the link means loading the
// editor once and taking that tokenized preview URL; the preview origin
// exchanges the token for a session cookie that capture keeps for every route.
import { connectBrowser, desktopContextOptions } from '../../lib/browser-kit/browser-kit.js';
import { createSourceContext } from '../../lib/browser-kit/source-identity.js';
import { assertPublicHttpUrl } from '../../lib/media-fetch/safe-fetch.js';
import type { PlatformEntryResolver } from '../../platform/types.js';

export const FIGMA_MAKE_PREVIEW_HOST = /^[a-z0-9-]+-figmacachedpreview\.figma\.site$/;
const PREVIEW_TOKEN_PARAM = '__figma_cached_preview_token';
const EDITOR_HOSTS = new Set( [ 'figma.com', 'www.figma.com' ] );
const EDITOR_PATH = /^\/make\/[A-Za-z0-9]+(?:\/|$)/;
const EDITOR_LOAD_TIMEOUT_MS = 30_000;
const PREVIEW_TIMEOUT_MS = 120_000;
const VIEWER_BLOCKED_TEXT = 'You need to be an editor to preview this Make';

export function isFigmaMakeEditorUrl( url: URL ): boolean {
	return url.protocol === 'https:' && EDITOR_HOSTS.has( url.hostname ) && EDITOR_PATH.test( url.pathname );
}

/** The tokenized preview URL when `requestUrl` is the editor loading its preview frame. */
export function figmaMakePreviewEntry( requestUrl: string ): string | undefined {
	let url: URL;
	try {
		url = new URL( requestUrl );
	} catch {
		return undefined;
	}
	if ( url.protocol !== 'https:' || ! FIGMA_MAKE_PREVIEW_HOST.test( url.hostname ) || ! url.searchParams.get( PREVIEW_TOKEN_PARAM ) ) return undefined;
	return url.href;
}

async function resolveFigmaMakeEntry( editorUrl: string ): Promise< string > {
	const browser = await connectBrowser( {} );
	try {
		const context = await createSourceContext( browser, await desktopContextOptions( browser ), { sourceUrl: editorUrl } );
		const page = await context.newPage();
		let found: ( url: string ) => void = () => {};
		const preview = new Promise< string >( ( resolve ) => {
			found = resolve;
		} );
		await page.route( '**/*', async ( route ) => {
			const request = route.request();
			// Take the token without spending it: capture's own entry fetch exchanges it.
			const entry = request.isNavigationRequest() ? figmaMakePreviewEntry( request.url() ) : undefined;
			if ( entry ) {
				found( entry );
				await route.abort();
				return;
			}
			try {
				assertPublicHttpUrl( request.url() );
			} catch {
				await route.abort();
				return;
			}
			await route.fallback();
		} );
		await page.goto( editorUrl, { waitUntil: 'domcontentloaded', timeout: EDITOR_LOAD_TIMEOUT_MS } );
		const resolved = await Promise.race( [
			preview,
			new Promise< undefined >( ( resolve ) => setTimeout( resolve, PREVIEW_TIMEOUT_MS ) ),
		] );
		if ( resolved ) return resolved;
		const text = await page.evaluate( () => document.body?.innerText ?? '' ).catch( () => '' );
		if ( text.includes( VIEWER_BLOCKED_TEXT ) ) {
			// failure-class: operational
			throw new Error( 'This Figma Make project only previews for its editors. Share it publicly, or publish it and import the published site URL.' );
		}
		// failure-class: operational
		throw new Error( `The Figma Make editor did not load its preview within ${ PREVIEW_TIMEOUT_MS / 1000 } s.` );
	} finally {
		await browser.close().catch( () => {} );
	}
}

export const figmaMakeEntry: PlatformEntryResolver = {
	claims: isFigmaMakeEditorUrl,
	resolve: resolveFigmaMakeEntry,
};
