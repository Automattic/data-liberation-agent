import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mapPool, withTimeout } from './concurrency.js';
import type { HttpAcquisitionProfile } from '../platform/acquisition.js';
import type { SiteRouteScope } from '../platform/types.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import type { SourceRequestGovernors } from './source-request-governor.js';
import type { ManifestQueue, ManifestEntry } from './screenshot/manifest-queue.js';
import { normalizedUrl } from './url/route-key.js';

/** Where the fallback's acquisition receipt and source documents live, next to `website/`. */
export const TEMPLATE_FALLBACK_DIR = 'template-fallback';
/** HTTP work owns a separate window; browser admission never gates it. */
export const HTTP_FALLBACK_BUDGET_MS = 600_000;

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
	/** Canonical navigation targets precede ordinary templates and cluster members. */
	navigationTargets?: ReadonlySet< string >;
	clusterMemberUrls?: ReadonlySet< string >;
	queue: ManifestQueue;
	maxTotalBytes?: number;
	/** Absolute HTTP deadline; defaults to a fresh HTTP_FALLBACK_BUDGET_MS window. */
	deadline?: number;
	/** Budget for runtime renders, measured from the start of that stage. */
	runtimeRenderBudgetMs?: number;
} ): Promise< EscalationFallback > {
	const priority = ( member: EscalatedMember ) => input.navigationTargets?.has( normalizedUrl( member.url ) ) ? 0
		: member.gate === 'route_omitted_by_budget' && ! input.clusterMemberUrls?.has( normalizedUrl( member.url ) ) ? 1 : 2;
	input = { ...input, members: [ ...input.members ].sort( ( a, b ) => priority( a ) - priority( b ) ), deadline: input.deadline ?? Date.now() + HTTP_FALLBACK_BUDGET_MS };
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
		const acquired = await acquireHttpDocuments( {
			url: input.sourceUrl, urls: input.members.map( member => member.url ), routeScope: input.routeScope,
			outputDir: fallbackDir, profile: { ...input.profile, variants }, governors: input.governors, deadline: input.deadline,
		} );
		documents = acquired.documents;
	} catch ( error ) {
		return failAll( error instanceof Error ? error.message : String( error ) );
	}
	const byUrl = new Map( documents.map( document => [ document.url, document ] ) );
	const signal = input.deadline === undefined ? undefined : AbortSignal.timeout( Math.max( 1, input.deadline - Date.now() ) );
	const store = new CapturedResourceStore( input.outputDir, input.sourceUrl, signal ? async ( url, maxBytes, timeoutMs ) => {
		const { safeFetch } = await import( './media-fetch/safe-fetch.js' );
		return safeFetch( url, { maxBytes, timeoutMs, signal, governors: input.governors, category: 'subresource' } );
	} : undefined, input.maxTotalBytes );
	const sourcePath = ( url: string ): string | undefined => {
		const document = byUrl.get( url );
		return document?.status === 'acquired' && document.documentPath ? resolve( fallbackDir, document.documentPath ) : undefined;
	};
	const rendered = await renderRuntimeMembers( input, sourcePath, result.runtime );
	try {
		for ( const member of input.members ) {
			// Keep documents already acquired before the deadline, even when later
			// cluster requests exhausted it. Dependencies still use the HTTP signal.
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
				const html = rendered.get( member.url ) ?? readFileSync( sourcePath( member.url )!, 'utf8' );
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
		await store.flush();
	}
	return result;
}

/** Runtime renders: their own budget, bounded concurrency, one browser. */
export const RUNTIME_RENDER_LIMITS = { budgetMs: 300_000, perMemberMs: 15_000, concurrency: 3 };

/** The render budget scales with an explicit capture budget, like the other stage limits. */
export function runtimeRenderBudgetMs( timeBudgetMs: number | undefined ): number {
	return timeBudgetMs === undefined ? RUNTIME_RENDER_LIMITS.budgetMs : Math.min( RUNTIME_RENDER_LIMITS.budgetMs, Math.max( 1, Math.floor( timeBudgetMs / 5 ) ) );
}

