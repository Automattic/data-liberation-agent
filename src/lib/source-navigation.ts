import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import type { Page, Route, Response } from 'playwright';
import { assertPublicHttpUrl } from './media-fetch/safe-fetch.js';
import { serverRedirectTarget, navigationDocumentUrl } from './screenshot/document-integrity.js';
import { sameHttpSite } from './screenshot/same-origin.js';
import { nonHtmlDocumentError } from './screenshot/absent-document.js';
import { documentRequestUrl } from './url/route-key.js';
import type { SiteRouteScope } from '../platform/types.js';
import { routeInScope, validateRouteScope } from './url/route-scope.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const SOURCE_NAVIGATION_LIMITS = { hops: 4, timeoutMs: 30_000, bytes: 2 * 1024 * 1024, refreshDelayMs: 5_000 } as const;
/** Proven policy/identity failures are permanent; transport failures retain normal navigation retry. */
export class SourceNavigationError extends Error {}
export type RedirectMechanism = 'http' | 'refresh-header' | 'meta-refresh';
interface DocumentResponse { url: string; status: number; headers: Record<string, string>; body: string }
interface RenderedResponse { url: string; status: number; headers: Record<string, string>; body: Buffer }
interface RedirectDeclaration { mechanism: RedirectMechanism; target: string; delayMs: number; reload?: true }
export interface ExternalBoundary {
	schema: 'data-liberation/source-outcome/v1';
	kind: 'external-redirect';
	requestedUrl: string;
	/** Shared-origin ownership boundary, when narrower than the HTTP site. */
	routeScope?: SiteRouteScope;
	initialStatus: number;
	mechanism: RedirectMechanism;
	target: { origin: string; sha256: string; fetched: false };
	evidence: { path: string; sha256: string };
	viewport: number;
	browserProfile: { isMobile: boolean; hasTouch: boolean };
}
export interface BoundaryObservation { requestedUrl: string; responses: DocumentResponse[]; declaration: RedirectDeclaration; elapsedMs: number; routeScope?: SiteRouteScope }
export function navigationDigest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeTarget(url: string, publicUrlsOnly: boolean): URL {
	const target = new URL(url);
	if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new SourceNavigationError('Source redirect has an unsafe scheme or credentials');
	if (publicUrlsOnly) assertPublicHttpUrl(target.href);
	return target;
}

async function readSourceResponse(route: Route, url: string, timeout: number): Promise<{response: DocumentResponse; rendered: RenderedResponse}> {
	const acquired = await route.fetch({url, maxRedirects: 0, maxRetries: 0, timeout});
	try {
		const headers = acquired.headers();
		if (Number(headers['content-length'] ?? 0) > SOURCE_NAVIGATION_LIMITS.bytes) throw new SourceNavigationError('Source document exceeds navigation byte budget');
		const body = await acquired.body();
		if (body.length > SOURCE_NAVIGATION_LIMITS.bytes) throw new SourceNavigationError('Source document exceeds navigation byte budget');
		return {rendered: {url, status: acquired.status(), headers, body}, response: {url, status: acquired.status(), headers: Object.fromEntries(['location', 'refresh', 'content-type'].filter(key => headers[key] !== undefined).map(key => [key, headers[key]!])), body: body.toString('utf8')}};
	} finally { await acquired.dispose(); }
}

function decodedHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key)));
}

function insideTemplate(element: import('domhandler').AnyNode): boolean {
	// Template contents have a document-fragment parent; selector .parents()
	// stops there, while raw ancestry retains the owning template element.
	for (let parent = element.parent; parent; parent = parent.parent) if ('name' in parent && parent.name === 'template') return true;
	return false;
}

/** Same-document reload is a supported cleanup lifecycle, not an alias or drift exemption. */
export async function replaySourceReload(route: Route, url: string, timeoutMs: number = SOURCE_NAVIGATION_LIMITS.timeoutMs): Promise<void> {
	let rendered: RenderedResponse | undefined;
	const inspected = await inspectSourceDocument(url, async (current, timeout) => {
		const acquired = await readSourceResponse(route, current, timeout); rendered = acquired.rendered; return acquired.response;
	}, false, timeoutMs);
	if (inspected.boundary || inspected.finalUrl !== url || inspected.status >= 400 || nonHtmlDocumentError(inspected.response?.headers['content-type'])) throw new Error('Source reload changed its document identity or response outcome');
	await route.fulfill({status: rendered!.status, headers: decodedHeaders(rendered!.headers), body: rendered!.body});
}

