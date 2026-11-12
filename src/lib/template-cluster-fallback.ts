import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
	/** Export slug, when the platform publishes one (structured content). */
	slug?: string;
}

export interface EscalationFallback {
	/** Members that shipped as HTTP-captured manifest entries. */
	acquired: string[];
	/** Why each remaining member's fallback failed, keyed by URL. */
	failed: Map< string, string >;
	diagnostics: RouteDiagnostic[];
}

/**
 * Acquire escalated template-cluster members through the adapter's HTTP
 * acquisition profile, one desktop document per member, every request paced
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
} ): Promise< EscalationFallback > {
	const { acquireHttpDocuments } = await import( './http-acquisition.js' );
	const { CapturedResourceStore } = await import( './screenshot/resource-capture.js' );
	const { slugify } = await import( './url/index.js' );
	const result: EscalationFallback = { acquired: [], failed: new Map(), diagnostics: [] };
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
				const html = readFileSync( source, 'utf8' );
				await store.captureDomDependencies( html, document.finalUrl ?? member.url );
				const slug = await input.queue.claimSlug( member.slug ?? slugify( member.url ) );
				const htmlPath = `screenshots/http/${ slug }.html`;
				const target = resolve( input.outputDir, htmlPath );
				mkdirSync( dirname( target ), { recursive: true } );
				copyFileSync( source, target );
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
