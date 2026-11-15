import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withTimeout } from './concurrency.js';
import type { HttpAcquisitionProfile } from '../platform/acquisition.js';
import type { SiteRouteScope } from '../platform/types.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import type { SourceRequestGovernors } from './source-request-governor.js';
import type { ManifestQueue, ManifestEntry } from './screenshot/manifest-queue.js';

/** Where the fallback's acquisition receipt and source documents live, next to `website/`. */
export const TEMPLATE_FALLBACK_DIR = 'template-fallback';

export interface EscalatedMember {
	url: string;
	gate: string;
	reason: string;
	runtimeAnchor?: import('./template-clusters.js').SlotAnchor;
	/** Export slug, when the platform publishes one (structured content). */
	slug?: string;
}

export interface EscalationFallback {
	/** Members acquired as ordinary manifest entries (rendered for runtime gates). */
	acquired: string[];
	/** Why each remaining member's fallback failed, keyed by URL. */
	failed: Map< string, string >;
	diagnostics: RouteDiagnostic[];
	runtime: Map< string, { observed: boolean; reason?: string } >;
}

/**
 * Acquire escalated template-cluster members through the adapter's HTTP
 * acquisition profile, then render runtime-gated members without the expensive
 * full capture probes. One desktop document per member, every request paced
 * by the source request governor. An acquired document becomes an ordinary
 * manifest entry, so export, the content index and redirects see it like any
 * captured route. A member whose acquisition fails is returned in `failed`.
 */
