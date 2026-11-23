import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { mapPool, withTimeout } from './concurrency.js';
import { interactionReportMismatch, projectInteractionReport } from './interaction-projection.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { pathWithin } from './portable-assets.js';
import { templateVerificationMember } from './route-budget.js';
import { normalizedUrl } from './url/route-key.js';
import type { SiteRouteScope } from '../platform/types.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';
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
 * cluster or a gated member takes the ordinary full capture. Tail members
 * wait outside the browser pool until the cluster check has settled.
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

/** A captured route's document profiles, as the browser pass stored them. */
export type CapturedProfiles = NonNullable< import('./screenshot/manifest-queue.js').ManifestEntry['profiles'] >;

/**
 * A representative profile document post-capture derivation also derives for
 * every member (the phone document of a dual-device capture). `server` is set
 * when the profile's identity received its own server document: the member's
 * profile document then derives from that pair, with a light render as that
 * profile for its runtime media.
 */
interface ProfileDocument {
	repProcessedHtml: string;
	render: RenderProfile;
	server?: { userAgent: string; repServerHtml: string };
}

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

export class TemplateClusterDeferral {
	private readonly captured = new Map< string, string >();
	private readonly interactions = new Map< string, InteractionStatesReport >();
	private readonly capturedProfiles = new Map< string, CapturedProfiles >();
	private readonly started = new Set< string >();
	private readonly settled = new Set< string >();
	private readonly activeChecks = new Set< Promise< void > >();
	private readonly deferred = new Set< string >();
	private readonly documents = new Map< string, Promise< MemberDocument > >();
	private readonly checks: Promise< void >[] = [];
	private readonly prefetchQueue: string[] = [];
	private prefetching = 0;
	private browser?: Promise< Browser >;
	private identity?: Promise< BrowserContextOptions >;
	private closing = false;

	constructor( private readonly input: TemplateClusterDeferralInput, private readonly groups: () => readonly Group[] ) {}

	/** The browser pass captured `url`; `htmlPath` is its desktop document. */
	routeCaptured( url: string, htmlPath: string | undefined, interactions?: InteractionStatesReport, profiles?: CapturedProfiles ): void {
		const file = this.outputFile( htmlPath );
		if ( ! file ) return;
		this.captured.set( normalizedUrl( url ), file );
		if ( interactions ) this.interactions.set( normalizedUrl( url ), interactions );
		if ( profiles ) this.capturedProfiles.set( normalizedUrl( url ), profiles );
		for ( const group of this.groups() ) {
			if ( group.size < 2 || this.started.has( group.representative ) ) continue;
			// The member route ranking admits beside the representative, and the one
			// post-capture derivation verifies against: any other member is not on
			// disk until the browser reaches the cluster's tail, so its check (and
			// the light renders a runtime-rewritten cluster needs) would never run.
			const verifier = templateVerificationMember( group.members, group.representative );
			if ( ! verifier || ! this.captured.has( normalizedUrl( group.representative ) ) || ! this.captured.has( normalizedUrl( verifier ) ) ) continue;
			this.started.add( group.representative );
			const check = this.check( group, verifier ).catch( error => {
				process.stderr.write( `[template-clusters] deferral check for ${ group.representative } failed: ${ error instanceof Error ? error.message : String( error ) }\n` );
			} ).finally( () => {
				this.settled.add( group.representative );
				this.activeChecks.delete( check );
			} );
			this.activeChecks.add( check );
			this.checks.push( check );
		}
	}

	/** Whether the browser pass skips `url` for post-capture derivation. */
	defers( url: string ): boolean {
		return this.deferred.has( normalizedUrl( url ) );
	}

	/** Tail members wait for their seeds and the resulting verification check. */
	pending( url: string ): boolean {
		const key = normalizedUrl( url );
		if ( this.captured.has( key ) ) return false;
		return this.groups().some( group => group.size >= 2 && ! this.settled.has( group.representative )
			&& normalizedUrl( group.representative ) !== key
			&& normalizedUrl( templateVerificationMember( group.members, group.representative ) ?? group.representative ) !== key
			&& group.members.some( member => normalizedUrl( member ) === key ) );
	}

