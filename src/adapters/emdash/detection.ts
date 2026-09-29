// src/adapters/emdash/detection.ts — EmDash CMS's own detection signals.
//
// EmDash (Cloudflare's Astro-based CMS) ships no generator meta and themes
// control all markup, so no single signal covers every site:
//   - Server-Timing carries EmDash runtime phases (`rt.seedcheck` = "Auto-seed
//     gate") on uncached responses. Edge-cached pages may drop the header.
//   - Media is served from `/_emdash/api/media/file/<ULID>.<ext>`, often wrapped
//     by Astro's `/_image?href=` proxy (URL-encoded) — themes can't avoid it.
//   - Built-in components emit `emdash-*` classes / custom elements
//     (`emdash-image-media`, `emdash-table`, `<emdash-live-search>`).
//   - `/_emdash/admin` redirects to `/_emdash/admin/login` on every
//     self-hosted install. Sites behind Cloudflare Access redirect to
//     `*.cloudflareaccess.com` instead and are caught by the media signal.
// The bare word "emdash" is deliberately NOT a signal: agencies and blogs
// write about EmDash in body copy.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	httpSignals: [
		{ header: 'server-timing', value: 'rt.seedcheck', signal: 'Server-Timing rt.seedcheck (EmDash runtime)' },
	],
	sourceSignals: [
		{ pattern: /(?:\/|%2F)_emdash(?:\/|%2F)api(?:\/|%2F)media(?:\/|%2F)file(?:\/|%2F)/i, signal: '/_emdash/api/media/file/ media URL in page source' },
		{ pattern: /<emdash-[a-z-]+[\s>]|class="[^"]*\bemdash-[a-z]/i, signal: 'emdash-* component markup in page source' },
	],
	pathProbes: [
		{
			path: '/_emdash/admin',
			expectedStatus: [ 302 ],
			locationContains: '/_emdash/admin/login',
			signal: '/_emdash/admin redirects to /_emdash/admin/login',
		},
	],
};