/** Interpret only explicit response declarations. A script changing location is not an alias. */
export function documentRedirect(response: DocumentResponse): RedirectDeclaration | undefined {
	if (REDIRECT_STATUSES.has(response.status)) {
		if (!response.headers.location) throw new SourceNavigationError('Source HTTP redirect has no Location');
		return { mechanism: 'http', target: new URL(response.headers.location, response.url).href, delayMs: 0 };
	}
	if (response.status < 200 || response.status >= 300) return;
	const declarations: Array<{mechanism: RedirectMechanism; value: string; baseUrl: string}> = [];
	if (response.headers.refresh) declarations.push({mechanism: 'refresh-header', value: response.headers.refresh, baseUrl: response.url});
	if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? '')) {
		const $ = load(response.body);
		$('meta[http-equiv]').each((_index, element) => {
			if ($(element).attr('http-equiv')?.trim().toLowerCase() === 'refresh' && !insideTemplate(element)) {
				const baseUrl = new URL($('base[href]').filter((_index, base) => !insideTemplate(base)).first().attr('href') ?? response.url, response.url).href;
				declarations.push({mechanism: 'meta-refresh', value: $(element).attr('content') ?? '', baseUrl});
			}
		});
	}
	if (!declarations.length) return;
	if (declarations.length !== 1) throw new SourceNavigationError('Source redirect declarations are ambiguous');
	const {mechanism, value, baseUrl} = declarations[0]!;
	const reload = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*;?\s*$/.exec(value);
	if (reload) {
		const delayMs = Number(reload[1]) * 1000;
		if (!Number.isFinite(delayMs)) throw new SourceNavigationError('Source refresh delay is unsupported');
		// An omitted destination reloads the response document, not its authored
		// resource base. Long reload timers do not delay ordinary baseline capture.
		return {mechanism, target: response.url, delayMs, reload: true};
	}
	const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(value);
	if (!match) throw new SourceNavigationError('Source refresh declaration is unsupported');
	const delayMs = Number(match[1]) * 1000;
	if (delayMs > SOURCE_NAVIGATION_LIMITS.refreshDelayMs) throw new SourceNavigationError('Source refresh exceeds initial navigation delay budget');
	const address = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
	if (!address) throw new SourceNavigationError('Source refresh has no destination');
	return {mechanism, target: new URL(address, baseUrl).href, delayMs};
}

/** Confined raw source evidence retains declarations; public records expose no destination query/path. */
export function storeExternalBoundary(directory: string, observation: BoundaryObservation, viewport: number, browserProfile: ExternalBoundary['browserProfile']): ExternalBoundary {
	const bytes = JSON.stringify(observation);
	const path = `source-outcomes/${randomUUID()}.json`;
	mkdirSync(join(directory, 'source-outcomes'), {recursive: true});
	writeFileSync(join(directory, path), bytes);
	return {schema: 'data-liberation/source-outcome/v1', kind: 'external-redirect', requestedUrl: observation.requestedUrl,
		...(observation.routeScope ? {routeScope: observation.routeScope} : {}),
		initialStatus: observation.responses[0]!.status, mechanism: observation.declaration.mechanism,
		target: {origin: new URL(observation.declaration.target).origin, sha256: navigationDigest(observation.declaration.target), fetched: false},
		evidence: {path, sha256: navigationDigest(bytes)}, viewport, browserProfile};
}

export function boundaryIdentity(outcome: ExternalBoundary): string {
	return JSON.stringify([outcome.requestedUrl, outcome.initialStatus, outcome.mechanism, outcome.target.origin, outcome.target.sha256, outcome.target.fetched, outcome.routeScope]);
}

