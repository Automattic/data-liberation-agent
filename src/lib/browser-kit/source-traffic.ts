import type { APIResponse, BrowserContext, Page, Request, Route } from 'playwright';
import { isSourceTransportThrottle } from '../source-request-governor.js';
import type { SourceRequestAttribution, SourceReplayOutcome, SourceRequestCategory, SourceRequestGovernors } from '../source-request-governor.js';

const traffic = new WeakMap<BrowserContext, { governors: SourceRequestGovernors; origin: string; category?: SourceRequestCategory; phase?: string; device?: string; inFlight: Set<Request> }>();

/** Device checks precede capture. Keep a bounded response handoff for this capture. */
const documents = new WeakMap<SourceRequestGovernors, Map<string, { url: string; status: number; headers: Record<string, string>; body: Buffer }>>();

export function categorizeSourceContext(context: BrowserContext, category: SourceRequestCategory): void {
  const state = traffic.get(context);
  if (state) { state.category = category; state.phase = category; }
}

const pagePhases = new WeakMap<Page, string>();
const replayOutcomes = new WeakMap<Request, SourceReplayOutcome>();

export function attributeSourcePhase(target: BrowserContext | Page, phase: string): void {
  if ('context' in target) pagePhases.set(target as Page, phase);
  else { const state = traffic.get(target); if (state) state.phase = phase; }
}

export function attributeSourceDevice(context: BrowserContext, device: string): void {
  const state = traffic.get(context);
  if (state) state.device = device;
}

function attribution(context: BrowserContext, request?: Request): SourceRequestAttribution {
  const state = traffic.get(context);
  let phase = state?.phase;
  try { if (request) phase = pagePhases.get(request.frame().page()) ?? phase; } catch { /* No page for service workers. */ }
  return { phase, device: state?.device, outcome: request && replayOutcomes.get(request) || 'not_routed', url: request?.url() };
}

/** Misses are counted by the normal source ledger; hits never reach the source. */
export function attributeSourceReplay(context: BrowserContext, request: Request, outcome: SourceReplayOutcome): void {
  replayOutcomes.set(request, outcome);
  if (outcome === 'hit') sourceGovernorFor(context, request.url())?.attributeRequest(attribution(context, request));
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
export async function governSourceContext(context: BrowserContext, governors: SourceRequestGovernors, sourceUrl: string, sourceTelemetry?: import('../../platform/types.js').Platform['sourceTelemetry']): Promise<void> {
  const inFlight = new Set<Request>();
  traffic.set(context, { governors, origin: new URL(sourceUrl).origin, inFlight });
  context.on('response', response => {
    const entry = nativeRequests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    if (entry.status === 429 || entry.status === 503) {
      entry.throttled = true;
      recordInterruptedLoad(response.request());
      entry.governor.observeBrowserOutcome(entry.status, response.headers()['retry-after'], undefined, entry.routeUrl, entry.refusalAdmission, entry.category, entry.attribution);
    } else entry.governor.observeSourceResponse(entry.status, entry.category);
  });
  const finish = (request: Request, failed: boolean) => {
    const entry = nativeRequests.get(request);
    if (!entry) return;
    nativeRequests.delete(request);
    inFlight.delete(request);
    if (failed && !entry.throttled && isSourceTransportThrottle(new Error(request.failure()?.errorText ?? ''))) recordInterruptedLoad(request);
    if (!entry.throttled) entry.governor.observeBrowserOutcome(failed ? undefined : entry.status, undefined,
      failed ? new Error(request.failure()?.errorText ?? '') : undefined, entry.routeUrl, entry.refusalAdmission, entry.category, entry.attribution);
    if (entry.acquired) entry.governor.release();
  };
  // A closing context emits no outcome for requests still in flight: return
  // their admission slots, or a throttled origin stays full for good.
  context.once('close', () => {
    for (const request of inFlight) {
      const entry = nativeRequests.get(request);
      nativeRequests.delete(request);
      if (entry?.acquired) entry.governor.release();
    }
    inFlight.clear();
  });
  context.on('requestfinished', request => finish(request, false));
  context.on('requestfailed', request => finish(request, true));
  if (sourceTelemetry?.length) await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const matches = url.origin === new URL(sourceUrl).origin && sourceTelemetry.some(pattern => {
      if (typeof pattern === 'string') return url.pathname.startsWith(pattern);
      // Stateful flags must not make alternate requests escape the policy.
      return new RegExp(pattern.source, pattern.flags).test(url.pathname);
    });
    if (!matches) return route.fallback();
    governors.forOrigin(sourceUrl).attributeRequest({ ...attribution(context, request), outcome: 'blocked:telemetry' });
    await route.abort('blockedbyclient');
  });
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
  attribution: SourceRequestAttribution;
}>();

