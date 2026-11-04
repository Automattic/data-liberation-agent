import type { APIResponse, BrowserContext, Route } from 'playwright';
import type { SourceRequestGovernors } from '../source-request-governor.js';

const traffic = new WeakMap<BrowserContext, { governors: SourceRequestGovernors; origin: string }>();

/** Capture-owned state; contexts outside capture and third-party origins stay unchanged. */
export function governSourceContext(context: BrowserContext, governors: SourceRequestGovernors, sourceUrl: string): void {
  traffic.set(context, { governors, origin: new URL(sourceUrl).origin });
}

export function sourceGovernorFor(context: BrowserContext, url: string) {
  const state = traffic.get(context);
  return state && new URL(url).origin === state.origin ? state.governors.forOrigin(url) : undefined;
}

export function hasSourceGovernor(route: Route, context: BrowserContext): boolean {
  return !!sourceGovernorFor(context, route.request().url());
}

/** Document-only re-sampling uses the same context identity and origin admission. */
export async function getSourceResponse(context: BrowserContext, url: string, options: NonNullable<Parameters<BrowserContext['request']['get']>[1]> = {}): Promise<APIResponse> {
  return governedResponse(context, url, () => context.request.get(url, options), 4);
}

async function governedResponse(context: BrowserContext, url: string, task: () => Promise<APIResponse>, maxAttempts: number): Promise<APIResponse> {
  const governor = sourceGovernorFor(context, url);
  if (!governor) return task();
  const result = await governor.run(async attempt => {
    const response = await task();
    const status = response.status();
    const headers = new Headers(response.headers());
    if ((status === 429 || status === 503) && attempt < maxAttempts) await response.dispose();
    return { status, headers, response };
  }, { browser: true, maxAttempts });
  return result.response.response;
}

/** Also used by page-level document interception, which precedes context routing. */
export async function fetchSourceRoute(route: Route, options: NonNullable<Parameters<Route['fetch']>[0]> = {}, maxAttempts = 4, context = route.request().frame().page().context()): Promise<APIResponse> {
  const state = traffic.get(context);
  const url = options.url ?? route.request().url();
  if (!state || new URL(url).origin !== state.origin) return route.fetch(options);
  return governedResponse(context, url, () => route.fetch({ ...options, maxRetries: 0, maxRedirects: 0 }), maxAttempts);
}
