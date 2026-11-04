import type { APIResponse, BrowserContext, Page, Request, Route } from 'playwright';
import { isSourceTransportThrottle } from '../source-request-governor.js';
import type { SourceRequestGovernors } from '../source-request-governor.js';

const traffic = new WeakMap<BrowserContext, { governors: SourceRequestGovernors; origin: string }>();

/** Capture-owned state; contexts outside capture and third-party origins stay unchanged. */
export function governSourceContext(context: BrowserContext, governors: SourceRequestGovernors, sourceUrl: string): void {
  traffic.set(context, { governors, origin: new URL(sourceUrl).origin });
  context.on('response', response => {
    const entry = nativeRequests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.governor.observeSourceResponse();
    if (entry.status === 429 || entry.status === 503) {
      entry.throttled = true;
      recordInterruptedLoad(response.request());
      entry.governor.observeBrowserOutcome(entry.status, response.headers()['retry-after'], undefined, entry.routeUrl);
    }
  });
  const finish = (request: Request, failed: boolean) => {
    const entry = nativeRequests.get(request);
    if (!entry) return;
    nativeRequests.delete(request);
    if (failed && !entry.throttled && isSourceTransportThrottle(new Error(request.failure()?.errorText ?? ''))) recordInterruptedLoad(request);
    if (!entry.throttled) entry.governor.observeBrowserOutcome(failed ? undefined : entry.status, undefined,
      failed ? new Error(request.failure()?.errorText ?? '') : undefined, entry.routeUrl, entry.refusalAdmission);
    if (entry.acquired) entry.governor.release();
  };
  context.on('requestfinished', request => finish(request, false));
  context.on('requestfailed', request => finish(request, true));
}

export function sourceGovernorFor(context: BrowserContext, url: string) {
  const state = traffic.get(context);
  return state && new URL(url).origin === state.origin ? state.governors.forOrigin(url) : undefined;
}

const interruptedLoads = new WeakMap<Page, number>();

/** Monotonic per-page generation: a later healthy request cannot erase an earlier loss. */
export function sourceLoadInterruptions(page: Page): number {
  return interruptedLoads.get(page) ?? 0;
}

function recordInterruptedLoad(request: Request): void {
  if (request.isNavigationRequest() || request.method() !== 'GET') return;
  try {
    const page = request.frame().page();
    interruptedLoads.set(page, sourceLoadInterruptions(page) + 1);
  } catch { /* Service workers have no owning page. */ }
}

const nativeRequests = new WeakMap<Request, {
  governor: ReturnType<SourceRequestGovernors['forOrigin']>;
  acquired: boolean;
  refusalAdmission?: number;
  routeUrl?: string;
  status?: number;
  throttled?: boolean;
}>();

/** Preserve native streaming, multiplexing and range requests, even during recovery. */
export async function continueSourceRoute(route: Route, context: BrowserContext, options: Parameters<Route['continue']>[0]): Promise<void> {
  const request = route.request();
  const governor = sourceGovernorFor(context, request.url());
  if (!governor) return route.continue(options);
  if (governor.isConfirmingRefusal || governor.blockedClient) await governor.admitSourceRequest();
  const acquired = governor.isBrowserThrottled;
  if (acquired) {
    const abort = new AbortController();
    const close = () => abort.abort();
    context.once('close', close);
    try { await governor.acquire(abort.signal, true); }
    finally { context.off('close', close); }
  }
  nativeRequests.set(request, { governor, acquired, routeUrl: owningDocumentUrl(request), refusalAdmission: governor.refusalAdmission() });
  try { await route.continue(options); }
  catch (error) {
    if (nativeRequests.delete(request) && acquired) governor.release();
    throw error; // failure-class: operational
  }
}

function owningDocumentUrl(request: Request): string | undefined {
  try { return request.isNavigationRequest() ? request.url() : request.frame().url(); }
  catch { return undefined; /* Service-worker requests may have no frame. */ }
}

/** Document-only re-sampling uses the same context identity and origin admission. */
export async function getSourceResponse(context: BrowserContext, url: string, options: NonNullable<Parameters<BrowserContext['request']['get']>[1]> = {}): Promise<APIResponse> {
  return governedResponse(context, url, () => context.request.get(url, options), 4);
}

async function governedResponse(context: BrowserContext, url: string, task: () => Promise<APIResponse>, maxAttempts: number, routeUrl: string | undefined = url): Promise<APIResponse> {
  const governor = sourceGovernorFor(context, url);
  if (!governor) return task();
  const result = await governor.run(async attempt => {
    const response = await task();
    const status = response.status();
    const headers = new Headers(response.headersArray().map(({ name, value }): [string, string] => [name, value]));
    if ((status === 429 || status === 503) && attempt < maxAttempts) await response.dispose();
    return { status, headers, response };
  }, { browser: true, maxAttempts, routeUrl });
  return result.response.response;
}

/** Also used by page-level document interception, which precedes context routing. */
export async function fetchSourceRoute(route: Route, options: NonNullable<Parameters<Route['fetch']>[0]> = {}, maxAttempts = 4, context = route.request().frame().page().context()): Promise<APIResponse> {
  const state = traffic.get(context);
  const url = options.url ?? route.request().url();
  if (!state || new URL(url).origin !== state.origin) return route.fetch(options);
  return governedResponse(context, url, () => route.fetch({ ...options, maxRetries: 0, maxRedirects: 0 }), maxAttempts, owningDocumentUrl(route.request()));
}
