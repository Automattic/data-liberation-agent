import type { APIResponse, BrowserContext, Page, Request, Route } from 'playwright';
import { isSourceTransportThrottle } from '../source-request-governor.js';
import type { SourceRequestCategory, SourceRequestGovernors } from '../source-request-governor.js';

const traffic = new WeakMap<BrowserContext, { governors: SourceRequestGovernors; origin: string; category?: SourceRequestCategory }>();

/** Device checks precede capture. Keep a bounded response handoff for this capture. */
const documents = new WeakMap<SourceRequestGovernors, Map<string, { url: string; status: number; headers: Record<string, string>; body: Buffer }>>();

export function categorizeSourceContext(context: BrowserContext, category: SourceRequestCategory): void {
  const state = traffic.get(context);
  if (state) state.category = category;
}

async function documentIdentity(context: BrowserContext, url: string, headers: Record<string, string>): Promise<string> {
  const cookies = (await context.cookies(url)).map(({ name, value }) => `${name}=${value}`).join('; ');
  // Transport headers do not select a representation. All other headers, including
  // client hints and authorization, must agree; never equate desktop and phone UAs.
  const identity = Object.entries({ ...headers, cookie: headers.cookie ?? cookies })
    .filter(([name]) => !['accept-encoding', 'host', 'connection', 'content-length'].includes(name) && !name.startsWith(':'))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([url, identity]);
}

export function forgetSourceDocument(governors: SourceRequestGovernors | undefined, url: string): void {
  const cache = governors && documents.get(governors);
  if (cache) for (const [key, response] of cache) if (response.url === url) cache.delete(key);
}

export async function takeSourceDocument(context: BrowserContext, url: string, headers: Record<string, string>) {
  const state = traffic.get(context);
  const cache = state && documents.get(state.governors);
  const key = await documentIdentity(context, url, headers);
  return cache?.get(key);
}

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
      entry.governor.observeBrowserOutcome(entry.status, response.headers()['retry-after'], undefined, entry.routeUrl, undefined, entry.category);
    }
  });
  const finish = (request: Request, failed: boolean) => {
    const entry = nativeRequests.get(request);
    if (!entry) return;
    nativeRequests.delete(request);
    if (failed && !entry.throttled && isSourceTransportThrottle(new Error(request.failure()?.errorText ?? ''))) recordInterruptedLoad(request);
    if (!entry.throttled) entry.governor.observeBrowserOutcome(failed ? undefined : entry.status, undefined,
      failed ? new Error(request.failure()?.errorText ?? '') : undefined, entry.routeUrl, entry.refusalAdmission, entry.category);
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
  category: SourceRequestCategory;
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
  nativeRequests.set(request, { governor, acquired, category: traffic.get(context)?.category ?? (request.resourceType() === 'document' ? 'document' : 'asset-original'), routeUrl: owningDocumentUrl(request), refusalAdmission: governor.refusalAdmission() });
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

export async function rememberSourceDocument(context: BrowserContext, url: string, headers: Record<string, string>, response: { url: string; status: number; headers: Record<string, string>; body: Buffer }): Promise<void> {
  const state = traffic.get(context);
  if (!state || response.status !== 200 || response.headers['set-cookie']) return;
  let cache = documents.get(state.governors);
  if (!cache) documents.set(state.governors, cache = new Map());
  cache.set(await documentIdentity(context, url, headers), response);
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
}

export async function sourceDocumentHtml(context: BrowserContext, url: string, headers: Record<string, string>): Promise<string | undefined> {
  const cached = await takeSourceDocument(context, url, headers);
  if (cached) return cached.body.toString('utf8');
  const response = await getSourceResponse(context, url, { headers, maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
  try { return response.ok() ? await response.text() : undefined; }
  finally { await response.dispose(); }
}

/** Document-only re-sampling uses the same context identity and origin admission. */
export async function getSourceResponse(context: BrowserContext, url: string, options: NonNullable<Parameters<BrowserContext['request']['get']>[1]> = {}): Promise<APIResponse> {
  const response = await governedResponse(context, url, () => context.request.get(url, options), 4, url, 'device-check');
  if (options.headers && response.ok()) await rememberSourceDocument(context, url, options.headers, {
    url, status: response.status(), headers: response.headers(), body: await response.body(),
  });
  return response;
}

async function governedResponse(context: BrowserContext, url: string, task: () => Promise<APIResponse>, maxAttempts: number, routeUrl: string | undefined = url, category: SourceRequestCategory = traffic.get(context)?.category ?? 'document'): Promise<APIResponse> {
  const governor = sourceGovernorFor(context, url);
  if (!governor) return task();
  const result = await governor.run(async attempt => {
    const response = await task();
    const status = response.status();
    const headers = new Headers(response.headersArray().map(({ name, value }): [string, string] => [name, value]));
    if ((status === 429 || status === 503) && attempt < maxAttempts) await response.dispose();
    return { status, headers, response };
  }, { browser: true, maxAttempts, routeUrl, category });
  return result.response.response;
}

/** Also used by page-level document interception, which precedes context routing. */
export async function fetchSourceRoute(route: Route, options: NonNullable<Parameters<Route['fetch']>[0]> = {}, maxAttempts = 4, context = route.request().frame().page().context()): Promise<APIResponse> {
  const state = traffic.get(context);
  const url = options.url ?? route.request().url();
  if (!state || new URL(url).origin !== state.origin) return route.fetch(options);
  return governedResponse(context, url, () => route.fetch({ ...options, maxRetries: 0, maxRedirects: 0 }), maxAttempts, owningDocumentUrl(route.request()), state.category ?? (route.request().resourceType() === 'document' ? 'document' : 'asset-original'));
}
