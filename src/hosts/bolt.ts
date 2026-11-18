// src/hosts/bolt.ts
//
// Bolt (bolt.new) publishes sites to `*.bolt.host`, serving them through
// Netlify, and injects a "Made in Bolt" badge with its own `badge.js`. The
// script appends a bare `<div>` to `<body>` — no id or class, only inline
// fixed positioning — and renders the badge inside that div's open shadow
// root. The host element has no stable selector, so the rule identifies it by
// the badge's own dismiss control inside the shadow root.
import type { Host } from '../platform/host.js';

export const boltHost: Host = {
	id: 'bolt',
	detection: {
		httpSignals: [
			{ header: 'x-powered-by', value: 'Bolt.new', signal: 'Bolt.new x-powered-by response header' },
		],
		sourceSignals: [
			{
				pattern: /<script\b[^>]*\bsrc=["']https:\/\/bolt\.new\/badge\.js(?:[?"'])/i,
				signal: 'Bolt badge script served from bolt.new/badge.js',
			},
		],
	},
	residue: [
		{
			selector: 'body > div',
			shadowSelector: 'button.dismiss[aria-label*="Made in Bolt"]',
			evidence: 'Bolt "Made in Bolt" badge, rendered in a shadow root by bolt.new/badge.js',
		},
	],
};
