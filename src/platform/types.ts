// src/platform/types.ts
//
// The public Platform contract. A Platform is the unit of extensibility for
// Data Liberation: it owns its own automatic-detection signals, must be able
// to discover a site's routes, and may optionally customize liberation. Platform
// ids are opaque strings — there is deliberately no platform enum.
//
// This module must stay dependency-free (types only) so consumers can import
// the contract without pulling in adapter internals.
import type { LiberationHooks } from '../adapters/page-actions.js';
import type { CapabilityRule } from '../lib/inspect-rendered.js';
import type { TemplateStyleNormalization } from '../lib/template-groups.js';
import type { HttpAcquisitionProfile } from './acquisition.js';

/** Regex matched against the entire hostname only (never path or query). */
export type PlatformUrlSignal = RegExp;

/**
 * HTTP response-header fingerprint. `header` is matched case-insensitively
 * (per fetch Headers semantics); when `value` is set it must appear as a
 * case-insensitive substring of the header value.
 */
export interface PlatformHttpSignal {
	header: string;
	value?: string;
	/** Human-readable evidence recorded in DetectionResult.signals. */
	signal: string;
}

/** Regex tested against the fetched page source (HTML). */
export interface PlatformSourceSignal {
	pattern: RegExp;
	/** Human-readable evidence recorded in DetectionResult.signals. */
	signal: string;
}

/**
 * Path-probe signal — issues an HTTP HEAD to `path` and matches on status
 * (and optionally the Location header). Probes only fire when URL, header,
 * and source tiers all fail: they pay an extra HTTP round-trip.
 */
export interface PlatformPathProbe {
	/** Path relative to site root, e.g. "/_emdash/admin". */
	path: string;
	/** Status codes that indicate a match (e.g. [302, 401]). */
	expectedStatus: number[];
	/**
	 * Optional substring that must appear in the response Location header.
	 * Tightens the probe against wildcard redirects on non-platform sites.
	 */
	locationContains?: string;
	/** Human-readable evidence recorded in DetectionResult.signals. */
	signal: string;
}

/**
 * Automatic-detection signals owned by a platform. Every tier is optional;
 * a platform with no `detection` can never be auto-detected (only the
 * registered fallback is selected implicitly).
 */
export interface PlatformDetection {
	/** Host suffixes, matched case-insensitively at a DNS label boundary. */
	hosts?: string[];
	/** Advanced host patterns; must match the entire hostname. */
	urlPatterns?: PlatformUrlSignal[];
	/** Response-header fingerprints, tested after the URL fetch. */
	httpSignals?: PlatformHttpSignal[];
	/** Page-source (HTML) markers, tested when no header matched. */
	sourceSignals?: PlatformSourceSignal[];
	/** Last-resort HEAD probes, fired only when every tier above failed. */
	pathProbes?: PlatformPathProbe[];
}

/**
 * A liberatable platform. `discover` is the one required capability —
 * everything else is opt-in.
 */
export interface Platform {
	/** Opaque, stable, unique id (e.g. 'wix', 'godaddy-wm', 'acme-builder'). */
	id: string;
	/** Adapter-owned document namespaces on a shared origin. Omitted means the whole site; never an asset policy. */
	routeScope?( sourceUrl: string ): SiteRouteScope;
	/** Segment-bounded path prefixes on the source origin that are runtime, never site documents. */
	runtimePaths?: string[];
	/** Source-origin telemetry to abort before network admission. Strings are pathname prefixes;
	 * regular expressions match the pathname only (not query or origin). */
	sourceTelemetry?: Array<string | RegExp>;
	/** Automatic-detection signals owned by this platform. */
	detection?: PlatformDetection;
	/** Resolves a link this platform owns but does not serve the site from (an
	 * editor or share link) to the URL capture fetches, before the entry fetch. */
	entry?: PlatformEntryResolver;
	/** Inventory a site: sitemap/routes/navigation. Required. */
	discover( url: string, opts: Record< string, unknown > ): Promise< unknown >;
	/** Resolve an image optimizer/proxy URL to its underlying HTTP(S) resource.
	 * Return undefined for ordinary URLs. Capture owns grouping and byte verification. */
	resolveImageOriginal?( url: string ): string | undefined;
	/** Optional platform-specific hooks applied while liberating each page. */
	liberation?: LiberationHooks;
	/** Optional server-document acquisition profile; rendered fidelity remains separate. */
	acquisition?: HttpAcquisitionProfile;
	/** Adapter-owned aggregation of a page's inline `<style>` blocks for template grouping (#836).
	 * Declared only when the runtime generates per-item page-local CSS; the generic
	 * fingerprint is unchanged for platforms without this hook. */
	templateStyleNormalization?: TemplateStyleNormalization;
	/** Adapter-owned declared template identity, independent of variable item markup.
	 * Unknown documents return undefined and retain the generic fingerprint. */
	templateIdentity?: import('../lib/template-groups.js').TemplateIdentity;
	/** Content the platform publishes as structured data (a feed or API). Template-cluster
	 * capture derives members from it instead of fetching each member's page (#1701). */
	structuredContent?: StructuredContentSource;
	/** Read-only selectors identifying platform-owned application surfaces. */
	inspection?: CapabilityRule[];
	/**
	 * Read-only: the source's engagement counters (views, likes, comments) for
	 * the captured routes, read as data and keyed by route URL. Routes without
	 * counters are left out. See `lib/engagement-stats.ts`.
	 */
	engagementStats?( urls: readonly string[], opts: { deadline?: number } ): Promise< import( '../lib/engagement-stats.js' ).EngagementStatsReading | undefined >;
}

