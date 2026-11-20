import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { mapPool, withTimeout } from './concurrency.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { pathWithin } from './portable-assets.js';
import { normalizedUrl } from './url/route-key.js';
import type { SiteRouteScope } from '../platform/types.js';
import type { SourceRequestGovernors } from './source-request-governor.js';
import type { TemplateGroup, TemplateIdentity, TemplateStyleNormalization } from './template-groups.js';

/**
 * Template-scaled browser capture (#784). The browser pass captures each
 * multi-member cluster's representative and verification member first. As
 * soon as both are on disk, this verifies the cluster in the background
 * (derive the verification member, compare it with its real capture) and
 * checks every pending member's derivation gates. A member that passes is
 * deferred: the browser pass skips it and post-capture derivation produces
 * it. Nothing is deferred until its own document passed, so an unverified
 * cluster, a gated member or a check that is still running when the browser
 * reaches the member takes the ordinary full capture.
 */
export const TEMPLATE_DEFERRAL_LIMITS = {
	/** One member document fetch, as in template derivation. */
	requestTimeoutMs: 15_000,
	/** One light render: navigation, short settle, bounded hydration, one DOM read. */
	renderMs: 45_000,
	settleMs: 2_000,
	/** Light renders run alongside the browser pass. */
	renderConcurrency: 3,
} as const;

/** Where a cluster's slot documents come from. */
export type MemberDocumentSource = 'server' | 'rendered';

export type MemberDocument = { html: string } | { unavailable: string };

/**
 * A captured document profile's browser identity, for a light render of a
 * member as that profile saw it (a phone render for a phone document).
 * Omitted, a light render uses the source identity at desktop width.
 */
export interface RenderProfile {
	id: string;
	identity?: import('./screenshot/capture-profiles.js').ReplayBrowserIdentity;
	viewport: { width: number; height: number };
}

type Group = Pick< TemplateGroup, 'size' | 'representative' | 'members' >;

export interface TemplateClusterDeferralInput {
	sourceUrl: string;
	outputDir: string;
	routeScope?: SiteRouteScope;
	governors: SourceRequestGovernors;
	templateIdentity?: TemplateIdentity;
	styleNormalization?: TemplateStyleNormalization;
	rewriteDerivedMedia?: import('../adapters/page-actions.js').LiberationHooks['rewriteDerivedMedia'];
	/** No light render starts after this instant. */
	deadline?: number;
}

function documentKey( url: string, source: MemberDocumentSource, profile: RenderProfile | undefined ): string {
	return `${ source }${ source === 'rendered' && profile ? `:${ profile.id }` : '' } ${ normalizedUrl( url ) }`;
}

/** The cluster's verification member, as route ranking seeds it. */
function verificationMember( group: Group ): string | undefined {
	return group.members.filter( url => url !== group.representative ).sort( ( a, b ) => a.localeCompare( b ) )[ 0 ];
}

export class TemplateClusterDeferral {
	private readonly captured = new Map< string, string >();
	private readonly started = new Set< string >();
	private readonly deferred = new Set< string >();
	private readonly documents = new Map< string, Promise< MemberDocument > >();
	private readonly checks: Promise< void >[] = [];
	private browser?: Promise< Browser >;
	private identity?: Promise< BrowserContextOptions >;
	private closing = false;

	constructor( private readonly input: TemplateClusterDeferralInput, private readonly groups: () => readonly Group[] ) {}

	/** The browser pass captured `url`; `htmlPath` is its desktop document. */
	routeCaptured( url: string, htmlPath: string | undefined ): void {
		if ( ! htmlPath ) return;
		const file = resolve( this.input.outputDir, htmlPath );
		if ( ! pathWithin( this.input.outputDir, file ) ) return;
		this.captured.set( normalizedUrl( url ), file );
		for ( const group of this.groups() ) {
			if ( group.size < 2 || this.started.has( group.representative ) ) continue;
			const verifier = verificationMember( group );
			if ( ! verifier || ! this.captured.has( normalizedUrl( group.representative ) ) || ! this.captured.has( normalizedUrl( verifier ) ) ) continue;
			this.started.add( group.representative );
			this.checks.push( this.check( group, verifier ).catch( error => {
				process.stderr.write( `[template-clusters] deferral check for ${ group.representative } failed: ${ error instanceof Error ? error.message : String( error ) }\n` );
			} ) );
		}
	}

