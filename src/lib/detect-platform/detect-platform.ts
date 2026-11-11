import { sourceFetch as fetch } from '../media-fetch/capture-requests.js';
import { SOURCE_USER_AGENT } from '../browser-kit/source-identity.js';
import { registeredPlatforms } from '../../platform/registry.js';
import type { Platform, PlatformHttpSignal, PlatformPathProbe, PlatformSourceSignal } from '../../platform/types.js';
import '../../platform/builtins.js';

export interface DetectionResult {
  platform: string;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

export interface FullDetectionResult extends DetectionResult {
  url: string;
}

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function matchesHost(platform: Platform, hostname: string): boolean {
  return (platform.detection?.hosts ?? []).some(host => {
    const suffix = host.toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }) || (platform.detection?.urlPatterns ?? []).some(pattern => {
    pattern.lastIndex = 0;
    const match = pattern.exec(hostname);
    return match?.index === 0 && match[0].length === hostname.length;
  });
}

export function detectFromUrl(url: string): string | null {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return null;
  return registeredPlatforms().find(platform => matchesHost(platform, hostname))?.id ?? null;
}

function headerSignals(platform: Platform, headers: Headers): string[] {
  return (platform.detection?.httpSignals ?? []).filter(sig => {
    const value = headers.get(sig.header);
    return value && (!sig.value || value.toLowerCase().includes(sig.value.toLowerCase()));
  }).map(sig => sig.signal);
}

/** Highest confidence wins, then earliest registration, across URL and headers. */
export function detectFromDocument(url: string, headers: Headers, html: string): DetectionResult {
  const hostname = hostnameFromUrl(url);
  const platforms = registeredPlatforms();
  for (const platform of platforms) {
    const hostMatch = hostname !== null && matchesHost(platform, hostname);
    const signals = headerSignals(platform, headers);
    if (hostMatch) signals.unshift(`URL contains ${platform.id} domain`);
    if (signals.length) return { platform: platform.id, confidence: 'high', signals };
  }
  for (const platform of platforms) {
    const signals = (platform.detection?.sourceSignals ?? []).filter(sig => {
      sig.pattern.lastIndex = 0;
      return sig.pattern.test(html);
    }).map(sig => sig.signal);
    if (signals.length) return { platform: platform.id, confidence: 'medium', signals };
  }
  return { platform: 'unknown', confidence: 'low', signals: [] };
}

/** Match HTTP headers and source evidence already obtained by a caller. */
export function detectFromResponse(headers: Headers, html: string): DetectionResult {
  return detectFromDocument('', headers, html);
}

async function matchPathProbes(url: string): Promise<DetectionResult> {
  for (const platform of registeredPlatforms()) {
    for (const probe of platform.detection?.pathProbes ?? []) {
      try {
        const target = new URL(probe.path, url);
        if (target.origin !== new URL(url).origin) continue;
        const response = await fetch(target.toString(), {
          method: 'HEAD',
          headers: { 'User-Agent': SOURCE_USER_AGENT },
          signal: AbortSignal.timeout(10000),
          redirect: 'manual',
        });
        if (!probe.expectedStatus.includes(response.status)) continue;
        if (probe.locationContains && !(response.headers.get('location') || '').includes(probe.locationContains)) continue;
        return { platform: platform.id, confidence: 'high', signals: [probe.signal] };
      } catch {
        // Probe fetch failed — try the next signal.
      }
    }
  }
  return { platform: 'unknown', confidence: 'low', signals: [] };
}

async function detectDocument(url: string, headers: Headers, html: string): Promise<DetectionResult> {
  const result = detectFromDocument(url, headers, html);
  return result.platform === 'unknown' ? matchPathProbes(url) : result;
}

export async function detectFromHttp(url: string): Promise<DetectionResult> {
  const normalized = url.includes('://') ? url : `https://${url}`;
  try {
    const response = await fetch(normalized, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
      headers: { 'User-Agent': SOURCE_USER_AGENT },
    });
    let html = '';
    try { html = await response.text(); } catch { /* source matching is best-effort */ }
    return await detectDocument(normalized, response.headers, html);
  } catch {
    return { platform: 'unknown', confidence: 'low', signals: [] };
  }
}

/** Supplied entry evidence avoids fetching the entry document again. */
export async function detect(url: string, entry?: { headers: Headers; html: string }): Promise<FullDetectionResult> {
  if (entry) return { url, ...await detectDocument(url, entry.headers, entry.html) };
  const host = detectFromUrl(url);
  // Without a response, the hostname is already high-confidence evidence.
  if (host) return { url, platform: host, confidence: 'high', signals: [`URL contains ${host} domain`] };
  return { url, ...await detectFromHttp(url) };
}

export type { PlatformHttpSignal, PlatformPathProbe, PlatformSourceSignal };
