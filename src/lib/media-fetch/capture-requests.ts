import { AsyncLocalStorage } from 'node:async_hooks';
import { governedAcquisition, type SourceRequestCategory, type SourceRequestGovernors } from '../source-request-governor.js';
import type { DownloadResult } from './media.js';

/** Capture-local file reuse, including concurrent original requests. No byte cache. */
export const captureRequests = new AsyncLocalStorage<{
  governors: SourceRequestGovernors;
  originals: Map<string, Promise<DownloadResult>>;
}>();

/** Native HTTP callers share capture accounting without changing inspection. */
export async function sourceFetch(input: string | URL | Request, init?: RequestInit, category: SourceRequestCategory = 'document'): Promise<Response> {
  const state = captureRequests.getStore();
  if (!state || governedAcquisition.getStore()) return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return (await state.governors.forOrigin(url).run(() => fetch(input, init), { category, signal: init?.signal ?? undefined })).response;
}