/** Re-derive the frozen boundary from hashed raw responses, never from the current source. */
export function validateExternalBoundary(outcome: ExternalBoundary, bytes: Buffer): void {
	if (outcome.schema !== 'data-liberation/source-outcome/v1' || outcome.kind !== 'external-redirect' || outcome.target?.fetched !== false ||
		!Number.isFinite(outcome.viewport) || outcome.viewport <= 0 || typeof outcome.browserProfile?.isMobile !== 'boolean' || typeof outcome.browserProfile?.hasTouch !== 'boolean') throw new Error('Invalid external source outcome');
	const evidence = JSON.parse(bytes.toString()) as BoundaryObservation;
	if (evidence.routeScope) validateRouteScope(evidence.routeScope);
	if (JSON.stringify(evidence.routeScope) !== JSON.stringify(outcome.routeScope) || !routeInScope(outcome.requestedUrl, evidence.routeScope)) throw new Error('Source outcome route ownership mismatch');
	if (evidence.requestedUrl !== outcome.requestedUrl || !evidence.responses?.length || evidence.responses.length > SOURCE_NAVIGATION_LIMITS.hops || !Number.isFinite(evidence.elapsedMs) || evidence.elapsedMs < 0 || evidence.elapsedMs > SOURCE_NAVIGATION_LIMITS.timeoutMs) throw new Error('Source outcome identity or navigation budget mismatch');
	safeTarget(evidence.requestedUrl, false);
	let expected = documentRequestUrl(evidence.requestedUrl);
	const visited = new Set<string>();
	let declaration: RedirectDeclaration | undefined;
	for (const response of evidence.responses) {
		if (response.url !== expected || visited.has(expected) || !sameHttpSite(safeTarget(response.url, false).href, evidence.requestedUrl) || !routeInScope(response.url, evidence.routeScope) || Buffer.byteLength(response.body) > SOURCE_NAVIGATION_LIMITS.bytes) throw new Error('Invalid source redirect response chain');
		visited.add(expected);
		declaration = documentRedirect(response);
		if (!declaration) throw new Error('Source outcome lacks a redirect declaration');
		expected = documentRequestUrl(safeTarget(declaration.target, false).href);
		if ((!sameHttpSite(expected, evidence.requestedUrl) || !routeInScope(expected, evidence.routeScope)) && response !== evidence.responses.at(-1)) throw new Error('Source evidence followed an external boundary');
	}
	if (!declaration || (sameHttpSite(declaration.target, evidence.requestedUrl) && routeInScope(declaration.target, evidence.routeScope)) || outcome.initialStatus !== evidence.responses[0]!.status ||
		outcome.mechanism !== declaration.mechanism || outcome.target.origin !== new URL(declaration.target).origin ||
		outcome.target.sha256 !== navigationDigest(declaration.target) || JSON.stringify(evidence.declaration) !== JSON.stringify(declaration)) throw new Error('Source external boundary provenance mismatch');
}

/** The bounded unscheduled-link inspector uses the same response declarations and boundary policy. */
export async function inspectSourceDocument(requestedUrl: string, acquire: (url: string, timeoutMs: number) => Promise<DocumentResponse>, publicUrlsOnly = false, timeoutMs: number = SOURCE_NAVIGATION_LIMITS.timeoutMs, routeScope?: SiteRouteScope): Promise<{status: number; response?: DocumentResponse; finalUrl?: string; boundary?: BoundaryObservation; reload?: RedirectDeclaration}> {
	const deadline = Date.now() + timeoutMs;
	safeTarget(requestedUrl, publicUrlsOnly);
	if (routeScope) validateRouteScope(routeScope);
	if (!routeInScope(requestedUrl, routeScope)) throw new SourceNavigationError('Source document is outside its adapter route scope');
	let current = documentRequestUrl(requestedUrl);
	let finalUrl = requestedUrl;
	const visited = new Set<string>();
	const responses: DocumentResponse[] = [];
	for (let hop = 0; hop < SOURCE_NAVIGATION_LIMITS.hops; hop++) {
		if (visited.has(current)) throw new SourceNavigationError('Source redirect loop');
		visited.add(current);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new SourceNavigationError('Source navigation time budget exhausted');
		const response = await acquire(current, Math.min(5_000, remaining));
		if (Date.now() > deadline) throw new SourceNavigationError('Source navigation time budget exhausted');
		if (response.url !== current || Buffer.byteLength(response.body) > SOURCE_NAVIGATION_LIMITS.bytes) throw new SourceNavigationError('Source response identity or byte budget mismatch');
		const declaration = documentRedirect(response);
		if (!declaration || declaration.reload) return {status: response.status, response, finalUrl, ...(declaration?.reload ? {reload: declaration} : {})};
		responses.push(response);
		const target = safeTarget(declaration.target, publicUrlsOnly);
		if (!sameHttpSite(target.href, requestedUrl) || !routeInScope(target.href, routeScope)) return {status: responses[0]!.status, boundary: {requestedUrl, responses, declaration, elapsedMs: Date.now() - (deadline - timeoutMs), ...(routeScope ? {routeScope} : {})}};
		current = documentRequestUrl(target.href);
		finalUrl = target.href;
	}
	throw new SourceNavigationError('Source redirect hop budget exhausted');
}

/**
 * Inspect the actual main-document response before it executes. Same-origin
 * redirects retain browser URL identity; declarations are acquired through
 * one bounded manual chain (browser HTTP follow-ups bypass route handlers).
 * External declarations end at an inert
 * document, before any destination request, and are returned as evidence rather
 * than as portable HTML. Unknown script navigation is never classified as a redirect.
 * A script reload of the delivered document is its own lifecycle, replayed through
 * the bounded reload acquisition that baseline capture also accepts.
 */