/** Preserve native streaming, multiplexing and range requests, even during recovery. */
export async function continueSourceRoute(route: Route, context: BrowserContext, options: Parameters<Route['continue']>[0]): Promise<void> {
  const request = route.request();
  const governor = sourceGovernorFor(context, request.url());
  if (!governor) return route.continue(options);
  const requestAttribution = attribution(context, request);
  await governor.admitSourceRequest();
  const acquired = governor.isBrowserThrottled;
  if (acquired) {
    const abort = new AbortController();
    const close = () => abort.abort();
    context.once('close', close);
    try { await governor.acquire(abort.signal, true); }
    finally { context.off('close', close); }
  }
  traffic.get(context)?.inFlight.add(request);
  nativeRequests.set(request, { governor, acquired, attribution: requestAttribution, category: request.resourceType() === 'document' ? traffic.get(context)?.category ?? 'document' : 'subresource', routeUrl: owningDocumentUrl(request), refusalAdmission: governor.refusalAdmission() });
  try { await route.continue(options); }
  catch (error) {
    traffic.get(context)?.inFlight.delete(request);
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
  const response = await governedResponse(context, url, timeout => context.request.get(url, { ...options, timeout }), 4, url, 'device-check', options.timeout);
  if (options.headers && response.ok()) await rememberSourceDocument(context, url, options.headers, {
    url, status: response.status(), headers: response.headers(), body: await response.body(),
  });
  return response;
}

/**
 * A caller's `timeout` bounds the whole request, origin admission included: a
 * throttled governor must not queue a document past its navigation budget.
 * The task receives the budget left after admission.
 */
async function governedResponse(context: BrowserContext, url: string, task: (timeout: number | undefined) => Promise<APIResponse>, maxAttempts: number, routeUrl: string | undefined = url, category: SourceRequestCategory = traffic.get(context)?.category ?? 'document', timeout?: number, request?: Request): Promise<APIResponse> {
  const governor = sourceGovernorFor(context, url);
  if (!governor) return task(timeout);
  const requestAttribution = { ...attribution(context, request), url };
  const bounded = timeout !== undefined && timeout > 0;
  const deadline = bounded ? Date.now() + timeout : undefined;
  const signal = bounded ? AbortSignal.timeout(timeout) : undefined;
  const result = await governor.run(async attempt => {
    const response = await task(deadline === undefined ? timeout : Math.max(1, deadline - Date.now()));
    const status = response.status();
    const headers = new Headers(response.headersArray().map(({ name, value }): [string, string] => [name, value]));
    if ((status === 429 || status === 503) && attempt < maxAttempts) await response.dispose();
    return { status, headers, response };
  }, { browser: true, maxAttempts, routeUrl, category, signal, attribution: requestAttribution });
  return result.response.response;
}

/** Also used by page-level document interception, which precedes context routing. */
export async function fetchSourceRoute(route: Route, options: NonNullable<Parameters<Route['fetch']>[0]> = {}, maxAttempts = 4, context = route.request().frame().page().context()): Promise<APIResponse> {
  const state = traffic.get(context);
  const url = options.url ?? route.request().url();
  if (!state || new URL(url).origin !== state.origin) return route.fetch(options);
  return governedResponse(context, url, timeout => route.fetch({ ...options, timeout, maxRetries: 0, maxRedirects: 0 }), maxAttempts, owningDocumentUrl(route.request()), route.request().resourceType() === 'document' ? state.category ?? 'document' : 'subresource', options.timeout, route.request());
}