/** Maps a platform-owned link to the site's own entry URL. */
export interface PlatformEntryResolver {
	/** Cheap and pure: does this platform own this link? */
	claims( url: URL ): boolean;
	/** The URL capture should fetch for this link. */
	resolve( url: string ): Promise< string >;
}

/** One content item a platform publishes as structured data. */
export interface StructuredContentEntry {
	permalink: string;
	/** Source slug from the permalink; the export keeps it as the item's slug. */
	slug: string;
	kind: 'post' | 'page';
	title: string;
	contentHtml: string;
	published: string;
	updated: string;
	author: string;
	/** Source taxonomy terms (Blogger labels, tags, categories). */
	terms: string[];
	/** The item's featured image URL, when the source declares one. */
	image?: string;
}

export interface StructuredContentEnumeration {
	entries: StructuredContentEntry[];
	diagnostics: Array< { code: string; url: string; reason: string } >;
}

/**
 * Adapter-owned structured content. Capture stays generic: it adds the
 * entries' permalinks and term archives to the inventory, and uses an entry
 * as a cluster member's content only after the cluster's representative and
 * verification member prove `bodyEquivalent` against their browser captures.
 */
export interface StructuredContentSource {
	/** Enumerate published content. Every source request goes through `governors`. */
	enumerate( sourceUrl: string, options: { governors: import( '../lib/source-request-governor.js' ).SourceRequestGovernors } ): Promise< StructuredContentEnumeration >;
	/** True only when the document's single content slot matches the entry. Fail closed. */
	bodyEquivalent( html: string, entry: StructuredContentEntry ): boolean;
	/** CSS selector of the single content slot `memberDocument` fills. When set, a
	 * synthesized member's cluster key is compared with this slot emptied. */
	contentSlotSelector?: string;
	/** The representative's server document with the member's content in its slot. */
	memberDocument( representativeHtml: string, representative: StructuredContentEntry, member: StructuredContentEntry, options?: { governors: import( '../lib/source-request-governor.js' ).SourceRequestGovernors } ): string | undefined | Promise<string | undefined>;
	/** Per-member head elements, fetched by the adapter and transplanted by identity. */
	memberHeadSlotSelector?: string;
	/** The source URL of a term's archive. */
	termArchiveUrl( term: string, sourceUrl: string ): string;
	/** The term named by a term-archive URL, or undefined for other routes. */
	termName( url: string ): string | undefined;
}

/** Serializable, segment-bounded route ownership; query strings retain document identity. */
export interface SiteRouteScope {
	origin: string;
	pathPrefixes: string[];
	/** Segment-bounded document namespaces excluded from the allowed prefixes; never an asset policy. */
	excludedPathPrefixes?: string[];
	/** Platform query parameters that never select a different document (e.g. referral tags on every link). */
	ignoredQueryParams?: string[];
}

/** Options accepted by {@link registerPlatform}. */
export interface RegisterPlatformOptions {
	/**
	 * Register this platform as THE generic fallback used when detection
	 * returns 'unknown' or names an unregistered platform. At most one
	 * fallback may exist; a fallback must not declare detection signals
	 * (that would be ambiguous with auto-detection).
	 */
	fallback?: boolean;
}