export async function navigateSourceDocument(page: Page, requestedUrl: string, options: {timeoutMs?: number; publicUrlsOnly?: boolean; routeScope?: SiteRouteScope} = {}): Promise<{response: Response | null; navigationUrl?: string; redirectedTo?: string; boundary?: BoundaryObservation}> {
	const deadline = Date.now() + (options.timeoutMs ?? SOURCE_NAVIGATION_LIMITS.timeoutMs);
	const publicOnly = options.publicUrlsOnly ?? false;
	safeTarget(requestedUrl, publicOnly);
	let expected = documentRequestUrl(requestedUrl);
	let boundary: BoundaryObservation | undefined;
	let redirectedTo: string | undefined;
	let finalUrl = requestedUrl;
	let failure: Error | undefined;
	let rendered: RenderedResponse | undefined;
	let acquired = false;
	let delivered = false;
	let executedDocument: string | undefined;
	let scriptReloads = 0;
	const guard = async (route: Route) => {
		const request = route.request();
		if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) { await route.fallback(); return; }
		try {
			const address = documentRequestUrl(request.url());
			if (delivered && address === executedDocument && request.method() === 'GET') {
				if (scriptReloads++ >= SOURCE_NAVIGATION_LIMITS.hops) throw new SourceNavigationError('Source reload budget exhausted');
				await replaySourceReload(route, address, Math.max(1, deadline - Date.now()));
				return;
			}
			if (address !== expected || delivered) throw new SourceNavigationError('Unexplained source main-frame navigation');
			if (!acquired) {
				const acquireResponse = async (current: string, timeout: number) => {
					const acquired = await readSourceResponse(route, current, timeout); rendered = acquired.rendered; return acquired.response;
				};
				let inspected = await inspectSourceDocument(requestedUrl, acquireResponse, publicOnly, Math.max(1, deadline - Date.now()), options.routeScope);
				// Settle imminent declared reloads before serialization. This uses
				// the same bounded acquisition as reload recovery; it cannot turn a
				// refreshed response into a redirect alias or an external outcome.
				let reloads = 0;
				while (inspected.reload && inspected.reload.delayMs <= SOURCE_NAVIGATION_LIMITS.refreshDelayMs) {
					if (reloads++ >= SOURCE_NAVIGATION_LIMITS.hops || Date.now() + inspected.reload.delayMs >= deadline) throw new SourceNavigationError('Source reload budget exhausted');
					if (inspected.reload.delayMs) await new Promise(resolve => setTimeout(resolve, inspected.reload!.delayMs));
					const refreshed = await inspectSourceDocument(inspected.finalUrl!, acquireResponse, publicOnly, Math.max(1, deadline - Date.now()), options.routeScope);
					if (refreshed.boundary || refreshed.finalUrl !== inspected.finalUrl) throw new SourceNavigationError('Source reload changed its document identity or response outcome');
					inspected = refreshed;
				}
				acquired = true;
				boundary = inspected.boundary;
				finalUrl = inspected.finalUrl ?? requestedUrl;
				const notHtml = inspected.response && inspected.status < 400 ? nonHtmlDocumentError(inspected.response.headers['content-type']) : undefined;
				if (notHtml) throw new SourceNavigationError(notHtml);
				if (inspected.response) {
					// Ordinary captures retain the requested route while final URL/base
					// remain resource facts. An adapter-owned namespace additionally
					// dedupes exact addresses only when this response chain proves an alias.
					redirectedTo = options.routeScope && documentRequestUrl(requestedUrl) !== documentRequestUrl(finalUrl)
						? finalUrl : serverRedirectTarget(requestedUrl, finalUrl);
				}
			}
			delivered = true;
			if (boundary) await route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>Observed external boundary</title>'});
			else if (redirectedTo || address !== rendered!.url) {
				// No scripts from a different document execute under the requested URL.
				await route.fulfill({status: rendered!.status, contentType: rendered!.headers['content-type'] ?? 'text/html', body: ''});
			} else {
				executedDocument = address;
				await route.fulfill({status: rendered!.status, headers: decodedHeaders(rendered!.headers), body: rendered!.body});
			}
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			await route.abort('blockedbyclient').catch(() => {});
		}
	};
	await page.route('**/*', guard);
	try {
		let response = await page.goto(requestedUrl, {waitUntil: 'load', timeout: Math.max(1, deadline - Date.now())});
		if (failure) throw failure;
		if (!boundary && !redirectedTo && rendered && finalUrl !== requestedUrl) {
			expected = rendered.url;
			delivered = false;
			response = await page.goto(finalUrl, {waitUntil: 'load', timeout: Math.max(1, deadline - Date.now())});
			if (failure) throw failure;
		}
		return {response, ...(rendered && !boundary ? {navigationUrl: navigationDocumentUrl(requestedUrl, finalUrl, finalUrl !== requestedUrl)} : {}), ...(boundary ? {boundary} : {}), ...(redirectedTo ? {redirectedTo} : {})};
	} catch (error) { throw failure ?? error; }
	finally { await page.unroute('**/*', guard); }
}
