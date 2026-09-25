// src/adapters/squarespace/detection.ts — Squarespace's own detection signals.
import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [ /squarespace\.com/i ],
	httpSignals: [
		{ header: 'server', value: 'squarespace', signal: 'Server: Squarespace header' },
		{ header: 'x-servedby', value: 'squarespace', signal: 'X-ServedBy: squarespace header' },
	],
	// Any one source signal decides the platform, so each must be something only
	// a Squarespace-rendered page carries. Sites behind a CDN or proxy answer
	// with its headers, leaving these as the only evidence. Squarespace-hosted
	// media (images.squarespace-cdn.com, static1.squarespace.com/static/…) is
	// deliberately not a signal: any page can embed it.
	sourceSignals: [
		{
			pattern: /static\.squarespace\.com/i,
			signal: 'static.squarespace.com in page source',
		},
		{
			pattern: /\bSQUARESPACE_CONTEXT\b/,
			signal: 'SQUARESPACE_CONTEXT bootstrap in page source',
		},
		{
			pattern: /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/(?:static\d*|assets)\.squarespace\.com\//i,
			signal: 'Squarespace runtime script in page source',
		},
	],
};
