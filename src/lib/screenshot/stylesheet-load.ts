import type { Page, Request } from 'playwright';

export const STYLESHEET_LOAD_FAILURE = 'stylesheet-load failed';
const loads = new WeakMap<Page, { failures: Map<string, string>; missing: Set<string> }>();
/** A missing stylesheet is the source's own published state, not a refused render. */
const SOURCE_MISSING = new Set([404, 410]);
/** Transport errors that are the source's refusal. Client policy outcomes
 * (`ERR_FAILED` local-network/CORS checks, `ERR_BLOCKED_BY_CLIENT`, navigation
 * `ERR_ABORTED`) are capture-side and are not source refusals. */
const SOURCE_TRANSPORT_REFUSAL = /net::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT|FAILED)|EMPTY_RESPONSE|TIMED_OUT|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b/;

/** Context init script: remember link elements whose stylesheet load errored. */
export function observeStylesheetLoadErrors(): void {
	const failed = new WeakSet<HTMLLinkElement>();
	(globalThis as typeof globalThis & { __captureFailedStylesheets?: WeakSet<HTMLLinkElement> }).__captureFailedStylesheets = failed;
	document.addEventListener('error', event => {
		if (event.target instanceof HTMLLinkElement && event.target.relList.contains('stylesheet')) failed.add(event.target);
	}, true);
}

/** Observe the render's requests, never the independent archive acquisition. */
export function trackStylesheetLoads(page: Page): void {
	const failures = new Map<string, string>();
	const missing = new Set<string>();
	loads.set(page, { failures, missing });
	const record = (request: Request, reason: string) => {
		// A redirect's final URL is not necessarily the document link's href.
		for (let current: Request | null = request; current; current = current.redirectedFrom()) failures.set(current.url(), reason);
	};
	page.on('response', response => {
		if (response.request().resourceType() !== 'stylesheet' || response.status() < 400) return;
		if (SOURCE_MISSING.has(response.status())) missing.add(response.request().url());
		else record(response.request(), `HTTP ${response.status()}`);
	});
	page.on('requestfailed', request => {
		if (request.resourceType() !== 'stylesheet' || missing.has(request.url())) return;
		const reason = request.failure()?.errorText ?? '';
		if (SOURCE_TRANSPORT_REFUSAL.test(reason)) record(request, reason);
	});
}

export async function stylesheetLoadFailure(page: Page): Promise<string | undefined> {
	const tracked = loads.get(page);
	if (!tracked) return undefined;
	const { failures, missing } = tracked;
	// Every page stylesheet request reports a response or a failure. With no
	// refused sheet there is nothing to attribute, so healthy routes skip the DOM.
	if (!failures.size) return undefined;
	const linked = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]'))
		.filter(link => !link.hasAttribute('disabled') && !link.disabled && (!link.media || matchMedia(link.media).matches)
			&& !(link.relList.contains('alternate') && (!link.sheet || link.sheet.disabled)))
		.map(link => ({ url: link.href, applied: !!link.sheet && !link.sheet.disabled && !(globalThis as typeof globalThis & { __captureFailedStylesheets?: WeakSet<HTMLLinkElement> }).__captureFailedStylesheets?.has(link) })));
	// A refused request counts only when the document's link is still unapplied:
	// an unrelated later request for the same URL (probe, reload) does not unstyle
	// a render whose sheet did load.
	const errors = linked.filter(link => !missing.has(link.url) && failures.has(link.url) && !link.applied).map(link => `${link.url}: ${failures.get(link.url)}`);
	return errors.length ? `${STYLESHEET_LOAD_FAILURE}: ${errors.join('; ')}` : undefined;
}
