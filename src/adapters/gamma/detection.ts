// src/adapters/gamma/detection.ts — Gamma's own detection signals.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [ /\.gamma\.site(?:[/:?#]|$)/i ],
	httpSignals: [
		{ header: 'server', value: 'gamma', signal: 'Server: gamma header' },
		{ header: 'x-super-powered-by', value: 'gamma', signal: 'X-Super-Powered-By: gamma header' },
	],
	sourceSignals: [
		{
			pattern: /<(?:script|link)\b[^>]*\s(?:src|href)\s*=\s*["']https:\/\/assets\.gammahosted\.com\/[^"']*\/_next\//i,
			signal: 'Gamma-hosted Next.js assets in page source',
		},
		{
			pattern: /\sdata-export-link\s*=\s*["']https:\/\/gamma\.app\/docs\//i,
			signal: 'Gamma document export link in page source',
		},
	],
};
