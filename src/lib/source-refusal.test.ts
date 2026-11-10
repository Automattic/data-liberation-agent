import { expect, it, vi } from 'vitest';
import { SourceRequestGovernor, isSourceTransportThrottle } from './source-request-governor.js';

it('uses one classifier with a narrower refusal predicate', () => {
 expect(isSourceTransportThrottle({ cause: { code: 'ECONNRESET' } }, true)).toBe(true);
 expect(isSourceTransportThrottle(new Error('CONTENT_LENGTH_MISMATCH'))).toBe(true);
 expect(isSourceTransportThrottle(new Error('CONTENT_LENGTH_MISMATCH'), true)).toBe(false);
 expect(isSourceTransportThrottle(new Error('Timeout'), true)).toBe(false);
});

it('requires earlier responses, consecutive refusals and distinct document paths', async () => {
 vi.useFakeTimers();
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  const fail = async (path: string) => {
   await vi.advanceTimersByTimeAsync(1000);
   governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), `http://example.test/${path}`, governor.refusalAdmission());
  };
  for (let i = 0; i < 4; i++) await fail(String(i));
  expect(governor.isConfirmingRefusal).toBe(false);
  governor.observeBrowserOutcome(200);
  for (let i = 0; i < 4; i++) await fail('a');
  expect(governor.isConfirmingRefusal).toBe(false);
  governor.observeBrowserOutcome(200);
  await fail('b');
  expect(governor.isConfirmingRefusal).toBe(false);
  expect(governor.blockedClient).toBeUndefined();
 } finally { vi.useRealTimers(); }
});

async function persistentRefusals(governor: SourceRequestGovernor) {
 governor.observeBrowserOutcome(200);
 governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), 'http://example.test/a');
 for (const path of ['a', 'a', 'b']) {
  await vi.advanceTimersByTimeAsync(1000);
  governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), `http://example.test/${path}`, governor.refusalAdmission());
 }
}

it('ignores stale burst failures even after the throttle pause', async () => {
 vi.useFakeTimers();
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  governor.observeBrowserOutcome(200);
  const admission = governor.refusalAdmission();
  governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), 'http://example.test/a', admission);
  await vi.advanceTimersByTimeAsync(1000);
  const stale = governor.refusalAdmission();
  for (const path of ['a', 'b', 'c', 'd']) {
   governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), `http://example.test/${path}`, stale);
   await vi.advanceTimersByTimeAsync(1000);
  }
  expect(governor.isConfirmingRefusal).toBe(false);
  expect(governor.hasSustainedRefusal).toBe(false);
 } finally { vi.useRealTimers(); }
});

it('shares escalating confirmation and rejects queued admission only after the entire window', async () => {
 vi.useFakeTimers();
 const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValue({ cause: { code: 'ECONNRESET' } });
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  await persistentRefusals(governor);
  const admission = expect(governor.admitSourceRequest()).rejects.toMatchObject({ code: 'source_blocked_client' });
  await vi.advanceTimersByTimeAsync(20000);
  expect(governor.blockedClient).toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(40000);
  await admission;
  expect(probe).toHaveBeenCalledTimes(4);
  expect(governor.blockedClient?.evidence.requestsBeforeFirstRefusal).toBe(1);
  expect(governor.blockedClient?.evidence.requestCounts).toEqual({ document: 5, 'device-check': 0, 'asset-original': 0, subresource: 0, 'refusal-probe': 4, retry: 0 });
  expect(Object.values(governor.stats().requestCounts).reduce((a, b) => a + b, 0)).toBe(governor.stats().requests);
 } finally { probe.mockRestore(); vi.useRealTimers(); }
});

it('resumes on any HTTP answer during confirmation', async () => {
 vi.useFakeTimers();
 const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce({ code: 'ECONNRESET' }).mockResolvedValue(new Response(null, { status: 503 }));
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  await persistentRefusals(governor);
  const admission = governor.admitSourceRequest();
  await vi.advanceTimersByTimeAsync(8000);
  await admission;
  expect(governor.blockedClient).toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(2);
 } finally { probe.mockRestore(); vi.useRealTimers(); }
});

it('ends on documents the source keeps throttling after backoff, whatever its subresources do', async () => {
 vi.useFakeTimers();
 const probe = vi.spyOn(globalThis, 'fetch');
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  governor.observeBrowserOutcome(200);
  governor.observeBrowserOutcome(429, '1', undefined, 'http://example.test/products/a');
  for (const path of ['a', 'b', 'c']) {
   await vi.advanceTimersByTimeAsync(1000);
   governor.observeBrowserOutcome(200, undefined, undefined, 'http://example.test/', undefined, 'subresource');
   governor.observeBrowserOutcome(429, '1', undefined, `http://example.test/products/${path}`, governor.refusalAdmission());
  }
  await expect(governor.admitSourceRequest()).rejects.toMatchObject({ code: 'source_blocked_client', evidence: { refusal: 'throttle' } });
  expect(probe).not.toHaveBeenCalled();
 } finally { probe.mockRestore(); vi.useRealTimers(); }
});