	/** Whether the browser pass skips `url` for post-capture derivation. */
	defers( url: string ): boolean {
		return this.deferred.has( normalizedUrl( url ) );
	}

	/** A member's slot document, memoized: post-capture derivation reuses the check's document. */
	document( url: string, source: MemberDocumentSource, profile?: RenderProfile ): Promise< MemberDocument > {
		const key = documentKey( url, source, profile );
		let document = this.documents.get( key );
		if ( ! document ) this.documents.set( key, document = source === 'server' ? this.fetch( url ) : this.render( url, profile ) );
		return document;
	}

	/** Drop a consumed document. */
	release( url: string, source: MemberDocumentSource, profile?: RenderProfile ): void {
		this.documents.delete( documentKey( url, source, profile ) );
	}

	/** Stop: no further render starts, running ones end with the browser. */
	async close(): Promise< void > {
		this.closing = true;
		await this.browser?.then( shared => shared.close(), () => {} ).catch( () => {} );
		await Promise.allSettled( this.checks );
	}

	private async check( group: Group, verifier: string ): Promise< void > {
		const { deriveMemberDocument, compareDerivedWithCapture } = await import( './template-clusters.js' );
		const repProcessedHtml = this.capturedHtml( group.representative );
		const realHtml = this.capturedHtml( verifier );
		if ( repProcessedHtml === undefined || realHtml === undefined ) return;
		const derive = ( repServerHtml: string, memberServerHtml: string, memberRenderedHtml?: string ) => deriveMemberDocument( { rewriteDerivedMedia: this.input.rewriteDerivedMedia, memberRenderedHtml, repServerHtml, repProcessedHtml, memberServerHtml, baseUrl: group.representative, templateIdentity: this.input.templateIdentity, styleNormalization: this.input.styleNormalization } );
		let source: MemberDocumentSource | undefined;
		let repServerHtml = '';
		for ( const candidate of [ 'server', 'rendered' ] as const ) {
			const [ rep, member ] = await Promise.all( [ this.document( group.representative, candidate ), this.document( verifier, candidate ) ] );
			if ( ! ( 'html' in rep ) || ! ( 'html' in member ) ) continue;
			const media = this.input.rewriteDerivedMedia ? await this.document( verifier, 'rendered' ) : undefined;
			const derivation = derive( rep.html, member.html, media && 'html' in media ? media.html : undefined );
			if ( derivation.ok && compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml, repServerHtml: rep.html, memberServerHtml: member.html, styleNormalization: this.input.styleNormalization, baseUrl: group.representative } ).equal ) {
				source = candidate;
				repServerHtml = rep.html;
				break;
			}
		}
		if ( ! source ) {
			process.stderr.write( `[template-clusters] deferral: ${ group.representative } did not verify; its members keep browser capture\n` );
			return;
		}
		const startedAt = Date.now();
		const pending = group.members.filter( url => ! this.captured.has( normalizedUrl( url ) ) );
		await mapPool( pending, source === 'rendered' || this.input.rewriteDerivedMedia ? TEMPLATE_DEFERRAL_LIMITS.renderConcurrency : this.input.governors.forOrigin( this.input.sourceUrl ).concurrency, async url => {
			if ( this.captured.has( normalizedUrl( url ) ) ) return;
			const member = await this.document( url, source );
			const media = this.input.rewriteDerivedMedia ? await this.document( url, 'rendered' ) : undefined;
			if ( 'html' in member && derive( repServerHtml, member.html, media && 'html' in media ? media.html : undefined ).ok ) this.deferred.add( normalizedUrl( url ) );
			// Keep the memoized result (including unavailable/declined renders):
			// post-capture derivation must not navigate this member a second time.
		} );
		const deferred = pending.filter( url => this.defers( url ) ).length;
		process.stderr.write( `[template-clusters] deferral: ${ group.representative } verified from ${ source } documents; ${ deferred } of ${ pending.length } pending members deferred, ${ Date.now() - startedAt }ms\n` );
	}

	private capturedHtml( url: string ): string | undefined {
		const file = this.captured.get( normalizedUrl( url ) );
		return file && existsSync( file ) ? readFileSync( file, 'utf8' ) : undefined;
	}

	private async fetch( url: string ): Promise< MemberDocument > {
		try {
			const response = await safeFetch( url, { governors: this.input.governors, timeoutMs: TEMPLATE_DEFERRAL_LIMITS.requestTimeoutMs, attribution: { phase: 'template-clusters', url } } );
			if ( response.status < 200 || response.status >= 300 ) return { unavailable: `HTTP ${ response.status }` };
			return { html: response.body.toString( 'utf8' ) };
		} catch ( error ) {
			return { unavailable: error instanceof Error ? error.message : String( error ) };
		}
	}

	/**
	 * A light render: navigation, bounded settle/media hydration and one DOM read,
	 * without the full capture's probes, width sweep or serialization, which
	 * the representative's captured document already supplies. For runtimes
	 * that rewrite server content per member (a gallery counter, a status line
	 * written from page data), which server HTML cannot carry.
	 */
	private async render( url: string, profile?: RenderProfile ): Promise< MemberDocument > {
		const deadline = Math.min( this.input.deadline ?? Infinity, Date.now() + TEMPLATE_DEFERRAL_LIMITS.renderMs );
		if ( this.closing || deadline <= Date.now() ) return { unavailable: 'light render budget exhausted' };
		const startedAt = Date.now();
		const left = () => Math.max( 1, deadline - Date.now() );
		let context: BrowserContext | undefined;
		try {
			const { connectBrowser, createSourceContext, sourceContextOptions } = await import( './browser-kit/index.js' );
			const { navigateSourceDocument } = await import( './source-navigation.js' );
			this.browser ??= connectBrowser( {} );
			const browser = await withTimeout( this.browser, left(), 'light render browser startup' );
			this.identity ??= sourceContextOptions( browser, this.input.sourceUrl, { publicUrlsOnly: true, governors: this.input.governors } );
			const options = await withTimeout( this.identity, left(), 'light render source identity' );
			context = await withTimeout( createSourceContext( browser, { ...options, ...profile?.identity, viewport: profile?.viewport ?? { width: 1440, height: 900 } }, { governors: this.input.governors, sourceUrl: this.input.sourceUrl } ), left(), 'light render context', late => late.close() );
			const page = await context.newPage();
			const navigation = await navigateSourceDocument( page, url, { timeoutMs: left(), publicUrlsOnly: true, routeScope: this.input.routeScope } );
			if ( navigation.boundary || navigation.redirectedTo ) return { unavailable: `navigation left the route (${ navigation.redirectedTo ?? 'external boundary' })` };
			const status = navigation.response?.status() ?? 0;
			if ( status < 200 || status >= 300 ) return { unavailable: `HTTP ${ status }` };
			await page.waitForLoadState( 'networkidle', { timeout: Math.min( TEMPLATE_DEFERRAL_LIMITS.settleMs, left() ) } ).catch( () => {} );
			// Media may hydrate only on intersection. One bounded viewport walk,
			// inside this same render, keeps a single final DOM serialization.
			if ( this.input.rewriteDerivedMedia ) {
				const hydrationStartedAt = Date.now();
				await withTimeout( page.evaluate( async () => {
					const x = scrollX, y = scrollY;
					try {
						for ( let step = 0; step < 40; step++ ) {
							const top = step * innerHeight * 0.8;
							scrollTo( 0, top );
							await new Promise( resolve => setTimeout( resolve, 100 ) );
							if ( top + innerHeight >= document.documentElement.scrollHeight ) break;
						}
					} finally { scrollTo( x, y ); }
					await new Promise( resolve => setTimeout( resolve, 200 ) );
				} ), left(), 'light render media hydration' );
				process.stderr.write( `[timing] template light-render hydration ${ url } ${ Date.now() - hydrationStartedAt }ms\n` );
			}
			return { html: await withTimeout( page.content(), left(), 'light render DOM read' ) };
		} catch ( error ) {
			return { unavailable: error instanceof Error ? error.message : String( error ) };
		} finally {
			await context?.close().catch( () => {} );
			process.stderr.write( `[timing] template light-render ${ url }${ profile ? ` ${ profile.id }` : '' } ${ Date.now() - startedAt }ms\n` );
		}
	}
}