	/** No promise when seeds failed to capture: callers may fall back to browser capture once idle. */
	waitForCheck(): Promise< void > | undefined {
		return this.activeChecks.size ? Promise.race( this.activeChecks ) : undefined;
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
		const derive = ( repServerHtml: string, memberServerHtml: string, memberRenderedHtml?: string, documents: { repProcessedHtml?: string; clusterKeyDocuments?: { repServerHtml: string; memberServerHtml: string } } = {} ) => deriveMemberDocument( { rewriteDerivedMedia: this.input.rewriteDerivedMedia, memberRenderedHtml, repServerHtml, repProcessedHtml, memberServerHtml, baseUrl: group.representative, templateIdentity: this.input.templateIdentity, styleNormalization: this.input.styleNormalization, ...documents } );
		let source: MemberDocumentSource | undefined;
		let repServerHtml = '';
		let verifiedHtml = '';
		for ( const candidate of [ 'server', 'rendered' ] as const ) {
			const [ rep, member ] = await Promise.all( [ this.document( group.representative, candidate ), this.document( verifier, candidate ) ] );
			if ( ! ( 'html' in rep ) || ! ( 'html' in member ) ) continue;
			const media = this.input.rewriteDerivedMedia ? await this.document( verifier, 'rendered' ) : undefined;
			const derivation = derive( rep.html, member.html, media && 'html' in media ? media.html : undefined );
			if ( derivation.ok && compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml, repServerHtml: rep.html, memberServerHtml: member.html, styleNormalization: this.input.styleNormalization, baseUrl: group.representative } ).equal ) {
				source = candidate;
				repServerHtml = rep.html;
				verifiedHtml = derivation.html;
				break;
			}
		}
		if ( ! source ) {
			process.stderr.write( `[template-clusters] deferral: ${ group.representative } did not verify; its members keep browser capture\n` );
			return;
		}
		// Export wires menus, dialogs and galleries from the interaction report,
		// which derivation projects from the representative's. A deferred member
		// has no capture of its own, so the projection must reproduce the
		// verifier's. The verdict above still stands: post-capture derivation
		// derives the members the browser budget omits.
		const interactionMismatch = interactionReportMismatch( projectInteractionReport( repProcessedHtml, verifiedHtml, this.interactions.get( normalizedUrl( group.representative ) ) ), this.interactions.get( normalizedUrl( verifier ) ) );
		if ( interactionMismatch ) {
			process.stderr.write( `[template-clusters] deferral: ${ group.representative } verified from ${ source } documents; interaction states did not verify (${ interactionMismatch }), so members keep browser capture
` );
			if ( source === 'rendered' || this.input.rewriteDerivedMedia ) this.prefetchRenders( group );
			return;
		}
		const startedAt = Date.now();
		// A deferred member leaves the browser pass, so every document
		// post-capture derivation derives for it must pass here first.
		const profiles = await this.profileDocuments( group.representative, source === 'server' ? repServerHtml : undefined );
		const pending = group.members.filter( url => ! this.captured.has( normalizedUrl( url ) ) );
		await mapPool( pending, source === 'rendered' || this.input.rewriteDerivedMedia ? TEMPLATE_DEFERRAL_LIMITS.renderConcurrency : this.input.governors.forOrigin( this.input.sourceUrl ).concurrency, async url => {
			if ( this.captured.has( normalizedUrl( url ) ) ) return;
			const member = await this.document( url, source );
			const media = this.input.rewriteDerivedMedia ? await this.document( url, 'rendered' ) : undefined;
			const mediaHtml = media && 'html' in media ? media.html : undefined;
			if ( ! ( 'html' in member ) || ! derive( repServerHtml, member.html, mediaHtml ).ok ) return;
			for ( const profile of profiles ) {
				if ( ! profile.server ) {
					if ( ! derive( repServerHtml, member.html, mediaHtml, { repProcessedHtml: profile.repProcessedHtml } ).ok ) return;
					continue;
				}
				const [ memberServer, render ] = await Promise.all( [
					this.fetch( url, profile.server.userAgent ),
					this.input.rewriteDerivedMedia ? this.document( url, 'rendered', profile.render ) : undefined,
				] );
				if ( ! ( 'html' in memberServer ) ) return;
				const clusterKeyDocuments = { repServerHtml, memberServerHtml: member.html };
				if ( ! derive( profile.server.repServerHtml, memberServer.html, render && 'html' in render ? render.html : undefined, { repProcessedHtml: profile.repProcessedHtml, clusterKeyDocuments } ).ok ) return;
			}
			this.deferred.add( normalizedUrl( url ) );
			// Keep the memoized results (including unavailable/declined renders):
			// post-capture derivation must not navigate this member a second time.
		} );
		const deferred = pending.filter( url => this.defers( url ) ).length;
		process.stderr.write( `[template-clusters] deferral: ${ group.representative } verified from ${ source } documents; ${ deferred } of ${ pending.length } pending members deferred, ${ Date.now() - startedAt }ms\n` );
	}

	/**
	 * Light renders of a verified cluster's members the browser pass has not
	 * captured, started beside it without holding those members back. Light
	 * renders stop at the capture deadline, which post-capture derivation
	 * usually reaches after the browser pass: rendered now, the documents are
	 * memoized for the members its budget omits. The browser takes members in
	 * ranking order, so renders start from the other end. One queue serves
	 * every cluster, within the light-render concurrency.
	 */
	private prefetchRenders( group: Group ): void {
		this.prefetchQueue.push( ...group.members.filter( url => ! this.captured.has( normalizedUrl( url ) ) ).reverse() );
		this.drainPrefetch();
	}

	private drainPrefetch(): void {
		while ( this.prefetching < TEMPLATE_DEFERRAL_LIMITS.renderConcurrency && this.prefetchQueue.length ) {
			const url = this.prefetchQueue.shift()!;
			if ( this.closing || this.captured.has( normalizedUrl( url ) ) ) continue;
			this.prefetching++;
			this.checks.push( this.document( url, 'rendered' ).then( () => {}, () => {} ).finally( () => {
				this.prefetching--;
				this.drainPrefetch();
			} ) );
		}
	}

	/**
	 * The representative's profile documents post-capture derivation derives
	 * members for: each non-desktop captured document, with its own server
	 * pair where the profile's identity received a different server document.
	 * Without `repServerHtml` (a cluster verified from rendered documents),
	 * profiles derive from the desktop pair.
	 */
	private async profileDocuments( representative: string, repServerHtml: string | undefined ): Promise< ProfileDocument[] > {
		const { compareServerHtml } = await import( './screenshot/device-mode.js' );
		const servers = new Map< string, Promise< string | undefined > >();
		const documents: ProfileDocument[] = [];
		for ( const [ key, profile ] of Object.entries( this.capturedProfiles.get( normalizedUrl( representative ) ) ?? {} ) ) {
			const file = key === 'desktop' ? undefined : this.outputFile( profile.html );
			if ( ! file || ! existsSync( file ) ) continue;
			const { userAgent } = profile;
			if ( repServerHtml !== undefined && userAgent && ! servers.has( userAgent ) ) {
				servers.set( userAgent, this.fetch( representative, userAgent ).then( fetched => 'html' in fetched && compareServerHtml( repServerHtml, fetched.html ) === 'different' ? fetched.html : undefined ) );
			}
			const server = userAgent ? await servers.get( userAgent ) : undefined;
			documents.push( {
				repProcessedHtml: readFileSync( file, 'utf8' ),
				render: { id: key, identity: profile.identity, viewport: profile.viewport },
				...( server !== undefined && userAgent ? { server: { userAgent, repServerHtml: server } } : {} ),
			} );
		}
		return documents;
	}

	private outputFile( path: string | undefined ): string | undefined {
		const file = path ? resolve( this.input.outputDir, path ) : undefined;
		return file && pathWithin( this.input.outputDir, file ) ? file : undefined;
	}

	private capturedHtml( url: string ): string | undefined {
		const file = this.captured.get( normalizedUrl( url ) );
		return file && existsSync( file ) ? readFileSync( file, 'utf8' ) : undefined;
	}

	private async fetch( url: string, userAgent?: string ): Promise< MemberDocument > {
		try {
			const response = await safeFetch( url, { governors: this.input.governors, timeoutMs: TEMPLATE_DEFERRAL_LIMITS.requestTimeoutMs, attribution: { phase: 'template-clusters', url }, ...( userAgent ? { headers: { 'User-Agent': userAgent } } : {} ) } );
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
		// A light render loads the member's full runtime and media beside the
		// browser pass. While the source's throttle episode paces requests,
		// renders would queue ahead of the browser pass's own navigations, so
		// they wait it out. Pacing that has become persistent (the source
		// throttled again after recovering) or outlasts the render budget
		// leaves the members to browser capture.
		const governor = this.input.governors.forOrigin( this.input.sourceUrl );
		if ( governor.isPaced && ! this.closing && ! await governor.awaitUnpaced( Math.min( this.input.deadline ?? Infinity, Date.now() + TEMPLATE_DEFERRAL_LIMITS.renderMs ) ) ) return { unavailable: 'source throttled; light renders yield to the browser pass' };
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
