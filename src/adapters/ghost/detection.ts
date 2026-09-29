// src/adapters/ghost/detection.ts — Ghost's own detection signals.
//
// Observed on 14 live Ghost sites (2026-09): 12 on Ghost(Pro), one
// self-hosted (citationneeded.news) and ghost.org/blog behind a proxy.
//   - Every one renders `<meta name="generator" content="Ghost 6.x">` from the
//     theme's required {{ghost_head}} helper.
//   - {{ghost_head}} also loads Portal (members) and Sodo Search from
//     cdn.jsdelivr.net/ghost/…, tagged with `data-ghost` attributes.
//   - Ghost(Pro) responses carry a `ghost-fastly` header; self-hosted don't.
//   - Ghost(Pro) custom domains redirect /ghost/ (admin) to <site>.ghost.io.
// `/content/images/` and Koenig `kg-*` classes are deliberately NOT signals:
// headless front ends (e.g. a Next.js site reading Ghost's Content API) emit
// them too, but the page isn't Ghost-rendered.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [ /^https?:\/\/[^/]+\.ghost\.io(?:[/:?#]|$)/i ],
	httpSignals: [
		{ header: 'ghost-fastly', signal: 'ghost-fastly header (Ghost(Pro) CDN)' },
	],
	sourceSignals: [
		{ pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Ghost\b/i, signal: 'Ghost generator meta in page source' },
		{ pattern: /cdn\.jsdelivr\.net\/(?:npm\/@tryghost|ghost)\/[\w-]+/i, signal: 'Ghost Portal / Search assets in page source' },
	],
	pathProbes: [
		{
			path: '/ghost/',
			expectedStatus: [ 301, 302 ],
			locationContains: '.ghost.io/ghost',
			signal: '/ghost/ redirects to the Ghost(Pro) admin',
		},
	],
};