export async function acquireEscalatedMembers( input: {
	outputDir: string;
	sourceUrl: string;
	routeScope?: SiteRouteScope;
	profile: HttpAcquisitionProfile;
	governors: SourceRequestGovernors;
	members: readonly EscalatedMember[];
	queue: ManifestQueue;
	maxTotalBytes?: number;
	/** Shared deadline for the post-capture stage. */
	deadline?: number;
} ): Promise< EscalationFallback > {
	const { acquireHttpDocuments } = await import( './http-acquisition.js' );
	const { CapturedResourceStore } = await import( './screenshot/resource-capture.js' );
	const { slugify } = await import( './url/index.js' );
	const result: EscalationFallback = { acquired: [], failed: new Map(), diagnostics: [], runtime: new Map() };
	const failAll = ( reason: string ) => {
		for ( const member of input.members ) result.failed.set( member.url, reason );
		return result;
	};
	if ( ! input.members.length ) return result;
	const desktop = input.profile.exportVariants?.desktop ?? ( input.profile.variants.length === 1 ? input.profile.variants[ 0 ]!.id : undefined );
	const variants = input.profile.variants.filter( variant => variant.id === desktop );
	if ( ! variants.length ) return failAll( `acquisition profile ${ input.profile.id } declares no desktop variant` );
	let documents: Awaited< ReturnType< typeof acquireHttpDocuments > >[ 'documents' ];
	const fallbackDir = join( input.outputDir, TEMPLATE_FALLBACK_DIR );
	try {
		( { documents } = await acquireHttpDocuments( {
			url: input.sourceUrl, urls: input.members.map( member => member.url ), routeScope: input.routeScope,
			outputDir: fallbackDir, profile: { ...input.profile, variants }, governors: input.governors,
		} ) );
	} catch ( error ) {
		return failAll( error instanceof Error ? error.message : String( error ) );
	}
	let browser: import('playwright').Browser | undefined;
	const byUrl = new Map( documents.map( document => [ document.url, document ] ) );
	const store = new CapturedResourceStore( input.outputDir, input.sourceUrl, undefined, input.maxTotalBytes );
	try {
		for ( const member of input.members ) {
			const document = byUrl.get( member.url );
			if ( ! document ) {
				result.failed.set( member.url, 'route is outside the adapter route scope' );
				continue;
			}
			if ( document.status !== 'acquired' || ! document.documentPath ) {
				result.failed.set( member.url, `${ document.status }: ${ document.error ?? document.status }` );
				continue;
			}
			try {
				const source = resolve( fallbackDir, document.documentPath );
				let html = readFileSync( source, 'utf8' );
				if ( member.gate === 'runtime_mount_member_keyed' || member.gate === 'runtime_slot_content' ) {
					let context: import('playwright').BrowserContext | undefined;
					let timer: ReturnType< typeof setTimeout > | undefined;
					try {
						const remaining = Math.min( 15_000, ( input.deadline ?? Date.now() + 15_000 ) - Date.now() );
						if ( remaining <= 0 ) throw new Error( 'runtime render budget exhausted' ); // failure-class: operational
						const { connectBrowser, createSourceContext, sourceContextOptions } = await import( './browser-kit/index.js' );
						const { runtimeMountObserved, runtimeMountSelector } = await import( './template-clusters.js' );
						const deadline = Date.now() + remaining;
						browser ??= await withTimeout( connectBrowser( {} ), Math.max( 1, deadline - Date.now() ), 'runtime render browser startup', late => late.close() );
						if ( Date.now() >= deadline ) throw new Error( 'runtime render budget exhausted during browser startup' ); // failure-class: operational
						const options = await withTimeout( sourceContextOptions( browser, input.sourceUrl, { governors: input.governors } ), Math.max( 1, deadline - Date.now() ), 'runtime render source identity' );
						context = await withTimeout( createSourceContext( browser, { ...options, viewport: { width: 1440, height: 900 } }, { governors: input.governors, sourceUrl: input.sourceUrl } ), Math.max( 1, deadline - Date.now() ), 'runtime render context', late => late.close() );
						timer = setTimeout( () => { void context?.close().catch( () => {} ); }, Math.max( 1, deadline - Date.now() ) );
						const page = await context.newPage();
						await page.goto( member.url, { waitUntil: 'domcontentloaded', timeout: Math.max( 1, deadline - Date.now() ) } );
						// Lazy recommendations often start only when their mount enters view.
						const selector = member.runtimeAnchor ? runtimeMountSelector( html, member.runtimeAnchor ) : undefined;
						if ( selector ) await page.locator( selector ).scrollIntoViewIfNeeded( { timeout: Math.max( 1, deadline - Date.now() ) } );
						await page.waitForLoadState( 'networkidle', { timeout: Math.max( 1, Math.min( 1000, deadline - Date.now() ) ) } ).catch( () => {} );
						let rendered = await page.content();
						while ( member.runtimeAnchor && ! runtimeMountObserved( rendered, member.runtimeAnchor ) && Date.now() < deadline ) {
							await page.waitForTimeout( Math.min( 100, deadline - Date.now() ) );
							rendered = await page.content();
						}
						if ( member.runtimeAnchor && ! runtimeMountObserved( rendered, member.runtimeAnchor ) ) throw new Error( 'runtime mount remained empty' ); // failure-class: operational
						html = rendered;
						result.runtime.set( member.url, { observed: true } );
					} catch ( error ) {
						result.runtime.set( member.url, { observed: false, reason: `unobserved runtime mount: ${ member.reason }; ${ error instanceof Error ? error.message : String( error ) }` } );
					} finally {
						clearTimeout( timer );
						await context?.close().catch( () => {} );
					}
				}
				await store.captureDomDependencies( html, document.finalUrl ?? member.url );
				const slug = await input.queue.claimSlug( member.slug ?? slugify( member.url ) );
				const htmlPath = `screenshots/http/${ slug }.html`;
				const target = resolve( input.outputDir, htmlPath );
				mkdirSync( dirname( target ), { recursive: true } );
				writeFileSync( target, html );
				await input.queue.updateEntry( member.url, { slug, html: htmlPath, capturedAt: new Date().toISOString() } as ManifestEntry );
				result.acquired.push( member.url );
				for ( const region of document.browserRegions ?? [] ) {
					result.diagnostics.push( { code: 'http_browser_region_unobserved', url: member.url, reason: `${ document.variant }: ${ region.selector }: ${ region.reason }` } );
				}
			} catch ( error ) {
				result.failed.set( member.url, error instanceof Error ? error.message : String( error ) );
			}
		}
	} finally {
		await browser?.close().catch( () => {} );
		await store.flush();
	}
	return result;
}