/**
 * Render each member whose empty server mount the runtime fills in Chromium and transplant only its filled
 * mount into the prepared HTTP document. The budget starts with this stage, so
 * earlier derivation rounds cannot spend it. Returns the transplanted documents.
 */
async function renderRuntimeMembers(
	input: Parameters< typeof acquireEscalatedMembers >[ 0 ],
	sourcePath: ( url: string ) => string | undefined,
	runtime: EscalationFallback[ 'runtime' ]
): Promise< Map< string, string > > {
	const members = input.members.filter( member => member.gate === 'runtime_mount_member_keyed' && sourcePath( member.url ) );
	const rendered = new Map< string, string >();
	if ( ! members.length ) return rendered;
	const { connectBrowser, createSourceContext, sourceContextOptions } = await import( './browser-kit/index.js' );
	const { runtimeMountObserved, runtimeMountSelector, transplantRuntimeMount } = await import( './template-clusters.js' );
	const stageDeadline = Date.now() + ( input.runtimeRenderBudgetMs ?? RUNTIME_RENDER_LIMITS.budgetMs );
	let browser: Promise< import('playwright').Browser > | undefined;
	try {
		await mapPool( members, RUNTIME_RENDER_LIMITS.concurrency, async member => {
			let context: import('playwright').BrowserContext | undefined;
			let timer: ReturnType< typeof setTimeout > | undefined;
			try {
				const deadline = Math.min( stageDeadline, Date.now() + RUNTIME_RENDER_LIMITS.perMemberMs );
				if ( deadline <= Date.now() ) throw new Error( 'runtime render budget exhausted' ); // failure-class: operational
				const html = readFileSync( sourcePath( member.url )!, 'utf8' );
				const anchor = member.runtimeAnchor;
				const selector = anchor ? runtimeMountSelector( html, anchor ) : undefined;
				if ( ! anchor || ! selector ) throw new Error( 'runtime mount anchor does not resolve in the HTTP document' ); // failure-class: operational
				const left = () => Math.max( 1, deadline - Date.now() );
				browser ??= connectBrowser( {} );
				const shared = await withTimeout( browser, left(), 'runtime render browser startup' );
				const options = await withTimeout( sourceContextOptions( shared, input.sourceUrl, { governors: input.governors } ), left(), 'runtime render source identity' );
				context = await withTimeout( createSourceContext( shared, { ...options, viewport: { width: 1440, height: 900 } }, { governors: input.governors, sourceUrl: input.sourceUrl } ), left(), 'runtime render context', late => late.close() );
				timer = setTimeout( () => { void context?.close().catch( () => {} ); }, left() );
				const page = await context.newPage();
				await page.goto( member.url, { waitUntil: 'domcontentloaded', timeout: left() } );
				// Lazy recommendations often start only when their mount enters view.
				const liveSelector = runtimeMountSelector( await page.content(), anchor );
				if ( liveSelector ) await page.locator( liveSelector ).scrollIntoViewIfNeeded( { timeout: left() } ).catch( () => {} );
				await page.waitForLoadState( 'networkidle', { timeout: Math.min( 1000, left() ) } ).catch( () => {} );
				let live = await page.content();
				while ( ! runtimeMountObserved( live, anchor ) && Date.now() < deadline ) {
					await page.waitForTimeout( Math.min( 100, left() ) );
					live = await page.content();
				}
				const transplanted = runtimeMountObserved( live, anchor ) ? transplantRuntimeMount( html, live, anchor ) : undefined;
				if ( ! transplanted || ! runtimeMountObserved( transplanted, anchor ) ) throw new Error( 'runtime mount remained empty' ); // failure-class: operational
				rendered.set( member.url, transplanted );
				runtime.set( member.url, { observed: true } );
			} catch ( error ) {
				runtime.set( member.url, { observed: false, reason: `unobserved runtime mount: ${ member.reason }; ${ error instanceof Error ? error.message : String( error ) }` } );
			} finally {
				clearTimeout( timer );
				await context?.close().catch( () => {} );
			}
		} );
	} finally {
		void browser?.then( shared => shared.close(), () => {} ).catch( () => {} );
	}
	return rendered;
}
