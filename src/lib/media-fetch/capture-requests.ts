import { sourceRequestContext, type SourceRequestCategory } from '../source-request-governor.js';

/** Native HTTP callers share capture accounting without changing inspection. */
export async function sourceFetch(input: string | URL | Request, init?: RequestInit, category: SourceRequestCategory = 'document'): Promise<Response> {
  const governors = sourceRequestContext.getStore();
  if (!governors) return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return (await governors.forOrigin(url).run(() => fetch(input, init), { category, signal: init?.signal ?? undefined })).response;
}
