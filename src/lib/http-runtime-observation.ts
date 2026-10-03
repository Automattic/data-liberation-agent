import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpAcquisitionProfile } from '../platform/acquisition.js';
import type { acquireHttpDocuments } from './http-acquisition.js';
import type { CaptureProgress } from './capture.js';
import { withTimeout } from './concurrency.js';
import { assertPublicHttpUrl } from './media-fetch/safe-fetch.js';
import { observeRuntimeRegions } from './runtime-regions.js';
import { stageRuntimeRegions, type RuntimeRegionAttachment } from './embedded-documents.js';

export async function observeHttpCaptureRegions( options: {
	outputDir: string; acquisition: Awaited<ReturnType<typeof acquireHttpDocuments>>; profile: HttpAcquisitionProfile;
	roles: { desktop: string; mobile?: string }; routeLimit: number; progress: ( event: CaptureProgress ) => void;
} ) {
	const eligible = options.acquisition.documents.filter( document => document.status === 'acquired' && document.browserRegions?.length );
	const routes = [ ...new Set( eligible.map( document => document.url ) ) ];
	const count = Math.min( options.routeLimit, routes.length );
	const selected = new Set( Array.from( { length: count }, ( _, index ) => routes[ count === 1 ? 0 : Math.round( index * ( routes.length - 1 ) / ( count - 1 ) ) ] ) );
	const documents = eligible.filter( document => selected.has( document.url ) );
	const failures: Array<{ url: string; error: string }> = [];
	const attachments: RuntimeRegionAttachment[] = [];
	if ( ! documents.length ) return { attachments: 0, observations: 0, failures };
	const { connectBrowser } = await import( './browser-kit/browser-kit.js' );
	const browser = await withTimeout( connectBrowser( {} ), 60_000, 'runtime browser launch', late => { void late.close().catch( () => {} ); } );
	try {
		for ( const [ index, document ] of documents.entries() ) {
			const variant = options.profile.variants.find( candidate => candidate.id === document.variant )!;
			const context = await withTimeout( browser.newContext( {
				viewport: { width: document.variant === options.roles.mobile ? 390 : 1440, height: 900 },
				userAgent: new Headers( variant.headers ).get( 'user-agent' ) ?? undefined, serviceWorkers: 'block',
			} ), 10_000, 'runtime context create', late => { void late.close().catch( () => {} ); } );
			try {
				const observation = await withTimeout( ( async () => {
					const body = readFileSync( join( options.outputDir, document.rawPath! ) );
					if ( createHash( 'sha256' ).update( body ).digest( 'hex' ) !== document.rawSha256 ) throw new Error( 'Runtime source response hash mismatch' );
					const page = await context.newPage();
					page.setDefaultTimeout( 10_000 );
					await page.route( '**/*', async route => {
						try { assertPublicHttpUrl( route.request().url() ); } catch { await route.abort( 'blockedbyclient' ); return; }
						if ( route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ) {
							if ( route.request().url() !== document.url ) { await route.abort(); return; }
							await route.fulfill( { contentType: document.rawContentType, body } ); return;
						}
						await route.continue();
					} );
					await page.goto( document.url, { waitUntil: 'load', timeout: 20_000 } );
					await options.profile.prepareRuntimeRegions?.( page, { url: document.url, finalUrl: document.finalUrl!, variant: document.variant } );
					return observeRuntimeRegions( page, document.url, document.browserRegions! );
				} )(), 45_000, 'runtime-region observation' );
				attachments.push( { variant: document.variant, observation } );
			} catch ( error ) { failures.push( { url: document.url, error: `${ document.variant } runtime observation: ${ String( error ) }` } ); }
			finally { await withTimeout( context.close(), 10_000, 'runtime context close' ).catch( () => {} ); }
			options.progress( { phase: 'capturing', current: index + 1, total: documents.length, unit: 'documents', url: document.url } );
		}
	} finally { await withTimeout( browser.close(), 10_000, 'runtime browser close' ).catch( () => {} ); }
	writeFileSync( join( options.outputDir, 'runtime-observations.json' ), JSON.stringify( { schema: 'data-liberation/runtime-observations/v1', routeLimit: options.routeLimit, selectedRoutes: [ ...selected ], attachments, failures, sourceResponses: documents.map( document => ( { url: document.url, variant: document.variant, rawSha256: document.rawSha256 } ) ) }, null, 2 ) + '\n' );
	if ( ! attachments.length ) return { attachments: 0, observations: 0, failures };
	const path = await stageRuntimeRegions( { outputDir: options.outputDir, attachments } );
	const staged = JSON.parse( readFileSync( path, 'utf8' ) );
	return { attachments: staged.regions.length as number, observations: attachments.length, failures };
}
