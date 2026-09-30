// src/adapters/substack/detection.ts — Substack's own detection signals.
//
// Observed on 13 live publications (2026-09), on both *.substack.com and
// custom domains: every response carries `x-served-by: Substack` and
// `x-cluster: substack` (plus `x-sub: <publication handle>`), and pages load
// Substack's app bundle from substackcdn.com/bundle/. `substackcdn.com` alone
// is deliberately not a signal: other sites hotlink Substack images and embed
// Substack post cards.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [ /^https?:\/\/[^/]+\.substack\.com(?:[/:?#]|$)/i ],
	httpSignals: [
		{ header: 'x-served-by', value: 'substack', signal: 'X-Served-By: Substack header' },
		{ header: 'x-cluster', value: 'substack', signal: 'X-Cluster: substack header' },
	],
	sourceSignals: [
		{ pattern: /<script[^>]+src=["']https:\/\/substackcdn\.com\/bundle\//i, signal: 'Substack app bundle in page source' },
	],
};
