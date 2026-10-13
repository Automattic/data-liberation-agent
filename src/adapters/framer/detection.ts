// src/adapters/framer/detection.ts — Framer's own detection signals.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [ /\.framer\.(?:website|app|ai)(?:[/:?#]|$)/i ],
	httpSignals: [
		{ header: 'server', value: 'framer', signal: 'Server: Framer header' },
		{ header: 'framer-site-id', signal: 'framer-site-id header (Framer hosting)' },
	],
	sourceSignals: [
		{ pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Framer\b/i, signal: 'Framer generator meta tag in page source' },
		{ pattern: /id=["']__framer-badge-container["']/i, signal: '#__framer-badge-container in page source' },
	],
};
