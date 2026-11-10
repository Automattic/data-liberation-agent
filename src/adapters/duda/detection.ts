// src/adapters/duda/detection.ts — Duda's own detection signals.
//
// Every Duda-rendered page mounts inside `<div id="dmRoot">` and loads Duda's
// runtime from the site's own `/_dm/s/rt/` path (observed on
// www.uptownbyarbor.com, 2026-11; the runtime's `d-js-runtime-*` bundle and
// `d-css-runtime-*` sheets). Duda's image CDN (`*.cdn-website.com`) is
// deliberately NOT a signal: other sites hotlink those images.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	sourceSignals: [
		{ pattern: /<div\b[^>]*\bid=["']dmRoot["']/i, signal: 'Duda dmRoot container in page source' },
		{ pattern: /["'(][^"'()]*\/_dm\/s\/rt\/[^"'()]*\bd-(?:js|css)-runtime/i, signal: 'Duda runtime assets in page source' },
	],
};
